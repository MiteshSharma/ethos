import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AgentMesh } from '../index';

function makeMesh(): AgentMesh {
  const path = join(tmpdir(), `mesh-test-${Date.now()}-${Math.random()}.json`);
  return new AgentMesh(path);
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
  it('registers and lists an entry', () => {
    const mesh = makeMesh();
    mesh.register(entry());
    const list = mesh.list();
    expect(list).toHaveLength(1);
    expect(list[0].agentId).toBe('agent-1');
    expect(list[0].capabilities).toEqual(['code']);
  });

  it('unregisters removes entry', () => {
    const mesh = makeMesh();
    mesh.register(entry());
    mesh.unregister('agent-1');
    expect(mesh.list()).toHaveLength(0);
  });

  it('re-registration preserves original registeredAt', () => {
    const mesh = makeMesh();
    mesh.register(entry());
    const first = mesh.list()[0].registeredAt;
    mesh.register(entry({ activeSessions: 1 }));
    const second = mesh.list()[0].registeredAt;
    expect(second).toBe(first);
  });

  it('route returns least-busy agent with capability', () => {
    const mesh = makeMesh();
    mesh.register(entry({ agentId: 'busy', activeSessions: 3, port: 3001 }));
    mesh.register(entry({ agentId: 'idle', activeSessions: 0, port: 3002 }));
    const result = mesh.route('code');
    expect(result?.agentId).toBe('idle');
  });

  it('route tie-breaks by registeredAt (first registered wins)', async () => {
    const mesh = makeMesh();
    mesh.register(entry({ agentId: 'first', port: 3001 }));
    // ensure different timestamps
    await new Promise((r) => setTimeout(r, 5));
    mesh.register(entry({ agentId: 'second', port: 3002 }));
    const result = mesh.route('code');
    expect(result?.agentId).toBe('first');
  });

  it('route returns null when no agents have capability', () => {
    const mesh = makeMesh();
    mesh.register(entry({ capabilities: ['review'] }));
    expect(mesh.route('code')).toBeNull();
  });

  it('route returns null for empty registry', () => {
    const mesh = makeMesh();
    expect(mesh.route('code')).toBeNull();
  });

  it('heartbeat updates activeSessions', () => {
    const mesh = makeMesh();
    mesh.register(entry());
    mesh.heartbeat('agent-1', 5);
    expect(mesh.list()[0].activeSessions).toBe(5);
  });

  it('stale entries are excluded from list and route', () => {
    const mesh = makeMesh();
    mesh.register(entry());
    // Manually make the entry stale by backdating lastHeartbeatAt
    const path = (mesh as unknown as { path: string }).path;
    const data = JSON.parse(require('node:fs').readFileSync(path, 'utf8'));
    data[0].lastHeartbeatAt = Date.now() - 31_000;
    require('node:fs').writeFileSync(path, JSON.stringify(data));

    expect(mesh.list()).toHaveLength(0);
    expect(mesh.route('code')).toBeNull();
  });
});
