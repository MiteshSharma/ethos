import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMesh } from '@ethosagent/agent-mesh';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshService } from '../../services/mesh.service';

describe('MeshService', () => {
  let dir: string;
  let registryPath: string;
  let service: MeshService;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-mesh-'));
    registryPath = join(dir, 'mesh-registry.json');
    service = new MeshService({ mesh: new AgentMesh(registryPath) });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('list() returns empty when the registry file is missing', async () => {
    expect((await service.list()).agents).toEqual([]);
  });

  it('list() drops stale agents (heartbeat >30s old)', async () => {
    const fresh = Date.now();
    const stale = fresh - 60_000; // 60s old → stale
    await writeFile(
      registryPath,
      JSON.stringify([
        {
          agentId: 'fresh-agent',
          capabilities: ['code'],
          model: 'gpt-4',
          pid: 1,
          host: 'localhost',
          port: 3001,
          registeredAt: fresh,
          lastHeartbeatAt: fresh,
          activeSessions: 0,
        },
        {
          agentId: 'stale-agent',
          capabilities: ['web'],
          model: 'gpt-4',
          pid: 2,
          host: 'localhost',
          port: 3002,
          registeredAt: stale,
          lastHeartbeatAt: stale,
          activeSessions: 0,
        },
      ]),
    );

    const { agents } = await service.list();
    expect(agents).toHaveLength(1);
    expect(agents[0]?.agentId).toBe('fresh-agent');
    expect(agents[0]?.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('routeTest() returns ok=false with a reason when no peer matches', async () => {
    const result = await service.routeTest('quantum-coffee');
    expect(result.ok).toBe(false);
    expect(result.routedTo).toBeNull();
    expect(result.reason).toContain('quantum-coffee');
  });

  it('routeTest() picks the least-busy peer for a capability', async () => {
    const now = Date.now();
    await writeFile(
      registryPath,
      JSON.stringify([
        {
          agentId: 'busy',
          capabilities: ['code'],
          model: 'gpt-4',
          pid: 1,
          host: 'localhost',
          port: 3001,
          registeredAt: now,
          lastHeartbeatAt: now,
          activeSessions: 5,
        },
        {
          agentId: 'idle',
          capabilities: ['code'],
          model: 'gpt-4',
          pid: 2,
          host: 'localhost',
          port: 3002,
          registeredAt: now + 1,
          lastHeartbeatAt: now,
          activeSessions: 0,
        },
      ]),
    );

    const result = await service.routeTest('code');
    expect(result.ok).toBe(true);
    expect(result.routedTo).toBe('idle');
  });
});
