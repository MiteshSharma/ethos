import { join } from 'node:path';
import { FsContentStore } from '@ethosagent/cas-fs';
import { ethosDir } from '@ethosagent/config';
import { SQLiteContextLog, SQLiteSessionStore } from '@ethosagent/session-sqlite';
import type { ContentStore, ContextEventKind, ContextLog } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import { writeJson } from '../json-output';
import { getStorage } from '../wiring';
import { attributeCacheMisses, type CacheMissAttributionRow } from './cache-attribution';

// ---------------------------------------------------------------------------
// ethos why <sessionId> [messageId] [--json] [--cache]
//
// Phase E consumer of `ContextLog.resolveAt` (plan/phases/model-visible-logged.md,
// §5 Projection). Reconstructs which content hash was in effect for each v1
// context kind at a given point in a session, and — for Tier A/B (`mode:
// 'replay'`) kinds — fetches the actual blob from the CAS to prove
// reconstruction, not just metadata.
// ---------------------------------------------------------------------------

const KIND_ORDER: readonly ContextEventKind[] = [
  'personality',
  'memory',
  'file_window',
  'team_index',
];

const PREVIEW_CHARS = 200;

export interface WhyBlobInfo {
  found: boolean;
  byteLength?: number;
  preview?: string;
}

export type WhyKindResult =
  | { status: 'unknown' }
  | {
      status: 'replay';
      hash: string;
      mode: 'replay';
      meta: Record<string, unknown>;
      timestamp: number;
      blob: WhyBlobInfo;
    }
  | {
      status: 'detect';
      hash: string;
      mode: 'detect';
      meta: Record<string, unknown>;
      timestamp: number;
    };

export interface WhyResult {
  sessionId: string;
  messageId: string;
  kinds: Record<ContextEventKind, WhyKindResult>;
}

/**
 * Resolve context at `messageId` and format it into a plain, JSON-serializable
 * result — extracted from `runWhy` for testability (same "extracted for
 * testability" pattern `gcCas` uses in `cas.ts`).
 *
 * For a Tier C (`mode: 'detect'`) entry, `contentStore.get()` is deliberately
 * NOT called here — the mode already tells the caller there is nothing to
 * fetch, and a real call would just be a wasted round-trip that always
 * returns null by construction.
 */
export async function computeWhy(
  sessionId: string,
  messageId: string,
  contextLog: ContextLog,
  contentStore: ContentStore,
): Promise<WhyResult> {
  const resolved = await contextLog.resolveAt(sessionId, messageId);
  const kinds = {} as Record<ContextEventKind, WhyKindResult>;

  for (const kind of KIND_ORDER) {
    const entry = resolved[kind];

    if (entry === 'unknown') {
      kinds[kind] = { status: 'unknown' };
      continue;
    }

    if (entry.mode === 'detect') {
      kinds[kind] = {
        status: 'detect',
        hash: entry.hash,
        mode: 'detect',
        meta: entry.meta,
        timestamp: entry.timestamp,
      };
      continue;
    }

    const blobContent = await contentStore.get(entry.hash);
    const blob: WhyBlobInfo =
      blobContent === null
        ? { found: false }
        : {
            found: true,
            byteLength: Buffer.byteLength(blobContent, 'utf-8'),
            preview:
              blobContent.length > PREVIEW_CHARS
                ? `${blobContent.slice(0, PREVIEW_CHARS)}…`
                : blobContent,
          };

    kinds[kind] = {
      status: 'replay',
      hash: entry.hash,
      mode: 'replay',
      meta: entry.meta,
      timestamp: entry.timestamp,
      blob,
    };
  }

  return { sessionId, messageId, kinds };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  sessionId?: string;
  messageId?: string;
  json: boolean;
  cache: boolean;
} {
  const positional = argv.filter((a) => !a.startsWith('--'));
  return {
    sessionId: positional[0],
    messageId: positional[1],
    json: argv.includes('--json'),
    cache: argv.includes('--cache'),
  };
}

