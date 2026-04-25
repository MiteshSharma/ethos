import { join } from 'node:path';
import { AcpServer } from '@ethosagent/acp-server';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { type EthosConfig, ethosDir } from '../config';
import { createAgentLoop } from '../wiring';

export async function runAcp(config: EthosConfig): Promise<void> {
  const dir = ethosDir();
  const loop = await createAgentLoop(config);
  // separate connection for fork_session / resume_session reads and writes
  const session = new SQLiteSessionStore(join(dir, 'sessions.db'));
  const server = new AcpServer({ runner: loop, session });
  server.start();
  // keep the process alive — readline drives everything from here
  await new Promise(() => {});
}
