import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MeshRepository } from '../../repositories/mesh.repository';

describe('MeshRepository', () => {
  let dir: string;
  let registryPath: string;
  let repo: MeshRepository;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ethos-mesh-'));
    registryPath = join(dir, 'mesh-registry.json');
    repo = new MeshRepository({ registryPath });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('list() returns empty when the registry file is missing', async () => {
    expect(await repo.list()).toEqual([]);
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

    const live = await repo.list();
    expect(live).toHaveLength(1);
    expect(live[0]?.agentId).toBe('fresh-agent');
    expect(live[0]?.lastSeenAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('route() returns ok=false with a reason when no peer matches', async () => {
    const result = await repo.route('quantum-coffee');
    expect(result.ok).toBe(false);
    expect(result.routedTo).toBeNull();
    expect(result.reason).toContain('quantum-coffee');
  });

  it('route() picks the least-busy peer for a capability', async () => {
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

    const result = await repo.route('code');
    expect(result.ok).toBe(true);
    expect(result.routedTo).toBe('idle');
  });
});
