import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AgentMesh } from '@ethosagent/agent-mesh';
import { KanbanStore } from '@ethosagent/kanban-store';
import { FsStorage, InMemorySecretsResolver } from '@ethosagent/storage-fs';
import {
  type DispatchCall,
  Dispatcher,
  defaultDispatchCall,
  type SupervisorState,
} from '@ethosagent/team-supervisor';
import type {
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  StoredMessage,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AcpServer, type AgentRunner } from '../index';

// ---------------------------------------------------------------------------
// Closes the loop on the missing producer half of team-member auth: it
// mirrors — as closely as a unit test can without shelling out `ethos team
// start` — the exact boot sequence added to `apps/ethos/src/commands/serve.ts`
// for a team member's `AcpServer`:
//
//   1. generate a token with the same `randomBytes(32).toString('hex')` shape
//      `AcpServer` itself already uses as its no-config fallback
//   2. store the VALUE via `SecretsResolver.set(ref, token)` (S9 — never in
//      the mesh registry by value)
//   3. construct the real `AcpServer` with that SAME token as `authToken`
//   4. register the mesh entry with `authTokenRef` set to the ref name (never
//      the value)
//
// It then drives the REAL `Dispatcher` — the consumer half a prior fix
// already built (see ../dispatcher-auth.test.ts, which proves the transport
// sends the header correctly given an explicit token) — over a REAL socket,
// using the unmodified `defaultDispatchCall` transport, and asserts the round
// trip succeeds: the token `SecretsResolver` returns for the registry entry's
// `authTokenRef` is the exact token the live `AcpServer` enforces.
// ---------------------------------------------------------------------------

function makeStore(): SessionStore {
  const sessions = new Map<string, Session>();
  const messages = new Map<string, StoredMessage[]>();
  return {
    async createSession(data) {
      const s: Session = {
        ...data,
        id: randomUUID(),
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      sessions.set(s.id, s);
      return s;
    },
    async getSession(id) {
      return sessions.get(id) ?? null;
    },
    async getSessionByKey(key) {
      for (const s of sessions.values()) if (s.key === key) return s;
      return null;
    },
    async updateSession(id, patch) {
      const s = sessions.get(id);
      if (s) sessions.set(id, { ...s, ...patch, updatedAt: new Date() });
    },
    async deleteSession(id) {
      sessions.delete(id);
      messages.delete(id);
    },
    async listSessions(_filter?: SessionFilter) {
      return [...sessions.values()];
    },
    async appendMessage(msg) {
      const stored: StoredMessage = { ...msg, id: randomUUID(), timestamp: new Date() };
      const list = messages.get(msg.sessionId) ?? [];
      list.push(stored);
      messages.set(msg.sessionId, list);
      return stored;
    },
    async getMessages(sessionId, opts) {
      const list = messages.get(sessionId) ?? [];
      if (opts?.limit !== undefined) return list.slice(-opts.limit);
      return list;
    },
    async updateUsage(_id, _delta) {},
    async search(_query, _opts): Promise<SearchResult[]> {
      return [];
    },
    async recordCompression(event) {
      return { ...event, id: randomUUID(), createdAt: new Date() };
    },
    async listCompressions(_sessionId) {
      return [];
    },
    async recordTurnStart(_sessionId) {
      return { turnNumber: 0, lastCompactionTurn: 0 };
    },
    async recordCompactionTurn(_sessionId, _turnNumber) {},
    async pruneOldSessions(_olderThan) {
      return 0;
    },
    async undoTurns() {
      return 0;
    },
    async vacuum() {},
  };
}

function makeRunner(): AgentRunner {
  return {
    run: async function* () {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', text: 'ok', turnCount: 1 };
    },
  };
}

async function listen(server: AcpServer): Promise<{
  httpServer: ReturnType<typeof import('node:http').createServer>;
  port: number;
}> {
  const httpServer = server.startHttp(0);
  await new Promise<void>((resolve) => {
    httpServer.on('listening', () => resolve());
  });
  const addr = httpServer.address();
  const port = addr && typeof addr === 'object' ? addr.port : 0;
  return { httpServer, port };
}

const emptySupervisor: SupervisorState = {
  portOf: () => null,
  statusOf: () => null,
};

describe('team-member AcpServer bearer token — producer (serve.ts boot) + consumer (Dispatcher) end-to-end', () => {
  let board: KanbanStore;
  let meshDir: string;
  let mesh: AgentMesh;
  let server: AcpServer;
  let httpServer: ReturnType<typeof import('node:http').createServer>;

  beforeEach(() => {
    board = new KanbanStore(':memory:');
    meshDir = mkdtempSync(join(tmpdir(), 'mesh-spawn-auth-'));
    mesh = new AgentMesh(join(meshDir, 'registry.json'), { storage: new FsStorage() });
  });

  afterEach(async () => {
    board.close();
    await new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    rmSync(meshDir, { recursive: true, force: true });
  });

  it('the SecretsResolver-resolved token authenticates against the real AcpServer it was generated for', async () => {
    const meshName = 'default';
    const personalityId = 'engineer';

    // --- Producer: mirrors the block added to apps/ethos/src/commands/serve.ts ---
    const secrets = new InMemorySecretsResolver();
    const token = randomBytes(32).toString('hex');
    const authTokenRef = `mesh/${meshName}/${personalityId}`;
    await secrets.set(authTokenRef, token);

    server = new AcpServer({ runner: makeRunner(), session: makeStore(), authToken: token });
    const listening = await listen(server);
    httpServer = listening.httpServer;
    const port = listening.port;

    await mesh.register({
      agentId: `${personalityId}:1234:abc`,
      capabilities: [],
      model: 'test',
      pid: 1234,
      host: '127.0.0.1',
      port,
      activeSessions: 0,
      personalityId,
      authTokenRef,
    });

    // S9 check — the registry file on disk must carry the ref, never the value.
    const registryContents = await new FsStorage().read(join(meshDir, 'registry.json'));
    expect(registryContents).toContain(authTokenRef);
    expect(registryContents).not.toContain(token);

    // --- Consumer: the real Dispatcher, driving the unmodified HTTP transport ---
    const task = board.createTask({ title: 'ship it', assignee: personalityId });
    board.updateStatus(task.id, 'ready');

    let dispatchError: unknown;
    let dispatchResult: string | undefined;
    let signalDone: () => void = () => {};
    const done = new Promise<void>((resolve) => {
      signalDone = resolve;
    });
    const dispatch: DispatchCall = async (args) => {
      try {
        dispatchResult = await defaultDispatchCall(args);
        return dispatchResult;
      } catch (err) {
        dispatchError = err;
        throw err;
      } finally {
        signalDone();
      }
    };

    const dispatcher = new Dispatcher({
      board,
      supervisor: emptySupervisor,
      mesh,
      secrets,
      dispatch,
    });

    await dispatcher.tick();
    await done;

    expect(dispatchError).toBeUndefined();
    expect(dispatchResult).toBe('notified');

    // On a successful dispatch the task is left `running` (the assignee is
    // responsible for kanban_complete/kanban_block) — a 401 would instead
    // have routed through `blockRun`, flipping it to `blocked`.
    const finalTask = board.getTask(task.id);
    expect(finalTask?.status).toBe('running');
  });
});
