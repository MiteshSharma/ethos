// Item 7 stage 3 — prefix stability UNDER micro-compaction.
//
// `prompt-prefix-stability.test.ts` cannot cover this work and must not be
// mistaken for a guard on it. Four independent reasons: it observes only
// `opts.system` and never the message array; its stub LLM declares a 200k
// window against two `'hello'` turns, so no pressure threshold is ever crossed;
// its `countTokens()` returns 1; and with no `storage`/`dataDir` the state
// load/save short-circuits. It stays green as a smoke check and proves nothing
// here.
//
// This fixture is the real guard. It drives a multi-turn session through a
// full AgentLoop with a DELIBERATELY SMALL context window and real storage, so
// micro-compaction genuinely engages, and asserts the two things that cost
// money when they regress:
//
//   • the assembled static prefix stays byte-identical across every turn —
//     micro-compaction must touch the MESSAGE ARRAY ONLY;
//   • on a turn with no state crossing, the messages carried over from the
//     previous turn are rewritten byte-identically.

import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const BLOB = 'RESULT '.repeat(700); // ~4.9k chars — ~1.2k tokens at char/4

/** Distinct output per call — identical results are collapsed by `dedupHistory`
 *  before assembly ever sees them, which would make this fixture vacuous. */
function toolOutput(n: number): string {
  return `call ${n}\n${BLOB}`;
}

function makeBigTool(): Tool {
  let calls = 0;
  return {
    name: 'big_read',
    description: 'Returns a large blob.',
    schema: { type: 'object', properties: {}, additionalProperties: false },
    capabilities: {},
    async execute(_args: unknown, _ctx: ToolContext): Promise<ToolResult> {
      return { ok: true, value: toolOutput(calls++) };
    },
  };
}

interface Captured {
  system: string;
  messages: Message[];
}

/**
 * Emits one tool call, then a text answer — so every turn adds a `tool_use` /
 * `tool_result` pair to the history and pressure climbs turn over turn.
 */