function renderKind(
  kind: ContextEventKind,
  entry: WhyKindResult,
  dim: (s: string) => string,
): string {
  const lines: string[] = [`${kind}:`];

  if (entry.status === 'unknown') {
    lines.push('  unknown (no context event recorded for this session)');
    return `${lines.join('\n')}\n`;
  }

  lines.push(`  hash: ${entry.hash}`);
  lines.push(`  mode: ${entry.mode}`);
  lines.push(`  meta: ${JSON.stringify(entry.meta)}`);
  lines.push(`  timestamp: ${new Date(entry.timestamp).toISOString()}`);

  if (entry.status === 'detect') {
    lines.push(
      `  ${dim('Tier C (detect-only) — content is not stored for this section; the hash proves whether the window changed, nothing more.')}`,
    );
    return `${lines.join('\n')}\n`;
  }

  if (entry.blob.found) {
    lines.push(`  blob: ${entry.blob.byteLength} bytes`);
    lines.push(`  preview: ${entry.blob.preview}`);
  } else {
    lines.push(`  blob: NOT FOUND (collected or never stored)`);
  }
  return `${lines.join('\n')}\n`;
}

function renderWhy(result: WhyResult): void {
  const isTTY = process.stdout.isTTY;
  const bold = (s: string) => (isTTY ? `\x1b[1m${s}\x1b[0m` : s);
  const dim = (s: string) => (isTTY ? `\x1b[2m${s}\x1b[0m` : s);

  process.stdout.write(
    `\n${bold('Session:')} ${result.sessionId}\n${bold('Message:')} ${result.messageId}\n\n`,
  );
  for (const kind of KIND_ORDER) {
    process.stdout.write(`${renderKind(kind, result.kinds[kind], dim)}\n`);
  }
}

function renderCacheReport(rows: CacheMissAttributionRow[]): void {
  const misses = rows.filter((r) => r.isMiss);
  process.stdout.write(
    `Cache-miss attribution (${misses.length} miss${misses.length === 1 ? '' : 'es'}):\n\n`,
  );
  for (const row of misses) {
    const label = new Date(row.timestamp).toISOString();
    const attribution =
      row.changedKinds.length > 0
        ? row.changedKinds.join(', ')
        : "no tracked context kind changed — miss not attributable to a v1 kind (D8 doesn't track tool schemas, skills bodies, or the injection prelude)";
    process.stdout.write(
      `  ${label}  cache_creation=${row.cacheCreationTokens}  changed: ${attribution}\n`,
    );
  }
  process.stdout.write('\n');
}

export async function runWhy(argv: string[]): Promise<void> {
  const { sessionId, messageId: messageIdArg, json, cache } = parseArgs(argv);

  if (!sessionId) {
    process.stderr.write('Usage: ethos why <sessionId> [messageId] [--json] [--cache]\n');
    process.exit(1);
  }

  const dbPath = join(ethosDir(), 'sessions.db');
  const sessionStore = new SQLiteSessionStore(dbPath);
  const contextLog = new SQLiteContextLog(dbPath);
  const contentStore = new FsContentStore(join(ethosDir(), 'cas'), getStorage());

  try {
    const session = await sessionStore.getSession(sessionId);
    if (!session) {
      throw new EthosError({
        code: 'SESSION_NOT_FOUND',
        cause: `Session not found: ${sessionId}`,
        action: 'Check the session ID with `ethos sessions list`.',
      });
    }

    const messages = await sessionStore.getMessages(sessionId);
    let messageId = messageIdArg;
    if (!messageId) {
      const latest = messages.at(-1);
      if (!latest) {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `Session ${sessionId} has no messages to resolve context against.`,
          action: 'Pass an explicit messageId, or use a session with at least one message.',
        });
      }
      messageId = latest.id;
    }

    const result = await computeWhy(sessionId, messageId, contextLog, contentStore);
    const cacheReport = cache
      ? await attributeCacheMisses(sessionId, messages, contextLog)
      : undefined;

    if (json) {
      writeJson({ ...result, ...(cacheReport ? { cacheMisses: cacheReport } : {}) });
      return;
    }

    renderWhy(result);
    if (cacheReport) renderCacheReport(cacheReport);
  } finally {
    sessionStore.close();
    contextLog.close();
  }
}
