import type { Tool } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import type { BrowserToolsOptions } from './index';
import { createBrowserTools } from './index';

export interface BrowserToolsCompose {
  tools: Tool[];
}

export function compose(_ctx: WiringContext, deps?: BrowserToolsOptions): BrowserToolsCompose {
  return { tools: createBrowserTools(deps) };
}
