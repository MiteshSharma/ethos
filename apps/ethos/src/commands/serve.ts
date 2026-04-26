import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { AcpServer } from '@ethosagent/acp-server';
import { AgentMesh } from '@ethosagent/agent-mesh';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { type EthosConfig, ethosDir } from '../config';
import { createAgentLoop } from '../wiring';

export async function runServe(args: string[], config: EthosConfig): Promise<void> {
  const portArg = args.find((a) => a.startsWith('--port=') || a.startsWith('--port'));
  let port = 3001;
  if (portArg) {
    const val = portArg.includes('=') ? portArg.split('=')[1] : args[args.indexOf(portArg) + 1];
    const parsed = Number(val);
    if (!Number.isNaN(parsed)) port = parsed;
  }

  const personalityArg = args.find(
    (a) => a.startsWith('--personality=') || a.startsWith('--personality'),
  );
  if (personalityArg) {
    const val = personalityArg.includes('=')
      ? personalityArg.split('=')[1]
      : args[args.indexOf(personalityArg) + 1];
    if (val) config = { ...config, personality: val };
  }

  const dir = ethosDir();
  const loop = await createAgentLoop(config);
  const session = new SQLiteSessionStore(join(dir, 'sessions.db'));
  const mesh = new AgentMesh();

  const server = new AcpServer({ runner: loop, session, mesh });
  server.startHttp(port);

  // Load personality registry to get capabilities for this agent
  const personalities = await createPersonalityRegistry();
  await personalities.loadFromDirectory(join(dir, 'personalities'));
  const personalityConfig = personalities.get(config.personality ?? 'researcher');
  const capabilities = personalityConfig?.capabilities ?? [];

  const agentId = `${config.personality ?? 'default'}:${process.pid}:${randomUUID().slice(0, 8)}`;

  mesh.register({
    agentId,
    capabilities,
    model: config.model,
    pid: process.pid,
    host: 'localhost',
    port,
    activeSessions: 0,
  });

  const stopHeartbeat = mesh.startHeartbeat(agentId, () => server.activeSessionCount);

  const cleanup = () => {
    mesh.unregister(agentId);
    stopHeartbeat();
    process.exit(0);
  };
  process.on('SIGTERM', cleanup);
  process.on('SIGINT', cleanup);

  console.log(`ethos ACP server listening on http://localhost:${port}`);
  console.log(`  agent:        ${agentId}`);
  console.log(`  personality:  ${config.personality ?? 'default'}`);
  console.log(`  capabilities: ${capabilities.length > 0 ? capabilities.join(', ') : '(none)'}`);
  console.log(`  WebSocket:    ws://localhost:${port}/ws`);

  await new Promise(() => {});
}
