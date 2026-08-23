import type { KanbanStore } from '@ethosagent/kanban-store';
import type { HookRegistry, LLMProvider, Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { type AutonomyTierOf, createKanbanTools, type PersonalityLookup } from './index';

export interface KanbanToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: {
    store: KanbanStore;
    hooks?: HookRegistry;
    autonomyTierOf?: AutonomyTierOf;
    personalityLookup?: PersonalityLookup;
    decomposerProvider?: LLMProvider;
  },
): KanbanToolsCompose {
  return {
    tools: createKanbanTools({
      store: deps.store,
      hooks: deps.hooks,
      autonomyTierOf: deps.autonomyTierOf,
      personalityLookup: deps.personalityLookup,
      decomposerProvider: deps.decomposerProvider,
    }),
  };
}
