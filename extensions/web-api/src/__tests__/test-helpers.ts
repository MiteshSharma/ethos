import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import type { PersonalityConfig, PersonalityRegistry } from '@ethosagent/types';

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

export function makeStubPersonalityRegistry(
  personalities: PersonalityConfig[] = [],
): PersonalityRegistry {
  const map = new Map<string, PersonalityConfig>(personalities.map((p) => [p.id, p]));
  let defaultId = personalities[0]?.id ?? 'researcher';
  return {
    define(config) {
      map.set(config.id, config);
    },
    get(id) {
      return map.get(id);
    },
    list() {
      return [...map.values()];
    },
    getDefault() {
      return map.get(defaultId) ?? { id: defaultId, name: defaultId };
    },
    setDefault(id) {
      if (!map.has(id)) throw new Error(`Unknown personality: ${id}`);
      defaultId = id;
    },
    async loadFromDirectory() {},
  };
}
