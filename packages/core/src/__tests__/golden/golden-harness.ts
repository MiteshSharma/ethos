import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { PersonalityConfig, StoredMessage, Tool } from '@ethosagent/types';
import { expect } from 'vitest';
import type { AgentEvent, AgentLoopConfig, RunOptions } from '../../agent-loop';
import { AgentLoop } from '../../agent-loop';
import { InMemorySessionStore } from '../../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../../defaults/noop-personality';
import { DefaultHookRegistry } from '../../hook-registry';
import { DefaultToolRegistry } from '../../tool-registry';
import { createTestSafety } from '../helpers/test-safety';
import type { CapturedCall, Step } from './scripted-llm';
import { makeScriptedLLM } from './scripted-llm';

export interface GoldenScenario {
  name: string;
  config?: Partial<AgentLoopConfig>;
  runOptions?: Partial<RunOptions>;
  text: string;
  steps: Step[];
  tools?: Tool[];
  personality?: Partial<PersonalityConfig>;
}

export interface GoldenResult {
  events: AgentEvent[];
  messages: StoredMessage[];
  llmInputs: CapturedCall[];
}

/**
 * Run a golden scenario against the real AgentLoop and capture everything.
 */
export async function runGoldenScenario(scenario: GoldenScenario): Promise<GoldenResult> {
  const session = new InMemorySessionStore();
  const tools = new DefaultToolRegistry();
  for (const tool of scenario.tools ?? []) {
    tools.register(tool);
  }

  const captured: CapturedCall[] = [];
  const llm = makeScriptedLLM(scenario.steps, captured);

  const personalities = new DefaultPersonalityRegistry();
  if (scenario.personality) {
    const merged: PersonalityConfig = {
      id: 'default',
      name: 'Default',
      ...scenario.personality,
    };
    personalities.define(merged);
    personalities.setDefault('default');
  }

  const hooks = new DefaultHookRegistry();

  const configHooks = scenario.config?.hooks;

  const config: AgentLoopConfig = {
    llm,
    tools,
    personalities,
    session,
    hooks: configHooks ?? hooks,
    safety: createTestSafety(),
    ...scenario.config,
    ...(scenario.config?.llm ? {} : { llm }),
    ...(scenario.config?.tools ? {} : { tools }),
    ...(scenario.config?.session ? {} : { session }),
    ...(scenario.config?.personalities ? {} : { personalities }),
  };

  const loop = new AgentLoop(config);

  const events: AgentEvent[] = [];
  for await (const event of loop.run(scenario.text, scenario.runOptions)) {
    events.push(event);
  }

  const sessionKey = scenario.runOptions?.sessionKey ?? 'cli:default';
  const ethosSession = await session.getSessionByKey(sessionKey);
  const messages = ethosSession ? await session.getMessages(ethosSession.id) : [];

  const normalized = normalize({ events, messages, llmInputs: captured });
  return normalized;
}

/**
 * Normalize non-deterministic fields so fixtures are stable.
 */
function normalize(result: GoldenResult): GoldenResult {
  const events = result.events.map((e) => {
    if (e.type === 'tool_end') {
      return { ...e, durationMs: 0 };
    }
    return e;
  });

  const messages = result.messages.map((m) => {
    // Phase 0 — assistant messages now persist per-turn `usage` telemetry
    // (token counts from the mock). It's not conversation structure, so strip
    // it from the characterization snapshot to keep goldens content-focused.
    const { usage: _usage, ...rest } = m as typeof m & { usage?: unknown };
    return {
      ...rest,
      id: 'normalized',
      timestamp: new Date('2000-01-01T00:00:00.000Z').toISOString(),
      sessionId: 'normalized',
    };
  });

  const llmInputs = result.llmInputs.map((call) => ({
    messages: call.messages,
    // B2 — `requestId` is a fresh UUID per LLM call, so it is normalized out
    // for the same reason `abortSignal` is: it can never be stable in a
    // fixture. That it reaches the provider at all is characterized by
    // `provider-request-correlation.test.ts`, not by these goldens.
    options: { ...call.options, abortSignal: undefined, requestId: undefined },
  }));

  return JSON.parse(JSON.stringify({ events, messages, llmInputs }));
}

/**
 * Assert a golden scenario matches its fixture, or update it.
 */
export function assertGolden(result: GoldenResult, fixturePath: string): void {
  const updateGolden = process.env.UPDATE_GOLDEN === '1';

  if (updateGolden || !existsSync(fixturePath)) {
    mkdirSync(dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8');
    return;
  }

  const expected = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  expect(result).toEqual(expected);
}
