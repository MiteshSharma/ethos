import type {
  ContentStore,
  ContextEventKind,
  ContextLog,
  MemorySnapshot,
  PersonalityConfig,
  ResolvedContextEntry,
} from '@ethosagent/types';
import type { LoopDeps } from '../turn-context';

// ---------------------------------------------------------------------------
// Model-visible ⟺ logged — emit-on-change write path (Phase B).
//
// Called from context-assembly.ts after the system prompt is finalized. A
// complete no-op unless BOTH `deps.contentStore` and `deps.contextLog` are
// wired — this is what keeps every turn byte-identical for sessions/tests
// that don't opt in. Errors from `contentStore`/`contextLog` are left to
// propagate: a misconfigured store failing loudly is better than a supposedly
// -recorded invariant silently going unrecorded (D7's budget guarantee
// depends on the write path actually running).
//
// v1 kinds and tiers (D8, plan §3):
//   personality  — Tier A (replay): six-path fingerprint, one blob per file.
//   memory       — Tier B (replay): the raw MEMORY.md/USER.md snapshot.
//   team_index   — Tier B (replay): the team-memory-index injector's output
//                  (names only, per D10).
//   file_window  — Tier C (detect): hash only, never stored as a blob.
// ---------------------------------------------------------------------------

/** A string distinct from any real file content (even an empty file), so a
 *  missing personality file hashes differently than a present-but-empty one.
 *  Exported for `context-drift.ts`, which hashes the same "absent" sentinel
 *  for its own comparison (Phase D). */
export const MISSING = 'missing';

/**
 * What `emitContextEvents` learned this turn that the drift check (Phase D,
 * `context-drift.ts`) needs but has no other way to reach — never persisted.
 */
export interface ContextEmitOutcome {
  /**
   * Tier A source exactly as read for the fingerprint this turn (the same
   * `sources.soulSrc` used to compute `soulSha`, untrimmed). `undefined` when
   * Tier A did not run at all this turn (no `getContentFingerprint` on this
   * registry, or the personality id didn't resolve to a fingerprint);
   * `null` when it ran and found no SOUL.md file.
   */
  personalitySoulSrc?: string | null;
}

export interface ContextEmitParams {
  sessionId: string;
  /** The user-message id persisted this turn (D3) — every event this turn
   *  is tagged with it. */
  messageId: string;
  personality: PersonalityConfig;
  /** Post-sanitize memory snapshot, as returned by `MemoryProvider.prefetch`
   *  (before it is rendered into the prompt). `null`/empty → memory kind is
   *  skipped this turn. */
  memSnapshot: MemorySnapshot | null;
  /** The `file-context` injector's rendered content this turn, if it fired. */
  fileWindowContent: string | undefined;
  /** The `team-memory-index:*` injector's rendered content this turn, if it fired. */
  teamIndexContent: string | undefined;
  /** The user message's own persisted timestamp (`userMsg.timestamp.getTime()`),
   *  NOT `Date.now()` at emit time — `resolveAt` filters events by
   *  `timestamp <= <this message's own timestamp>`, so an event tagged with a
   *  later wall-clock time than the message it belongs to can never resolve
   *  against that same message. */
  timestamp: number;
}

export async function emitContextEvents(
  deps: LoopDeps,
  params: ContextEmitParams,
): Promise<ContextEmitOutcome> {
  const { contentStore, contextLog } = deps;
  const outcome: ContextEmitOutcome = {};
  if (!contentStore || !contextLog) return outcome;

  const prior = await contextLog.resolveAt(params.sessionId, params.messageId);
  const timestamp = params.timestamp;

  // Tier A — personality. Only file-backed registries (FilePersonalityRegistry)
  // implement `getContentFingerprint`; others (DefaultPersonalityRegistry, test
  // doubles) have no directory to fingerprint, so the kind is skipped rather
  // than treated as an error.
  if (deps.personalities.getContentFingerprint) {
    const sources = await deps.personalities.getContentFingerprint(params.personality.id);
    if (sources) {
      outcome.personalitySoulSrc = sources.soulSrc;
      await emitPersonality(contentStore, contextLog, prior.personality, {
        sessionId: params.sessionId,
        messageId: params.messageId,
        personalityId: params.personality.id,
        soulSrc: sources.soulSrc,
        configSrc: sources.configSrc,
        toolsetSrc: sources.toolsetSrc,
        mcpSrc: sources.mcpSrc,
        toolsSrc: sources.toolsSrc,
        skillsDirPresent: sources.skillsDirPresent,
        timestamp,
      });
    }
  }

  // Tier B — memory snapshot. Canonicalized (sorted by key) so re-ordering
  // the same entries never looks like a change.
  if (params.memSnapshot && params.memSnapshot.entries.length > 0) {
    const canonical = JSON.stringify(
      [...params.memSnapshot.entries]
        .sort((a, b) => a.key.localeCompare(b.key))
        .map((e) => ({ key: e.key, content: e.content })),
    );
    await emitReplayKind(contentStore, contextLog, prior.memory, {
      sessionId: params.sessionId,
      messageId: params.messageId,
      kind: 'memory',
      content: canonical,
      timestamp,
    });
  }

  // Tier C — progressive file-context window. Hash only, no blob (D8/§3).
  if (params.fileWindowContent !== undefined) {
    await emitDetectKind(contentStore, contextLog, prior.file_window, {
      sessionId: params.sessionId,
      messageId: params.messageId,
      kind: 'file_window',
      content: params.fileWindowContent,
      timestamp,
    });
  }

  // Tier B — team topic index (names only, D10).
  if (params.teamIndexContent !== undefined) {
    await emitReplayKind(contentStore, contextLog, prior.team_index, {
      sessionId: params.sessionId,
      messageId: params.messageId,
      kind: 'team_index',
      content: params.teamIndexContent,
      timestamp,
    });
  }

  return outcome;
}

