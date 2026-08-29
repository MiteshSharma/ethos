// Model-visible ⟺ logged (plan/phases/model-visible-logged.md, Phase B) —
// acceptance criteria 1-3: the emit-on-change write path holds its budget
// (D7) and gets `via` right (D4).
//
// Drives a real AgentLoop end to end with in-memory `ContentStore`/
// `ContextLog` test doubles (Phase A shipped no shared in-memory
// implementations, so these are local to this file) — the only way to
// exercise the actual call site in context-assembly.ts rather than a unit
// test of `emitContextEvents` in isolation.

import { createHash } from 'node:crypto';
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

// -- Test doubles -----------------------------------------------------------

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

/** Mirrors `SQLiteContextLog`'s last-write-wins query (D3), but resolves the
 *  target message's timestamp via the injected `SessionStore` instead of a
 *  shared SQL table. */
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

class FakePersonalityRegistry extends DefaultPersonalityRegistry {
  soulSrc = 'You are Lean, a focused assistant.';
  configSrc = 'name: Lean';
  toolsetSrc = '';
  mcpSrc: string | null = null;
  toolsSrc: string | null = null;
  skillsDirPresent = false;

  override getDefault() {
    return { id: 'lean', name: 'Lean', toolset: [] };
  }

  async getContentFingerprint(_id: string): Promise<PersonalityFingerprintSources | null> {
    return {
      soulSrc: this.soulSrc,
      configSrc: this.configSrc,
      toolsetSrc: this.toolsetSrc,
      mcpSrc: this.mcpSrc,
      toolsSrc: this.toolsSrc,
      skillsDirPresent: this.skillsDirPresent,
    };
  }
}

function buildLoop() {
  const session = new InMemorySessionStore();
  const contentStore = new InMemoryContentStore();
  const contextLog = new InMemoryContextLog(session);
  const personalities = new FakePersonalityRegistry();
  const loop = new AgentLoop({
    llm: okLLM(),
    personalities,
    safety: createTestSafety(),
    session,
    contentStore,
    contextLog,
  });
  return { loop, contentStore, contextLog, personalities };
}

describe('model-visible ⟺ logged — emit-on-change write path', () => {
  it('writes exactly one personality event across 50 turns of a stable personality, and zero rows on an unchanged turn', async () => {
    const { loop, contextLog } = buildLoop();

    for (let i = 0; i < 50; i++) {
      await collect(loop.run(`turn ${i}`));
    }

    const personalityEvents = contextLog.events.filter((e) => e.kind === 'personality');
    expect(personalityEvents).toHaveLength(1);
    expect(personalityEvents[0]?.meta.via).toBe('initial');

    // No memory/file-window/team-index injectors or memory provider are
    // wired in this fixture, so every other kind stays silent too — the
    // whole 50-turn run produces exactly one context row, not one per turn.
    expect(contextLog.events).toHaveLength(1);
  });

  it('produces via: "initial" for a new session and via: "hot-reload" with a changed soulSha for a same-session SOUL.md edit', async () => {
    const { loop, contextLog, personalities } = buildLoop();

    await collect(loop.run('hello'));
    const firstRun = contextLog.events.filter((e) => e.kind === 'personality');
    expect(firstRun).toHaveLength(1);
    expect(firstRun[0]?.meta.via).toBe('initial');
    const initialSoulSha = firstRun[0]?.meta.soulSha;

    // Same session, SOUL.md content changes on disk — the next turn should
    // observe it and record a hot-reload with a changed soulSha.
    personalities.soulSrc = 'You are Lean, now with a different identity.';
    await collect(loop.run('hello again'));

    const afterEdit = contextLog.events.filter((e) => e.kind === 'personality');
    expect(afterEdit).toHaveLength(2);
    expect(afterEdit[1]?.meta.via).toBe('hot-reload');
    expect(afterEdit[1]?.meta.soulSha).not.toBe(initialSoulSha);

    // A brand-new session (distinct sessionKey) starts fresh: 'initial' again,
    // never 'command' (D4) — even though the personality id is unchanged.
    await collect(loop.run('hello', { sessionKey: 'other-session' }));
    const newSessionEvents = contextLog.events.filter(
      (e) => e.kind === 'personality' && e.sessionId !== firstRun[0]?.sessionId,
    );
    expect(newSessionEvents).toHaveLength(1);
    expect(newSessionEvents[0]?.meta.via).toBe('initial');
  });

  it('resolveAt finds the personality event written on the SAME turn as the message it is tagged against', async () => {
    const { loop, contextLog } = buildLoop();

    await collect(loop.run('hello'));

    // Find the user message this turn wrote. buildLoop() wires an
    // InMemorySessionStore; recover the session id from the one context
    // event we know was written (personality, 'initial') plus the message.
    const personalityEvent = contextLog.events.find((e) => e.kind === 'personality');
    if (!personalityEvent) throw new Error('expected a personality event to have been written');
    const { sessionId, messageId } = personalityEvent;

    // This is the exact scenario the bug breaks: resolving context state for
    // the SAME message the event was just tagged with, on the SAME turn.
    const resolved = await contextLog.resolveAt(sessionId, messageId);

    if (resolved.personality === 'unknown') {
      throw new Error('expected resolveAt to find the same-turn personality event');
    }
    expect(typeof resolved.personality.hash).toBe('string');
    expect(resolved.personality.hash.length).toBeGreaterThan(0);
  });

  it('is a complete no-op when contentStore/contextLog are not wired', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({
      llm: okLLM(),
      personalities: new FakePersonalityRegistry(),
      safety: createTestSafety(),
      session,
    });
    const events = await collect(loop.run('hello'));
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
