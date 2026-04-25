import { basename } from 'node:path';
import type { AgentLoop } from '@ethosagent/core';
import { render } from 'ink';
import { createElement } from 'react';
import { AgentBridge } from './agent-bridge';
import { App } from './components/App';

export type { BridgeOpts } from './agent-bridge';
export { AgentBridge } from './agent-bridge';

export interface TUIOptions {
  model: string;
  personality: string;
}

export async function runTUI(loop: AgentLoop, opts: TUIOptions): Promise<void> {
  const bridge = new AgentBridge(loop);
  const sessionKey = `cli:${basename(process.cwd())}`;

  const { waitUntilExit } = render(
    createElement(App, {
      bridge,
      model: opts.model,
      initialPersonality: opts.personality,
      initialSessionKey: sessionKey,
    }),
  );

  await waitUntilExit();
}