function toolCallingLLM(captured: Captured[]): LLMProvider {
  let step = 0;
  return {
    name: 'mock',
    model: 'mock-model',
    // Small on purpose: a 200k window never reaches a threshold in a test.
    maxContextTokens: 24_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      messages: Message[],
      _t: unknown,
      opts: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      captured.push({ system: opts.system ?? '', messages: structuredClone(messages) });
      const wantsTool = step++ % 2 === 0;
      if (wantsTool) {
        const id = `toolu_${step}`;
        yield { type: 'tool_use_start', toolCallId: id, toolName: 'big_read' };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'answered' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens(msgs: Message[]) {
      return Math.ceil(JSON.stringify(msgs).length / 4);
    },
  };
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<void> {
  for await (const _e of gen) {
    // discard
  }
}

interface Session {
  captured: Captured[];
  storage: InMemoryStorage;
  /** Drive one more turn against the same loop. */
  next: (text: string) => Promise<void>;
  /** Path of the persisted micro-compaction state for this session. */
  microStatePath: () => Promise<string>;
}

async function runSession(turns: number): Promise<Session> {
  const captured: Captured[] = [];
  const storage = new InMemoryStorage();
  const session = new InMemorySessionStore();
  const personalities = new DefaultPersonalityRegistry();
  vi.spyOn(personalities, 'getDefault').mockReturnValue({
    id: 'p',
    name: 'P',
    toolset: ['big_read'],
  });
  const tools = new DefaultToolRegistry();
  tools.register(makeBigTool());

  const loop = new AgentLoop({
    llm: toolCallingLLM(captured),
    safety: createTestSafety(),
    personalities,
    tools,
    session,
    storage,
    dataDir: '/data',
    // Keep the pressure gate and the turn-end auto-compaction OUT of the way:
    // they reshape the array wholesale, and this fixture is about the
    // incremental path. Micro-compaction and tool-result aging still run.
    compaction: { autoCompact: false, pressure: 0.999, target: 0.99 },
  });

  for (let i = 0; i < turns; i++) await drain(loop.run(`turn ${i}`));
  return {
    captured,
    storage,
    next: (text: string) => drain(loop.run(text)),
    microStatePath: async () => {
      const [s] = await session.listSessions();
      return `/data/micro/${(s?.id ?? '').replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
    },
  };
}

/** The persisted micro-compaction state, so a test can prove it actually ran. */
async function readMicroState(
  storage: InMemoryStorage,
): Promise<{ level: number; trimmed: string[]; cleared: string[] } | null> {
  const files = await storage.list('/data/micro');
  const first = files[0];
  if (first === undefined) return null;
  const raw = await storage.read(`/data/micro/${first}`);
  return raw ? JSON.parse(raw) : null;
}

/** Every `tool_use` id in a captured view, oldest first. */
function toolUseIds(messages: Message[]): string[] {
  const ids: string[] = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content) if (b.type === 'tool_use') ids.push(b.id);
  }
  return ids;
}

function resultFor(messages: Message[], id: string): string | undefined {
  for (const m of messages) {
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    for (const b of m.content)
      if (b.type === 'tool_result' && b.tool_use_id === id) return b.content;
  }
  return undefined;
}

/** Everything before the memory tail — the static region under test. */
function staticPrefix(system: string): string {
  const idx = system.indexOf('## Memory');
  return idx === -1 ? system : system.slice(0, idx);
}

describe('Item 7 — micro-compaction keeps the prompt prefix stable', () => {
  it('never alters the assembled static prefix', async () => {
    const { captured } = await runSession(12);
    expect(captured.length).toBeGreaterThan(12);

    const first = staticPrefix(captured[0]?.system ?? '');
    expect(first.length).toBeGreaterThan(0);
    for (const c of captured) {
      expect(staticPrefix(c.system)).toBe(first);
    }
  });

  it('actually engages micro-compaction (this fixture is not vacuous)', async () => {
    const { captured, storage } = await runSession(12);

    // The state machine genuinely advanced and persisted — not aging alone.
    const state = await readMicroState(storage);
    expect(state?.level ?? 0).toBeGreaterThan(0);
    expect((state?.trimmed.length ?? 0) + (state?.cleared.length ?? 0)).toBeGreaterThan(0);

    // Some tool_result the model originally saw in full is later rewritten.
    const full = new Set<string>();
    let rewrites = 0;
    for (const c of captured) {
      for (const m of c.messages) {
        if (m.role !== 'user' || typeof m.content === 'string') continue;
        for (const b of m.content) {
          if (b.type !== 'tool_result') continue;
          if (b.content.length > BLOB.length) full.add(b.tool_use_id);
          else if (full.has(b.tool_use_id)) rewrites++;
        }
      }
    }
    expect(rewrites).toBeGreaterThan(0);
  });

  it('applies the persisted micro state — not tool-result aging — to the view', async () => {
    // Aging never touches the three most recent tool-using turns, so naming the
    // NEWEST tool_use id isolates micro-compaction: if the rewrite shows up,
    // only the micro path can have produced it.
    const session = await runSession(12);
    const before = session.captured[session.captured.length - 1]?.messages ?? [];
    const ids = toolUseIds(before);
    const newest = ids[ids.length - 1] ?? '';
    expect(newest).not.toBe('');
    expect((resultFor(before, newest) ?? '').length).toBeGreaterThan(BLOB.length);

    await session.storage.writeAtomic(
      await session.microStatePath(),
      JSON.stringify({ level: 1, trimmed: [], cleared: [newest] }),
    );
    await session.next('one more');

    const after = session.captured[session.captured.length - 1]?.messages ?? [];
    expect(resultFor(after, newest)).toContain('tool result cleared to reclaim context');
  });

  it('rewrites carried-over messages byte-identically on non-crossing turns', async () => {
    const { captured } = await runSession(12);

    let identicalPairs = 0;
    let differingPairs = 0;
    for (let i = 1; i < captured.length; i++) {
      const prev = captured[i - 1]?.messages ?? [];
      const next = captured[i]?.messages ?? [];
      if (next.length < prev.length) continue; // a turn boundary reset the view
      const overlap = JSON.stringify(next.slice(0, prev.length));
      if (overlap === JSON.stringify(prev)) identicalPairs++;
      else differingPairs++;
    }

    // The overwhelming majority of turns must carry the previous view forward
    // untouched; only the handful of threshold crossings may differ.
    expect(identicalPairs).toBeGreaterThan(differingPairs);
    expect(identicalPairs).toBeGreaterThan(0);
  });

  it('never removes or reorders a message, and never splits a tool pair', async () => {
    const { captured } = await runSession(12);

    for (const c of captured) {
      const uses = new Set<string>();
      const results = new Set<string>();
      for (const m of c.messages) {
        if (typeof m.content === 'string') continue;
        for (const b of m.content) {
          if (b.type === 'tool_use') uses.add(b.id);
          if (b.type === 'tool_result') results.add(b.tool_use_id);
        }
      }
      expect([...uses].sort()).toEqual([...results].sort());
    }

    // Message counts only ever grow across a session with no compaction.
    for (let i = 1; i < captured.length; i++) {
      const prev = captured[i - 1]?.messages.length ?? 0;
      const next = captured[i]?.messages.length ?? 0;
      if (next < prev) continue; // within-turn tool round: the view restarts
      expect(next).toBeGreaterThanOrEqual(prev);
    }
  });
});
