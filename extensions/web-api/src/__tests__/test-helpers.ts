import { type AgentEvent, type AgentLoop, DefaultHookRegistry } from '@ethosagent/core';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import type { PersonalityConfig } from '@ethosagent/types';

// Test helpers shared by route + service tests. Building a real `AgentLoop`
// requires LLM creds + tools + memory + personalities — overkill for tests
// that just want to verify HTTP shapes or service composition. The stub
// below satisfies the structural type so `createWebApi` accepts it; tests
// that exercise the bridge pass an explicit script.

export interface StubLoopOptions {
  /** Events to yield on every `run()` call. Defaults to a single done event. */
  events?: AgentEvent[];
  /** If provided, called on every run with the input text + opts. */
  onRun?: (input: string, opts: unknown) => void;
}

export function makeStubAgentLoop(options: StubLoopOptions = {}): AgentLoop {
  const events = options.events ?? [{ type: 'done', text: '', turnCount: 1 }];
  const stub = {
    // Real registry so createWebApi can register the web approval hook against
    // the stub without a special-case branch.
    hooks: new DefaultHookRegistry(),
    async *run(input: string, opts: unknown): AsyncGenerator<AgentEvent> {
      options.onRun?.(input, opts);
      for (const event of events) yield event;
    },
  };
  // Cast: `AgentLoop` has many private fields, but the runtime only needs `run`
  // for the AgentBridge to work. Tests that touch other methods will type-fail
  // here, prompting an explicit fix.
  return stub as unknown as AgentLoop;
}

// ---------------------------------------------------------------------------
// PersonalityRegistry stub
//
// Tests that don't care about personalities pass `makeStubPersonalityRegistry()`.
// Tests that DO care provide an array of `PersonalityConfig` shapes to seed.
// ---------------------------------------------------------------------------

/**
 * Build a real FilePersonalityRegistry pre-populated with the given
 * personality configs. Optionally bind a `userPersonalitiesDir` so CRUD
 * methods (`create`/`update`/`deletePersonality`/`duplicate`) work.
 *
 * Tests that don't care about CRUD pass `personalities` only; tests that
 * exercise CRUD pass `userPersonalitiesDir` so the registry can write to
 * disk.
 */
export function makeStubPersonalityRegistry(
  personalities: PersonalityConfig[] = [],
  userPersonalitiesDir?: string,
): FilePersonalityRegistry {
  const registry = new FilePersonalityRegistry(undefined, userPersonalitiesDir);
  for (const p of personalities) registry.define(p);
  if (personalities[0]) registry.setDefault(personalities[0].id);
  return registry;
}
