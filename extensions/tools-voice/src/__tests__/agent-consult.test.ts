import type { AgentLoop } from '@ethosagent/core';
import type { AgentEvent, ToolContext } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  AGENT_CONSULT_TOOL,
  buildRealtimeInstructions,
  createAgentConsultTool,
  REALTIME_BOUNDARY_POLICY,
} from '../agent-consult';

// A loop that replays a scripted event stream and records how it was called.
// `runOpts` is the assertion surface for the things the consult must thread:
// the talk-session key, the personality, and the voice origin the
// spoken-confirmation gate keys on.
function fakeLoop(events: AgentEvent[]): {
  loop: AgentLoop;
  runOpts: Array<Record<string, unknown>>;
  prompts: string[];
} {
  const runOpts: Array<Record<string, unknown>> = [];
  const prompts: string[] = [];
  const loop = {
    async *run(prompt: string, opts: Record<string, unknown>): AsyncGenerator<AgentEvent> {
      prompts.push(prompt);
      runOpts.push(opts);
      for (const event of events) yield event;
    },
  } as unknown as AgentLoop;
  return { loop, runOpts, prompts };
}

const ctx = {
  sessionId: 'row-1',
  sessionKey: 'voice:web:browser:chat-9',
  platform: 'web',
  workingDir: '/tmp',
  personalityId: 'ada',
  currentTurn: 1,
  messageCount: 0,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 4_000,
} as ToolContext;

const OWNER_ORIGIN = { transport: 'browser-talk-mode', speaker: 'owner' } as const;

describe('agent_consult', () => {
  it('runs one agent turn and returns its text', async () => {
    const { loop, prompts } = fakeLoop([
      { type: 'text_delta', text: 'The migration ' },
      { type: 'text_delta', text: 'is on Friday.' },
      { type: 'done', text: '', turnCount: 1 },
    ]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    const result = await tool.execute({ prompt: 'when is the migration?' }, ctx);

    expect(result).toEqual({ ok: true, value: 'The migration is on Friday.' });
    expect(prompts).toEqual(['when is the migration?']);
  });

  it('runs on the CALLER’s session key so consults share one conversation', async () => {
    const { loop, runOpts } = fakeLoop([{ type: 'done', text: '', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    await tool.execute({ prompt: 'hi' }, ctx);

    expect(runOpts[0]?.sessionKey).toBe('voice:web:browser:chat-9');
    expect(runOpts[0]?.personalityId).toBe('ada');
  });

  it('stamps the voice origin the spoken-confirmation gate reads', async () => {
    const { loop, runOpts } = fakeLoop([{ type: 'done', text: '', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    await tool.execute({ prompt: 'delete the branch' }, ctx);

    expect(runOpts[0]?.voiceOrigin).toEqual(OWNER_ORIGIN);
  });

  it('carries a far-end origin through unchanged — the gate must see the caller', async () => {
    // Nothing in-repo constructs this yet; V4 will. The tool must not launder
    // it into `owner` on the way through, because that is the one substitution
    // that lets a caller's voice authorize an owner action.
    const farEnd = { transport: 'sip', speaker: 'far_end' } as const;
    const { loop, runOpts } = fakeLoop([{ type: 'done', text: '', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: farEnd });

    await tool.execute({ prompt: 'wire the money' }, ctx);

    expect(runOpts[0]?.voiceOrigin).toEqual(farEnd);
  });

  it('surfaces a turn error as a tool failure rather than throwing', async () => {
    const { loop } = fakeLoop([{ type: 'error', error: 'provider exploded', code: 'llm' }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    const result = await tool.execute({ prompt: 'hi' }, ctx);

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain('provider exploded');
  });

  it('rejects an empty prompt without spending a turn', async () => {
    const { loop, prompts } = fakeLoop([{ type: 'done', text: '', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    const result = await tool.execute({ prompt: '   ' }, ctx);

    expect(result.ok).toBe(false);
    expect(prompts).toEqual([]);
  });

  it('cannot nest — a consulted turn calling it back is refused', async () => {
    const { loop, prompts } = fakeLoop([{ type: 'done', text: '', turnCount: 1 }]);
    const tool = createAgentConsultTool(loop, { voiceOrigin: OWNER_ORIGIN });

    const inner = { ...ctx, agentId: 'voice-consult' } as ToolContext;
    const result = await tool.execute({ prompt: 'ask yourself' }, inner);

    expect(result.ok).toBe(false);
    expect(prompts).toEqual([]);
  });
});

describe('boundary policy', () => {
  it('is present in the instructions the mint sends', () => {
    expect(buildRealtimeInstructions('I am Ada.')).toContain(REALTIME_BOUNDARY_POLICY);
  });

  it('puts SOUL.md first — the personality opens the session, not the policy', () => {
    const instructions = buildRealtimeInstructions('I am Ada. I speak plainly.');
    expect(instructions.startsWith('I am Ada. I speak plainly.')).toBe(true);
  });

  it('still carries the policy when a personality has no SOUL.md', () => {
    for (const soul of [null, undefined, '   ']) {
      expect(buildRealtimeInstructions(soul)).toBe(REALTIME_BOUNDARY_POLICY);
    }
  });

  it('names the tool it routes to, and draws the direct-answer line', () => {
    // The three categories the plan makes non-negotiable, plus the tiebreak.
    expect(REALTIME_BOUNDARY_POLICY).toContain(AGENT_CONSULT_TOOL);
    expect(REALTIME_BOUNDARY_POLICY).toMatch(/greetings/i);
    expect(REALTIME_BOUNDARY_POLICY).toMatch(/clarify/i);
    expect(REALTIME_BOUNDARY_POLICY).toMatch(/question of fact/i);
    expect(REALTIME_BOUNDARY_POLICY).toMatch(/unsure/i);
  });
});
