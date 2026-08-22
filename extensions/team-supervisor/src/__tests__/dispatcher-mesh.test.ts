import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMesh } from '@ethosagent/agent-mesh';
import { KanbanStore } from '@ethosagent/kanban-store';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DispatchCall, Dispatcher, type SupervisorState } from '../dispatcher';

describe('Dispatcher with AgentMesh', () => {
  let board: KanbanStore;
  let meshDir: string;
  let mesh: AgentMesh;

  // An empty supervisor — mesh takes over resolution.
  const emptySupervisor: SupervisorState = {
    portOf: () => null,
    statusOf: () => null,
  };

  beforeEach(() => {
    board = new KanbanStore(':memory:');
    meshDir = mkdtempSync(join(tmpdir(), 'mesh-'));
    mesh = new AgentMesh(join(meshDir, 'registry.json'), { storage: new FsStorage() });
  });

  afterEach(() => {
    board.close();
    rmSync(meshDir, { recursive: true, force: true });
  });

  it('resolves assignee via mesh.findByPersonality and dispatches /notify', async () => {
    // Register an agent in the mesh
    await mesh.register({
      agentId: 'engineer:1234:abc',
      capabilities: [],
      model: 'test',
      pid: 1234,
      host: 'localhost',
      port: 4001,
      activeSessions: 0,
      personalityId: 'engineer',
      displayName: 'Engineer',
      boardSubscriptions: [{ board: 'team-a' }],
    });

    // Create a ready task assigned to 'engineer'
    const t = board.createTask({ title: 'build feature', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: emptySupervisor,
      mesh,
      dispatch,
    });

    await dispatcher.tick();

    // Task claimed
    expect(board.getTask(t.id)?.status).toBe('running');

    // Dispatch fired with mesh-resolved host/port
    await new Promise((r) => setImmediate(r));
    expect(dispatch).toHaveBeenCalledTimes(1);
    const call = dispatch.mock.calls[0]?.[0];
    expect(call?.host).toBe('localhost');
    expect(call?.port).toBe(4001);
    expect(call?.personalityId).toBe('engineer');
  });

  it('skips dispatch when mesh has no entry for the assignee', async () => {
    const t = board.createTask({ title: 'build feature', assignee: 'unknown-agent' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: emptySupervisor,
      mesh,
      dispatch,
    });

    await dispatcher.tick();

    // Task stays ready — no agent to dispatch to
    expect(board.getTask(t.id)?.status).toBe('ready');
    await new Promise((r) => setImmediate(r));
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatch prompt includes the task id', async () => {
    await mesh.register({
      agentId: 'eng:1:x',
      capabilities: [],
      model: 'test',
      pid: 1,
      host: 'localhost',
      port: 5000,
      activeSessions: 0,
      personalityId: 'engineer',
    });

    const t = board.createTask({ title: 'implement API', assignee: 'engineer' });
    board.updateStatus(t.id, 'ready');

    const dispatch = vi.fn<DispatchCall>(async () => 'ok');
    const dispatcher = new Dispatcher({
      board,
      supervisor: emptySupervisor,
      mesh,
      dispatch,
    });

    await dispatcher.tick();
    await new Promise((r) => setImmediate(r));

    expect(dispatch).toHaveBeenCalledTimes(1);
    const prompt = dispatch.mock.calls[0]?.[0]?.prompt;
    expect(prompt).toContain(t.id);
  });
});
