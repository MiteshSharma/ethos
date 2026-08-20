// Model-visible ⟺ logged (plan/phases/model-visible-logged.md, Phase D) —
// the drift invariant (§6). Drives a real AgentLoop turn end to end, the same
// way context-emit.test.ts exercises Phase B, so these tests hit the actual
// call site in context-assembly.ts rather than unit-testing `checkContextDrift`
// in isolation.

import { createHash } from 'node:crypto';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  CompletionOptions,
  ContentStore,
  ContextEvent,
  ContextEventKind,
  ContextLog,
  LLMProvider,
  Message,
  PersonalityFingerprintSources,
  ResolvedContext,
  SessionStore,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../__tests__/helpers/test-safety';
import type { AgentEvent } from '../../../agent-loop';
import { AgentLoop } from '../../../agent-loop';
import { InMemorySessionStore } from '../../../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../../../defaults/noop-personality';
import type { AgentLoopObservability } from '../../../observability/agent-loop-observability';

async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const _e of gen) out.push(_e);
  return out;
}

function okLLM(): LLMProvider {
  return {
    name: 'capture',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      _m: Message[],
      _t: unknown,
      _opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

// -- Test doubles -------------------------------------------------------------

class InMemoryContentStore implements ContentStore {
  readonly blobs = new Map<string, string>();

  async put(content: string): Promise<string> {
    const key = this.hash(content);
    if (!this.blobs.has(key)) this.blobs.set(key, content);
    return key;
  }
  async get(hash: string): Promise<string | null> {
    return this.blobs.get(hash) ?? null;
  }
  async has(hash: string): Promise<boolean> {
    return this.blobs.has(hash);
  }
  hash(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }
}

const KINDS: readonly ContextEventKind[] = ['personality', 'memory', 'file_window', 'team_index'];

/** Mirrors `SQLiteContextLog`'s last-write-wins query (D3). */
class InMemoryContextLog implements ContextLog {
  readonly events: ContextEvent[] = [];

  constructor(private readonly sessionStore: SessionStore) {}

  async append(event: ContextEvent): Promise<void> {
    this.events.push(event);
  }

  async resolveAt(sessionId: string, messageId: string): Promise<ResolvedContext> {
    const messages = await this.sessionStore.getMessages(sessionId);
    const target = messages.find((m) => m.id === messageId);
    if (!target) throw new Error(`message not found: ${messageId}`);
    const targetTs = target.timestamp.getTime();

    const result = {} as ResolvedContext;
    for (const kind of KINDS) {
      const matching = this.events
        .filter((e) => e.sessionId === sessionId && e.kind === kind && e.timestamp <= targetTs)
        .sort((a, b) => b.timestamp - a.timestamp);
      const latest = matching[0];
      result[kind] = latest
        ? { hash: latest.hash, mode: latest.mode, meta: latest.meta, timestamp: latest.timestamp }
        : 'unknown';
    }
    return result;
  }

  async listRefs(): Promise<string[]> {
    return [...new Set(this.events.map((e) => e.hash))];
  }
}

/** A registry whose `getContentFingerprint` answer is independent of what
 *  `soulSrcOnStorage` will be — the exact "two paths, one file" shape
 *  `context-drift.ts` guards against. */
class FingerprintRegistry extends DefaultPersonalityRegistry {
  fingerprintSoulSrc: string | null = 'You are Lean, a focused assistant.';

  override getDefault() {
    return { id: 'lean', name: 'Lean', toolset: [], soulFile: '/personalities/lean/SOUL.md' };
  }

  async getContentFingerprint(_id: string): Promise<PersonalityFingerprintSources | null> {
    return {
      soulSrc: this.fingerprintSoulSrc,
      configSrc: null,
      toolsetSrc: null,
      mcpSrc: null,
      toolsSrc: null,
      skillsDirPresent: false,
    };
  }
}

/** Records every `recordContextDrift` call; every other method is a no-op. */
function makeDriftRecorder(): {
  observability: AgentLoopObservability;
  drifts: Array<{ kind: string; expectedHash: string; actualHash: string }>;
} {
  const drifts: Array<{ kind: string; expectedHash: string; actualHash: string }> = [];
  const observability: AgentLoopObservability = {
    startTurnTrace: () => 'trace-1',
    endTrace: () => {},
    startSpan: () => 'span-1',
    endSpan: () => {},
    recordSafetyBlock: () => {},
    recordCompaction: () => {},
    recordTierEscalation: () => {},
    recordTierOverride: () => {},
    recordContextDrift: (opts) => {
      drifts.push({
        kind: opts.kind,
        expectedHash: opts.expectedHash,
        actualHash: opts.actualHash,
      });
    },
    flush: () => {},
  };
  return { observability, drifts };
}

async function buildStorage(soulMd: string): Promise<InMemoryStorage> {
  const storage = new InMemoryStorage();
  await storage.mkdir('/personalities/lean');
  await storage.write('/personalities/lean/SOUL.md', soulMd);
  return storage;
}

describe('model-visible ⟺ logged — drift invariant (Phase D)', () => {
  it('records context.drift when the fingerprint disagrees with what was actually assembled', async () => {
    const session = new InMemorySessionStore();
    const contentStore = new InMemoryContentStore();
    const contextLog = new InMemoryContextLog(session);
    const personalities = new FingerprintRegistry();
    // The fingerprint claims different content than what's actually on
    // storage at `soulFile` — the divergence this check exists to catch.
    personalities.fingerprintSoulSrc = 'You are Lean, a focused assistant.';
    const storage = await buildStorage('You are SOMETHING ELSE ENTIRELY.');
    const { observability, drifts } = makeDriftRecorder();

    const loop = new AgentLoop({
      llm: okLLM(),
      personalities,
      safety: createTestSafety(),
      session,
      storage,
      contentStore,
      contextLog,
      observability,
    });

    await collect(loop.run('hello'));

    expect(drifts).toHaveLength(1);
    expect(drifts[0]?.kind).toBe('personality');
    expect(drifts[0]?.expectedHash).not.toBe(drifts[0]?.actualHash);
    expect(drifts[0]?.actualHash).toBe(contentStore.hash('You are SOMETHING ELSE ENTIRELY.'));
    expect(drifts[0]?.expectedHash).toBe(contentStore.hash('You are Lean, a focused assistant.'));
  });

  it('does not fire when the fingerprint and the assembled prompt agree, even across a trailing-whitespace difference', async () => {
    const session = new InMemorySessionStore();
    const contentStore = new InMemoryContentStore();
    const contextLog = new InMemoryContextLog(session);
    const personalities = new FingerprintRegistry();
    // Untrimmed source (as Tier A stores it) carries a trailing newline;
    // the assembled prompt text is `identity.trim()`. This must NOT count as
    // drift — the whole point of trimming both sides before hashing.
    personalities.fingerprintSoulSrc = 'You are Lean, a focused assistant.\n';
    const storage = await buildStorage('You are Lean, a focused assistant.\n');
    const { observability, drifts } = makeDriftRecorder();

    const loop = new AgentLoop({
      llm: okLLM(),
      personalities,
      safety: createTestSafety(),
      session,
      storage,
      contentStore,
      contextLog,
      observability,
    });

    await collect(loop.run('hello'));

    expect(drifts).toHaveLength(0);
    // Phase B's own write path is unaffected — still exactly one event.
    expect(contextLog.events.filter((e) => e.kind === 'personality')).toHaveLength(1);
  });

  it('is a no-op when observability has no recordContextDrift (structural, like recordError)', async () => {
    const session = new InMemorySessionStore();
    const contentStore = new InMemoryContentStore();
    const contextLog = new InMemoryContextLog(session);
    const personalities = new FingerprintRegistry();
    personalities.fingerprintSoulSrc = 'expected content';
    const storage = await buildStorage('different content');
    const observability: AgentLoopObservability = {
      startTurnTrace: () => 'trace-1',
      endTrace: () => {},
      startSpan: () => 'span-1',
      endSpan: () => {},
      recordSafetyBlock: () => {},
      recordCompaction: () => {},
      recordTierEscalation: () => {},
      recordTierOverride: () => {},
      flush: () => {},
      // recordContextDrift deliberately absent.
    };

    const loop = new AgentLoop({
      llm: okLLM(),
      personalities,
      safety: createTestSafety(),
      session,
      storage,
      contentStore,
      contextLog,
      observability,
    });

    const events = await collect(loop.run('hello'));
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
