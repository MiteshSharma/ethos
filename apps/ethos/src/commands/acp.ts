import { join } from 'node:path';
import { AcpServer } from '@ethosagent/acp-server';
import { type EthosConfig, ethosDir } from '@ethosagent/config';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { createSessionStore } from '@ethosagent/wiring';
import { createAcpMcpWiring } from '../lib/acp-mcp-wiring';
import { createAgentLoop, getStorage } from '../wiring';

export async function runAcp(config: EthosConfig): Promise<void> {
  const dir = ethosDir();
  const { loop, mcpManager, activePersonality } = await createAgentLoop(config);
  // separate connection for fork_session / resume_session reads and writes
  const session = createSessionStore({ dataDir: dir });
  const personalities = await createPersonalityRegistry({
    storage: getStorage(),
    userPersonalitiesDir: dir,
  });
  await personalities.loadFromDirectory(join(dir, 'personalities'));
  const server = new AcpServer({
    runner: loop,
    session,
    ...createAcpMcpWiring({
      mcpManager,
      personalities,
      defaultPersonalityId: activePersonality.id,
    }),
  });
  server.start();
  // keep the process alive — readline drives everything from here
  await new Promise(() => {});
}
