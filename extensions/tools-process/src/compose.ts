import type {
  ExecutionBackend,
  ExecutionRouter,
  HookRegistry,
  PersonalityConfig,
  Tool,
} from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createProcessTools } from './index';

export interface ProcessToolsComposeOpts {
  hookRegistry?: HookRegistry;
  route?: ExecutionRouter;
  backend?: ExecutionBackend;
  personality?: PersonalityConfig;
  /** Refuse host spawn when the posture requires a sandbox/remote but none is wired. */
  hostExecForbidden?: boolean;
  /** Why the spawn is refused, in the posture's own words (ssh has its own). */
  hostExecForbiddenMessage?: string;
}

export interface ProcessToolsCompose {
  tools: Tool[];
}

export function compose(ctx: WiringContext, opts?: ProcessToolsComposeOpts): ProcessToolsCompose {
  return {
    tools: createProcessTools(ctx.dataDir, {
      hookRegistry: opts?.hookRegistry,
      route: opts?.route,
      backend: opts?.backend,
      personality: opts?.personality,
      hostExecForbidden: opts?.hostExecForbidden,
      hostExecForbiddenMessage: opts?.hostExecForbiddenMessage,
    }),
  };
}
