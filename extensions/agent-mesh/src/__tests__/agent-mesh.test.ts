import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { AgentMesh } from '../index';

function makeMesh(): AgentMesh {
  const path = join(tmpdir(), `mesh-test-${Date.now()}-${Math.random()}.json`);
  return new AgentMesh(path, { storage: new FsStorage() });
}

function entry(overrides: Partial<Parameters<AgentMesh['register']>[0]> = {}) {
  return {
    agentId: 'agent-1',
    capabilities: ['code'],
    model: 'claude-sonnet-4-6',
    pid: process.pid,
    host: 'localhost',
    port: 3001,
    activeSessions: 0,
    ...overrides,
  };
}

describe('AgentMesh', () => {
  it('registers and lists an entry', async () => {
    const mesh = makeMesh();
    await mesh.register(entry());
    const list = await mesh.list();
    expect(list).toHaveLength(1);
    expect(list[0].agentId).toBe('agent-1');
    expect(list[0].capabilities).toEqual(['code']);
  });

  it('unregisters removes entry', async () => {
    const mesh = makeMesh();
    await mesh.register(entry());
    await mesh.unregister('agent-1');
    expect(await mesh.list()).toHaveLength(0);
  });

  it('re-registration preserves original registeredAt', async () => {
    const mesh = makeMesh();
    await mesh.register(entry());
    const first = (await mesh.list())[0].registeredAt;
    await mesh.register(entry({ activeSessions: 1 }));
    const second = (await mesh.list())[0].registeredAt;
    expect(second).toBe(first);
  });

  it('route returns least-busy agent with capability', async () => {
    const mesh = makeMesh();
    await mesh.register(entry({ agentId: 'busy', activeSessions: 3, port: 3001 }));
    await mesh.register(entry({ agentId: 'idle', activeSessions: 0, port: 3002 }));
    const result = await mesh.route('code');
    expect(result?.agentId).toBe('idle');
  });

  it('route tie-breaks by registeredAt (first registered wins)', async () => {
    const mesh = makeMesh();
    await mesh.register(entry({ agentId: 'first', port: 3001 }));
    // ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    await mesh.register(entry({ agentId: 'second', port: 3002 }));
    const result = await mesh.route('code');
    expect(result?.agentId).toBe('first');
  });

  it('route returns null when no agents have capability', async () => {
    const mesh = makeMesh();
    await mesh.register(entry({ capabilities: ['review'] }));
    expect(await mesh.route('code')).toBeNull();
  });

  it('route returns null for empty registry', async () => {
    const mesh = makeMesh();
    expect(await mesh.route('code')).toBeNull();
  });

  it('heartbeat updates activeSessions', async () => {
    const mesh = makeMesh();
    await mesh.register(entry());
    await mesh.heartbeat('agent-1', 5);
    expect((await mesh.list())[0].activeSessions).toBe(5);
  });

  it('stale entries are excluded from list and route', async () => {
    const mesh = makeMesh();
    await mesh.register(entry());
    // Manually make the entry stale by backdating lastHeartbeatAt
    const path = (mesh as unknown as { path: string }).path;
    const { readFile, writeFile } = await import('node:fs/promises');
    const data = JSON.parse(await readFile(path, 'utf8'));
    data[0].lastHeartbeatAt = Date.now() - 31_000;
    await writeFile(path, JSON.stringify(data));

    expect(await mesh.list()).toHaveLength(0);
    expect(await mesh.route('code')).toBeNull();
  });

  it('heartbeat on a live entry updates in place without duplicating', async () => {
    const mesh = makeMesh();
    await mesh.register(entry());
    const before = (await mesh.list())[0];
    await mesh.heartbeat('agent-1', 7);
    const list = await mesh.list();
    expect(list).toHaveLength(1);
    expect(list[0].activeSessions).toBe(7);
    expect(list[0].registeredAt).toBe(before.registeredAt);
    expect(list[0].lastHeartbeatAt).toBeGreaterThanOrEqual(before.lastHeartbeatAt);
  });

  it('heartbeat re-inserts this instance after a peer write pruned it', async () => {
    const path = join(tmpdir(), `mesh-test-${Date.now()}-${Math.random()}.json`);
    const mesh = new AgentMesh(path, { storage: new FsStorage() });
    await mesh.register(entry({ capabilities: ['code', 'review'], model: 'opus-x', port: 3999 }));
    const registeredAt = (await mesh.list())[0].registeredAt;

    // Backdate past STALE_MS, then let a PEER instance write the registry —
    // `write()` prunes every entry that has not heartbeaten within 30s, so
    // the peer's own registration erases ours.
    const { readFile, writeFile } = await import('node:fs/promises');
    const data = JSON.parse(await readFile(path, 'utf8'));
    data[0].lastHeartbeatAt = Date.now() - 31_000;
    await writeFile(path, JSON.stringify(data));
    const peer = new AgentMesh(path, { storage: new FsStorage() });
    await peer.register(entry({ agentId: 'peer-1', port: 4000 }));
    expect((await mesh.list()).map((e) => e.agentId)).toEqual(['peer-1']);

    await mesh.heartbeat('agent-1', 4);

    const mine = (await mesh.list()).find((e) => e.agentId === 'agent-1');
    expect(mine).toBeDefined();
    expect(mine?.capabilities).toEqual(['code', 'review']);
    expect(mine?.model).toBe('opus-x');
    expect(mine?.port).toBe(3999);
    expect(mine?.activeSessions).toBe(4);
    expect(mine?.registeredAt).toBe(registeredAt);
  });

  it('heartbeat for an agentId this instance never registered stays a no-op', async () => {
    const mesh = makeMesh();
    await mesh.register(entry({ agentId: 'mine' }));
    await mesh.heartbeat('someone-else', 3);
    expect((await mesh.list()).map((e) => e.agentId)).toEqual(['mine']);
  });

  it('a peer-initiated register does not steal the cached self descriptor', async () => {
    const path = join(tmpdir(), `mesh-test-${Date.now()}-${Math.random()}.json`);
    const mesh = new AgentMesh(path, { storage: new FsStorage() });
    // Self-registration first (what `ethos serve` does at startup), then a
    // peer's registration arriving over the acp-server `mesh.register` RPC,
    // which lands on this very same AgentMesh instance.
    await mesh.register(entry({ agentId: 'self-1', port: 3001 }));
    await mesh.register(entry({ agentId: 'peer-1', port: 4000 }));

    const { writeFile } = await import('node:fs/promises');
    await writeFile(path, '[]');

    await mesh.heartbeat('peer-1', 1);
    expect(await mesh.list()).toEqual([]);

    await mesh.heartbeat('self-1', 1);
    expect((await mesh.list()).map((e) => e.agentId)).toEqual(['self-1']);
  });

  it('registers with personalityId, displayName, and boardSubscriptions', async () => {
    const mesh = makeMesh();
    await mesh.register(
      entry({
        personalityId: 'engineer',
        displayName: 'Engineer',
        boardSubscriptions: [{ board: 'backend' }],
      }),
    );
    const list = await mesh.list();
    expect(list).toHaveLength(1);
    expect(list[0].personalityId).toBe('engineer');
    expect(list[0].displayName).toBe('Engineer');
    expect(list[0].boardSubscriptions).toEqual([{ board: 'backend' }]);
  });

  it('registers with a per-board mode preference (D7)', async () => {
    const mesh = makeMesh();
    await mesh.register(
      entry({
        personalityId: 'engineer',
        boardSubscriptions: [{ board: 'backend', mode: 'notify' }],
      }),
    );
    const list = await mesh.list();
    expect(list[0].boardSubscriptions).toEqual([{ board: 'backend', mode: 'notify' }]);
  });

  it('registers without new fields (backward compat)', async () => {
    const mesh = makeMesh();
    await mesh.register(entry());
    const list = await mesh.list();
    expect(list).toHaveLength(1);
    expect(list[0].personalityId).toBeUndefined();
    expect(list[0].displayName).toBeUndefined();
    expect(list[0].boardSubscriptions).toBeUndefined();
  });

  it('normalizes a pre-restructure registry.json (boardSubscriptions as string[]) on read (D7)', async () => {
    const mesh = makeMesh();
    await mesh.register(entry({ personalityId: 'engineer' }));
    // Simulate a registry.json written before D7's restructure — bare board
    // id strings rather than { board, mode } records — the same technique
    // the "stale entries" test above uses to hand-edit the file on disk.
    const path = (mesh as unknown as { path: string }).path;
    const { readFile, writeFile } = await import('node:fs/promises');
    const data = JSON.parse(await readFile(path, 'utf8'));
    data[0].boardSubscriptions = ['backend', 'frontend'];
    await writeFile(path, JSON.stringify(data));

    const list = await mesh.list();
    expect(list[0].boardSubscriptions).toEqual([{ board: 'backend' }, { board: 'frontend' }]);
  });

  it('findByPersonality returns matching entries', async () => {
    const mesh = makeMesh();
    await mesh.register(entry({ agentId: 'a1', personalityId: 'engineer', port: 3001 }));
    await mesh.register(entry({ agentId: 'a2', personalityId: 'trader', port: 3002 }));
    await mesh.register(entry({ agentId: 'a3', personalityId: 'engineer', port: 3003 }));
    const results = await mesh.findByPersonality('engineer');
    expect(results).toHaveLength(2);
    expect(results.map((e) => e.agentId).sort()).toEqual(['a1', 'a3']);
  });

  it('findByPersonality returns empty for nonexistent personality', async () => {
    const mesh = makeMesh();
    await mesh.register(entry({ personalityId: 'engineer' }));
    expect(await mesh.findByPersonality('nonexistent')).toEqual([]);
  });

  it('findByPersonality excludes stale entries', async () => {
    const mesh = makeMesh();
    await mesh.register(entry({ personalityId: 'engineer' }));

    const path = (mesh as unknown as { path: string }).path;
    const { readFile, writeFile } = await import('node:fs/promises');
    const data = JSON.parse(await readFile(path, 'utf8'));
    data[0].lastHeartbeatAt = Date.now() - 31_000;
    await writeFile(path, JSON.stringify(data));

    expect(await mesh.findByPersonality('engineer')).toEqual([]);
  });
});