async function emitPersonality(
  contentStore: ContentStore,
  contextLog: ContextLog,
  prior: ResolvedContextEntry,
  opts: {
    sessionId: string;
    messageId: string;
    personalityId: string;
    soulSrc: string | null;
    configSrc: string | null;
    toolsetSrc: string | null;
    mcpSrc: string | null;
    toolsSrc: string | null;
    skillsDirPresent: boolean;
    timestamp: number;
  },
): Promise<void> {
  const soulContent = opts.soulSrc ?? MISSING;
  const configContent = opts.configSrc ?? MISSING;
  const toolsetContent = opts.toolsetSrc ?? MISSING;
  const mcpContent = opts.mcpSrc ?? MISSING;
  const toolsContent = opts.toolsSrc ?? MISSING;

  const soulSha = contentStore.hash(soulContent);
  const configSha = contentStore.hash(configContent);
  const toolsetSha = contentStore.hash(toolsetContent);
  const mcpSha = contentStore.hash(mcpContent);
  const toolsSha = contentStore.hash(toolsContent);

  const changed =
    prior === 'unknown' ||
    prior.meta.soulSha !== soulSha ||
    prior.meta.configSha !== configSha ||
    prior.meta.toolsetSha !== toolsetSha ||
    prior.meta.mcpSha !== mcpSha ||
    prior.meta.toolsSha !== toolsSha ||
    prior.meta.skillsDirPresent !== opts.skillsDirPresent;
  if (!changed) return;

  // No prior event for this session → the personality's first observation
  // (`via: 'initial'`); a prior event that differs → a same-session file
  // change (`via: 'hot-reload'`). Never `via: 'command'` — `/personality`
  // starts a new session (D4), which is the `'unknown'` branch here too.
  const via = prior === 'unknown' ? 'initial' : 'hot-reload';

  await Promise.all([
    contentStore.put(soulContent),
    contentStore.put(configContent),
    contentStore.put(toolsetContent),
    contentStore.put(mcpContent),
    contentStore.put(toolsContent),
  ]);

  await contextLog.append({
    sessionId: opts.sessionId,
    messageId: opts.messageId,
    kind: 'personality',
    mode: 'replay',
    // soulSha is the designated primary reference hash; the other four live
    // in `meta` alongside it so a reader can tell which file moved.
    hash: soulSha,
    meta: {
      id: opts.personalityId,
      soulSha,
      toolsetSha,
      configSha,
      mcpSha,
      toolsSha,
      skillsDirPresent: opts.skillsDirPresent,
      via,
    },
    timestamp: opts.timestamp,
  });
}

async function emitReplayKind(
  contentStore: ContentStore,
  contextLog: ContextLog,
  prior: ResolvedContextEntry,
  opts: {
    sessionId: string;
    messageId: string;
    kind: ContextEventKind;
    content: string;
    timestamp: number;
  },
): Promise<void> {
  const hash = contentStore.hash(opts.content);
  if (prior !== 'unknown' && prior.hash === hash) return;
  await contentStore.put(opts.content);
  await contextLog.append({
    sessionId: opts.sessionId,
    messageId: opts.messageId,
    kind: opts.kind,
    mode: 'replay',
    hash,
    meta: {},
    timestamp: opts.timestamp,
  });
}

async function emitDetectKind(
  contentStore: ContentStore,
  contextLog: ContextLog,
  prior: ResolvedContextEntry,
  opts: {
    sessionId: string;
    messageId: string;
    kind: ContextEventKind;
    content: string;
    timestamp: number;
  },
): Promise<void> {
  const hash = contentStore.hash(opts.content);
  if (prior !== 'unknown' && prior.hash === hash) return;
  await contextLog.append({
    sessionId: opts.sessionId,
    messageId: opts.messageId,
    kind: opts.kind,
    mode: 'detect',
    hash,
    meta: {},
    timestamp: opts.timestamp,
  });
}
