import { join } from 'node:path';
import type { Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import type { BrowserToolsOptions } from './index';
import { createBrowserTools } from './index';
import { startIdleSweeper } from './sessions';

export interface BrowserToolsCompose {
  tools: Tool[];
}

// The session map is module-global, so one sweeper covers the process. A
// re-compose (a second agent loop in a gateway process) replaces the previous
// timer rather than stacking another onto the same map.
let stopSweeper: (() => void) | undefined;

export function compose(ctx: WiringContext, deps?: BrowserToolsOptions): BrowserToolsCompose {
  stopSweeper?.();
  stopSweeper = startIdleSweeper(deps?.idleTimeoutMs);

  return {
    tools: createBrowserTools({
      ...deps,
      // D4 — profiles live beside the rest of the agent's state, one directory
      // per personality. `launchPersistentContext` creates it, so nothing here
      // touches the filesystem.
      profilesDir: join(ctx.dataDir, 'browser-profiles'),
    }),
  };
}
