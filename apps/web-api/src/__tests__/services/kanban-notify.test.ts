import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMesh } from '@ethosagent/agent-mesh';
import { DefaultHookRegistry } from '@ethosagent/core';
import { KanbanStore } from '@ethosagent/kanban-store';
import { FsStorage } from '@ethosagent/storage-fs';
import type { TicketUpdatedPayload } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KanbanService } from '../../services/kanban.service';

describe('KanbanService — assign + /notify', () => {
  let dir: string;
  let meshDir: string;
  let mesh: AgentMesh;
  let service: KanbanService;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kanban-notify-'));
    meshDir = mkdtempSync(join(tmpdir(), 'mesh-notify-'));
    mesh = new AgentMesh(join(meshDir, 'registry.json'), { storage: new FsStorage() });
    service = new KanbanService({ teamsDir: dir, mesh });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(meshDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function writeManifest(name: string): void {
    writeFileSync(
      join(dir, `${name}.yaml`),
      `name: ${name}\ndescription: test\ndomain_capabilities: [x]\nmembers:\n  - personality: engineer\n`,
    );
  }

  function openBoard(name: string): KanbanStore {
    mkdirSync(join(dir, name), { recursive: true });
    return new KanbanStore(join(dir, name, 'board.db'));
  }

  it('assign fires POST /notify to the mesh-resolved agent', async () => {
    writeManifest('team-a');

    // Seed a ready task on disk
    const store = openBoard('team-a');
    const task = store.createTask({ title: 'work item', assignee: 'other-agent' });
    store.updateStatus(task.id, 'ready');
    store.close();

    // Register the target agent in the mesh
    await mesh.register({
      agentId: 'engineer:1:abc',
      capabilities: [],
      model: 'test',
      pid: 1,
      host: '127.0.0.1',
      port: 9999,
      activeSessions: 0,
      personalityId: 'engineer',
      displayName: 'Engineer',
      boardSubscriptions: [{ board: 'team-a' }],
    });

    // Mock global fetch
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    // Assign task to 'engineer' — this should trigger notifyAssignee
    const { task: updated } = await service.assign({
      team: 'team-a',
      taskId: task.id,
      assignee: 'engineer',
      actor: 'human:test',
    });

    expect(updated.assignee).toBe('engineer');

    // Give the fire-and-forget notifyAssignee a moment to settle (file I/O + fetch)
    await new Promise((r) => setTimeout(r, 100));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:9999/notify');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ kind: 'kanban', ref: task.id, mode: 'notify+wake' });
  });

  it('assign reads the subscribers per-board mode preference (D7) into the /notify body', async () => {
    writeManifest('team-a');

    const store = openBoard('team-a');
    const task = store.createTask({ title: 'work item', assignee: 'other-agent' });
    store.updateStatus(task.id, 'ready');
    store.close();

    await mesh.register({
      agentId: 'engineer:1:abc',
      capabilities: [],
      model: 'test',
      pid: 1,
      host: '127.0.0.1',
      port: 9999,
      activeSessions: 0,
      personalityId: 'engineer',
      displayName: 'Engineer',
      // Durable preference: this subscriber wants passive delivery on team-a.
      boardSubscriptions: [{ board: 'team-a', mode: 'notify' }],
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    await service.assign({
      team: 'team-a',
      taskId: task.id,
      assignee: 'engineer',
      actor: 'human:test',
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ kind: 'kanban', ref: task.id, mode: 'notify' });
  });

  it('falls back to notify+wake when the subscriber has no matching board entry', async () => {
    writeManifest('team-a');

    const store = openBoard('team-a');
    const task = store.createTask({ title: 'work item', assignee: 'other-agent' });
    store.updateStatus(task.id, 'ready');
    store.close();

    await mesh.register({
      agentId: 'engineer:1:abc',
      capabilities: [],
      model: 'test',
      pid: 1,
      host: '127.0.0.1',
      port: 9999,
      activeSessions: 0,
      personalityId: 'engineer',
      // Subscribed to a different board — no entry for 'team-a' at all.
      boardSubscriptions: [{ board: 'team-b', mode: 'notify' }],
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    await service.assign({
      team: 'team-a',
      taskId: task.id,
      assignee: 'engineer',
      actor: 'human:test',
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(opts.body as string);
    expect(body).toEqual({ kind: 'kanban', ref: task.id, mode: 'notify+wake' });
  });

  it('assign does not fire /notify when task is not in ready status', async () => {
    writeManifest('team-a');

    // Seed a todo task (not ready)
    const store = openBoard('team-a');
    const task = store.createTask({ title: 'not ready yet' });
    store.close();

    await mesh.register({
      agentId: 'engineer:1:abc',
      capabilities: [],
      model: 'test',
      pid: 1,
      host: '127.0.0.1',
      port: 9999,
      activeSessions: 0,
      personalityId: 'engineer',
    });

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    await service.assign({
      team: 'team-a',
      taskId: task.id,
      assignee: 'engineer',
      actor: 'human:test',
    });

    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('assign does not throw when /notify fails (non-fatal)', async () => {
    writeManifest('team-a');

    const store = openBoard('team-a');
    const task = store.createTask({ title: 'work', assignee: 'other' });
    store.updateStatus(task.id, 'ready');
    store.close();

    await mesh.register({
      agentId: 'engineer:1:abc',
      capabilities: [],
      model: 'test',
      pid: 1,
      host: '127.0.0.1',
      port: 9999,
      activeSessions: 0,
      personalityId: 'engineer',
    });

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connection refused'));

    // assign itself should not throw even though /notify fails
    const { task: updated } = await service.assign({
      team: 'team-a',
      taskId: task.id,
      assignee: 'engineer',
      actor: 'human:test',
    });

    expect(updated.assignee).toBe('engineer');
    await new Promise((r) => setImmediate(r));
    // No assertion on fetch — just verifying no throw propagates
  });

  it('assign without mesh does not attempt /notify', async () => {
    const noMeshService = new KanbanService({ teamsDir: dir });
    writeManifest('team-a');

    const store = openBoard('team-a');
    const task = store.createTask({ title: 'work' });
    store.updateStatus(task.id, 'ready');
    store.close();

    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response('ok', { status: 200 }));

    await noMeshService.assign({
      team: 'team-a',
      taskId: task.id,
      assignee: 'engineer',
      actor: 'human:test',
    });

    await new Promise((r) => setImmediate(r));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('assign fires ticket_updated with { taskId, changedFields: ["assignee"] } when hooks are wired', async () => {
    writeManifest('team-a');

    const store = openBoard('team-a');
    const task = store.createTask({ title: 'work item' });
    store.close();

    const hooks = new DefaultHookRegistry();
    const updated: TicketUpdatedPayload[] = [];
    hooks.registerVoid('ticket_updated', async (payload) => {
      updated.push(payload);
    });
    const hookedService = new KanbanService({ teamsDir: dir, hooks });

    const { task: result } = await hookedService.assign({
      team: 'team-a',
      taskId: task.id,
      assignee: 'engineer',
      actor: 'human:test',
    });

    expect(result.assignee).toBe('engineer');
    expect(updated).toEqual([{ taskId: task.id, changedFields: ['assignee'] }]);
  });
});
