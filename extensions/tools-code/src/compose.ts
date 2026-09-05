import type { ExecutionBackend, ExecutionRouter, PersonalityConfig, Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createCodeTools } from './index';

export interface CodeToolsCompose {
  tools: Tool[];
}

export function compose(
  _ctx: WiringContext,
  deps: {
    route?: ExecutionRouter;
    backendWired?: boolean;
    backend?: ExecutionBackend;
    personality?: PersonalityConfig;
    hostExecForbidden?: boolean;
    hostExecForbiddenMessage?: string;
  },
): CodeToolsCompose {
  return {
    tools: createCodeTools({
      route: deps.route,
      backendWired: deps.backendWired,
      backend: deps.backend,
      personality: deps.personality,
      hostExecForbidden: deps.hostExecForbidden,
      hostExecForbiddenMessage: deps.hostExecForbiddenMessage,
    }),
  };
}
