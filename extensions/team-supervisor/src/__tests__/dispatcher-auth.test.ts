import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMesh } from '@ethosagent/agent-mesh';
import { KanbanStore } from '@ethosagent/kanban-store';
import { FsStorage, InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type DispatchCall,
  Dispatcher,
  type SpawnDispatchCall,
  type SupervisorState,
} from '../dispatcher';

// An empty supervisor — mesh takes over resolution in every test here.
const emptySupervisor: SupervisorState = {
  portOf: () => null,
  statusOf: () => null,
};

describe('Dispatcher — bearer token resolution via SecretsResolver (S9)', () => {
  let board: KanbanStore;
  let meshDir: string;
  let mesh: AgentMesh;

  beforeEach(() => {
    board = new KanbanStore(':memory:');
    meshDir = mkdtempSync(join(tmpdir(), 'mesh-auth-'));
    mesh = new AgentMesh(join(meshDir, 'registry.json'), { storage: new FsStorage() });
  });

  afterEach(() => {
    board.close();
    rmSync(meshDir, { recursive: true, force: true });
  });

  it('resolves the mesh entry authTokenRef via SecretsResolver and passes it to dispatch', async () => {
    await mesh.register({
      agentId: 'engineer:1234:abc',
      capabilities: [],
      model: 'test',
      pid: 1234,
      host: 'localhost',
      port: 4001,
      activeSessions: 0,
      personalityId: 'engineer',
      authTokenRef: 'mesh/default/engineer',
    });

    const secrets = new InMemorySecretsResolver();
    await secrets.set('mesh/default/engineer', 'super-secret-token');

    const t = board.createTask({ title: 'build feature', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: emptySupervisor,
      mesh,
      dispatch,
      secrets,
    });

    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]?.authToken).toBe('super-secret-token');
  });

  it('dispatches without an authToken when the mesh entry has no authTokenRef', async () => {
    await mesh.register({
      agentId: 'engineer:1234:abc',
      capabilities: [],
      model: 'test',
      pid: 1234,
      host: 'localhost',
      port: 4001,
      activeSessions: 0,
      personalityId: 'engineer',
      // no authTokenRef
    });

    const secrets = new InMemorySecretsResolver();
    const t = board.createTask({ title: 'build feature', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: emptySupervisor,
      mesh,
      dispatch,
      secrets,
    });

    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]?.authToken).toBeUndefined();
  });

  it('dispatches without an authToken when the referenced secret is not configured', async () => {
    await mesh.register({
      agentId: 'engineer:1234:abc',
      capabilities: [],
      model: 'test',
      pid: 1234,
      host: 'localhost',
      port: 4001,
      activeSessions: 0,
      personalityId: 'engineer',
      authTokenRef: 'mesh/default/engineer',
    });

    // secrets resolver has nothing stored under that ref
    const secrets = new InMemorySecretsResolver();

    const t = board.createTask({ title: 'build feature', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: emptySupervisor,
      mesh,
      dispatch,
      secrets,
    });

    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]?.authToken).toBeUndefined();
  });

  it('dispatches without an authToken when no SecretsResolver was injected', async () => {
    await mesh.register({
      agentId: 'engineer:1234:abc',
      capabilities: [],
      model: 'test',
      pid: 1234,
      host: 'localhost',
      port: 4001,
      activeSessions: 0,
      personalityId: 'engineer',
      authTokenRef: 'mesh/default/engineer',
    });

    const t = board.createTask({ title: 'build feature', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: emptySupervisor,
      mesh,
      dispatch,
      // no `secrets` option
    });

    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch.mock.calls[0]?.[0]?.authToken).toBeUndefined();
  });

  it('resolves the authTokenRef for the background-job spawn path too', async () => {
    await mesh.register({
      agentId: 'engineer:1234:abc',
      capabilities: [],
      model: 'test',
      pid: 1234,
      host: 'localhost',
      port: 4001,
      activeSessions: 0,
      personalityId: 'engineer',
      authTokenRef: 'mesh/default/engineer',
    });

    const secrets = new InMemorySecretsResolver();
    await secrets.set('mesh/default/engineer', 'spawn-secret-token');

    const t = board.createTask({ title: 'build feature', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const spawnDispatch = vi.fn<SpawnDispatchCall>(async () => ({ jobId: 'job-1' }));
    const dispatcher = new Dispatcher({
      board,
      supervisor: emptySupervisor,
      mesh,
      dispatchAsBackgroundJob: true,
      spawnDispatch,
      secrets,
    });

    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));

    expect(spawnDispatch).toHaveBeenCalledTimes(1);
    expect(spawnDispatch.mock.calls[0]?.[0]?.authToken).toBe('spawn-secret-token');
  });
});
