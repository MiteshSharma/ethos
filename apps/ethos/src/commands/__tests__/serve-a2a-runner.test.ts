// T0.2 — `params.skill` threaded into `RunOptions.toolsetNarrow`, fail-closed
// per D2/D8. `createA2aRunner` is the seam apps/ethos wires into `serve.ts`'s
// `A2aTaskRunner`; these tests drive it directly against an in-memory
// `Storage`, so no real server boots.

import { DefaultToolRegistry } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type {
  AgentEvent,
  PersonalityConfig,
  Tool,
  ToolContext,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { A2A_SKILL_TOOLS_UNDECLARED, createA2aRunner } from '../serve-a2a-runner';

const ROOT = '/ethos/personalities/researcher';

async function seedSkill(
  storage: InMemoryStorage,
  name: string,
  requiredToolsLine: string | null,
): Promise<void> {
  await storage.mkdir(`${ROOT}/skills/${name}`);
  const frontmatter = ['---', `name: ${name}`, `description: ${name} skill.`];
  if (requiredToolsLine !== null) frontmatter.push(requiredToolsLine);
  frontmatter.push('ethos:', '  exposeToAgents: true', '---', `Body of ${name}.`);
  await storage.write(`${ROOT}/skills/${name}/SKILL.md`, frontmatter.join('\n'));
}

function personality(overrides: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return {
    id: 'researcher',
    name: 'Researcher',
    toolset: ['read_file', 'write_file', 'web_search'],
    skillsDirs: [`${ROOT}/skills`],
    ...overrides,
  };
}

/** A stub AgentLoop-shaped `run` that records the options it was called with. */
function stubLoop(script: AgentEvent[] = [{ type: 'done', text: 'ok', turnCount: 1 }]) {
  const calls: Array<{ text: string; opts: unknown }> = [];
  const loop = {
    run: async function* (text: string, opts: unknown) {
      calls.push({ text, opts });
      for (const e of script) yield e;
    },
  };
  // biome-ignore lint/suspicious/noExplicitAny: structural stub of AgentLoop.run for the test
  return { loop: loop as any, calls };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/** The `toolsetNarrow` the FIRST recorded `loop.run` call received, if any. */
function narrowFromFirstCall(calls: Array<{ text: string; opts: unknown }>): string[] | undefined {
  const opts = calls[0]?.opts as { toolsetNarrow?: string[] } | undefined;
  return opts?.toolsetNarrow;
}

describe('createA2aRunner — turn-time tool narrowing (T0.2)', () => {
  it('narrows to the SKILL.md-declared required_tools when the skill is found and non-empty', async () => {
    const storage = new InMemoryStorage();
    await seedSkill(storage, 'web-research', 'required_tools: [web_search, read_file]');
    const { loop, calls } = stubLoop();
    const runner = createA2aRunner({
      loop,
      personalities: { get: () => personality() },
      storage,
      reserveOutbound: () => true,
    });

    const events = await collect(runner.run('researcher', 'hi', { skill: 'web-research' }));
    expect(events).toEqual([{ type: 'done', text: 'ok', turnCount: 1 }]);
    expect(calls).toHaveLength(1);
    expect(narrowFromFirstCall(calls)).toEqual(['web_search', 'read_file']);
  });

  it('narrows to an empty toolset for explicit required_tools: [] (legitimate, not a refusal)', async () => {
    const storage = new InMemoryStorage();
    await seedSkill(storage, 'echo-status', 'required_tools: []');
    const { loop, calls } = stubLoop();
    const runner = createA2aRunner({
      loop,
      personalities: { get: () => personality() },
      storage,
      reserveOutbound: () => true,
    });

    const events = await collect(runner.run('researcher', 'hi', { skill: 'echo-status' }));
    expect(events).toEqual([{ type: 'done', text: 'ok', turnCount: 1 }]);
    expect(calls).toHaveLength(1);
    expect(narrowFromFirstCall(calls)).toEqual([]);
  });

  it('refuses the turn when the SKILL.md has no required_tools key at all (fail closed, D2)', async () => {
    const storage = new InMemoryStorage();
    await seedSkill(storage, 'no-tools-declared', null);
    const { loop, calls } = stubLoop();
    const runner = createA2aRunner({
      loop,
      personalities: { get: () => personality() },
      storage,
      reserveOutbound: () => true,
    });

    const events = await collect(runner.run('researcher', 'hi', { skill: 'no-tools-declared' }));
    expect(calls).toHaveLength(0); // the loop is NEVER invoked — no fallback to the full toolset
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.type).toBe('error');
    if (event?.type === 'error') {
      expect(event.code).toBe(A2A_SKILL_TOOLS_UNDECLARED);
      expect(event.error).toMatch(/no-tools-declared/);
    }
  });

  it('refuses the turn when no SKILL.md matches the named skill at all (fail closed, D2)', async () => {
    const storage = new InMemoryStorage();
    // No skill seeded — skillsDirs is empty on disk.
    const { loop, calls } = stubLoop();
    const runner = createA2aRunner({
      loop,
      personalities: { get: () => personality() },
      storage,
      reserveOutbound: () => true,
    });

    const events = await collect(runner.run('researcher', 'hi', { skill: 'ghost-skill' }));
    expect(calls).toHaveLength(0);
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event?.type).toBe('error');
    if (event?.type === 'error') expect(event.code).toBe(A2A_SKILL_TOOLS_UNDECLARED);
  });

  it('does not narrow when no skill is named (defensive default)', async () => {
    const storage = new InMemoryStorage();
    const { loop, calls } = stubLoop();
    const runner = createA2aRunner({
      loop,
      personalities: { get: () => personality() },
      storage,
      reserveOutbound: () => true,
    });

    await collect(runner.run('researcher', 'hi', {}));
    expect(calls).toHaveLength(1);
    expect(narrowFromFirstCall(calls)).toBeUndefined();
  });

  it('produces a turn whose EXECUTED tool set is exactly personality.toolset ∩ required_tools — a tool outside it is rejected on the normal tool-execution path', async () => {
    // Composes T0.2's resolution with the REAL DefaultToolRegistry.executeParallel
    // — the "normal tool-execution path" the plan's acceptance criterion names —
    // rather than re-asserting the generic toolsetNarrow ∩ mechanics, which are
    // already covered at packages/core/.../turn-setup-narrow.test.ts.
    const storage = new InMemoryStorage();
    // personality.toolset has 'web_search' and 'read_file' but NOT 'write_file';
    // the skill declares 'read_file' and 'write_file'. Intersection: ['read_file'].
    await seedSkill(storage, 'reader', 'required_tools: [read_file, write_file]');
    const { loop, calls } = stubLoop();
    const runner = createA2aRunner({
      loop,
      personalities: { get: () => personality({ toolset: ['read_file', 'web_search'] }) },
      storage,
      reserveOutbound: () => true,
    });
    await collect(runner.run('researcher', 'hi', { skill: 'reader' }));
    const toolsetNarrow = narrowFromFirstCall(calls);
    expect(toolsetNarrow).toEqual(['read_file', 'write_file']);

    // Real registry, real executeParallel — the intersection with the
    // personality's own toolset (['read_file', 'web_search']) is computed
    // downstream by setupTurn; here we assert the SAME allowlist behaviour
    // directly against the registry so the rejection is proven on the real path.
    const allowedTools = ['read_file', 'web_search'].filter((t) => toolsetNarrow?.includes(t));
    expect(allowedTools).toEqual(['read_file']);

    const readFile: Tool = {
      name: 'read_file',
      description: 'reads a file',
      schema: { type: 'object' },
      capabilities: {},
      execute: async () => ({ ok: true, value: 'contents' }) satisfies ToolResult,
    };
    const webSearch: Tool = {
      name: 'web_search',
      description: 'searches the web',
      schema: { type: 'object' },
      capabilities: {},
      execute: async () => ({ ok: true, value: 'results' }) satisfies ToolResult,
    };
    const registry = new DefaultToolRegistry();
    registry.register(readFile);
    registry.register(webSearch);

    const ctx: ToolContext = {
      sessionId: 's1',
      sessionKey: 'a2a:researcher:peer',
      platform: 'a2a',
      workingDir: '/tmp',
      currentTurn: 1,
      messageCount: 1,
      abortSignal: new AbortController().signal,
      emit: () => {},
      resultBudgetChars: 10_000,
    };
    const results = await registry.executeParallel(
      [
        { toolCallId: 'c1', name: 'read_file', args: {} },
        { toolCallId: 'c2', name: 'web_search', args: {} },
      ],
      ctx,
      allowedTools,
    );
    expect(results[0]?.result.ok).toBe(true); // read_file: inside the narrowed set
    const rejected = results[1]?.result as Extract<ToolResult, { ok: false }>;
    expect(rejected.ok).toBe(false); // web_search: outside the narrowed set
    expect(rejected.code).toBe('not_available');
    expect(rejected.error).toMatch(/not permitted/);
  });
});
