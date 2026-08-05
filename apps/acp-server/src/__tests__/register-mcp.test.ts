import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { isServerAllowed, type McpServerConfig, type McpSessionView } from '@ethosagent/tools-mcp';
import type {
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  StoredMessage,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  AcpServer,
  type AgentRunner,
  type PersonalityAllowlistResolver,
  type SessionViewFactory,
} from '../index';

// ---------------------------------------------------------------------------
// In-memory SessionStore
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

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRunner(): AgentRunner {
  return {
    run: async function* () {
      yield { type: 'done', turnCount: 0 } as { type: string } & Record<string, unknown>;
    },
  };
}

/**
 * Creates a mock McpSessionView for testing the ACP handler logic.
 */
function makeMockSessionView() {
  const registeredServers: string[] = [];
  const teardownCalled = vi.fn();

  const view: McpSessionView = {
    registerSessionServers: vi.fn(
      async (configs: McpServerConfig[], allowlist: string[] | undefined) => {
        const registered: string[] = [];
        const rejected: { name: string; reason: string }[] = [];

        for (const config of configs) {
          if (!isServerAllowed(config.name, allowlist)) {
            rejected.push({
              name: config.name,
              reason: `Server '${config.name}' not in personality MCP allowlist`,
            });
          } else {
            registered.push(config.name);
            registeredServers.push(config.name);
          }
        }

        return { registered, rejected };
      },
    ),
    getTools: vi.fn(() => []),
    getSessionTools: vi.fn(() => []),
    isSessionTool: vi.fn(() => false),
    teardown: vi.fn(async () => {
      teardownCalled();
    }),
  } as unknown as McpSessionView;

  return { view, registeredServers, teardownCalled };
}

function makeServer(opts: {
  resolveAllowlist?: PersonalityAllowlistResolver;
  createSessionView?: SessionViewFactory;
}) {
  const store = makeStore();
  const input = new PassThrough();
  const output = new PassThrough();
  const server = new AcpServer({
    runner: makeRunner(),
    session: store,
    input,
    output,
    resolveAllowlist: opts.resolveAllowlist,
    createSessionView: opts.createSessionView,
  });
  server.start();
  return { input, output };
}

function send(input: PassThrough, req: object) {
  input.write(`${JSON.stringify(req)}\n`);
}

function readLines(output: PassThrough, count: number): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const results: unknown[] = [];
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${count} lines`)), 2000);
    output.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        results.push(JSON.parse(line));
        if (results.length >= count) {
          clearTimeout(timer);
          resolve(results);
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('session/registerMcpServers', () => {
  it('filters servers by personality allowlist', async () => {
    const { view } = makeMockSessionView();
    const resolveAllowlist: PersonalityAllowlistResolver = (personalityId) => {
      if (personalityId === 'researcher') return ['github-*', 'docs'];
      return undefined;
    };

    const { input, output } = makeServer({
      resolveAllowlist,
      createSessionView: () => view,
    });

    const lines = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/registerMcpServers',
      params: {
        servers: [
          { name: 'github-api', transport: 'stdio', command: 'echo' },
          { name: 'slack-bot', transport: 'stdio', command: 'echo' },
          { name: 'docs', transport: 'stdio', command: 'echo' },
        ],
        personalityId: 'researcher',
        sessionKey: 'test-session-1',
      },
    });

    const [resp] = (await lines) as [
      { result: { registered: string[]; rejected: { name: string; reason: string }[] } },
    ];
    expect(resp.result.registered).toContain('github-api');
    expect(resp.result.registered).toContain('docs');
    expect(resp.result.rejected).toHaveLength(1);
    expect(resp.result.rejected[0].name).toBe('slack-bot');
    expect(resp.result.rejected[0].reason).toContain('not in personality MCP allowlist');
  });

  it('rejected servers include reason', async () => {
    const { view } = makeMockSessionView();
    const resolveAllowlist: PersonalityAllowlistResolver = () => ['only-this'];

    const { input, output } = makeServer({
      resolveAllowlist,
      createSessionView: () => view,
    });

    const lines = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/registerMcpServers',
      params: {
        servers: [{ name: 'not-allowed', transport: 'stdio', command: 'echo' }],
        personalityId: 'default',
        sessionKey: 'test-session-2',
      },
    });

    const [resp] = (await lines) as [
      { result: { registered: string[]; rejected: { name: string; reason: string }[] } },
    ];
    expect(resp.result.registered).toHaveLength(0);
    expect(resp.result.rejected).toHaveLength(1);
    expect(resp.result.rejected[0].reason).toContain('not in personality MCP allowlist');
  });

  it('session/end tears down client servers', async () => {
    const { view, teardownCalled } = makeMockSessionView();

    const { input, output } = makeServer({
      createSessionView: () => view,
    });

    // Register some servers first
    const lines1 = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/registerMcpServers',
      params: {
        servers: [{ name: 'my-server', transport: 'stdio', command: 'echo' }],
        sessionKey: 'session-to-end',
      },
    });
    await lines1;

    // Now end the session
    const lines2 = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/end',
      params: { sessionKey: 'session-to-end' },
    });
    const [resp] = (await lines2) as [{ result: { ok: boolean } }];
    expect(resp.result.ok).toBe(true);
    expect(teardownCalled).toHaveBeenCalled();
  });

  it('abandoned session is torn down when the connection closes', async () => {
    // Client registers servers and then drops without sending session/end —
    // the granted MCP connections must not outlive the transport.
    const views: ReturnType<typeof makeMockSessionView>[] = [];

    const { input, output } = makeServer({
      createSessionView: () => {
        const v = makeMockSessionView();
        views.push(v);
        return v.view;
      },
    });

    const lines = readLines(output, 2);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/registerMcpServers',
      params: {
        servers: [{ name: 'keyed-server', transport: 'stdio', command: 'echo' }],
        sessionKey: 'abandoned-session',
      },
    });
    // A registration with no sessionKey gets an ephemeral key the client can
    // never name — only connection-close teardown can reclaim it.
    send(input, {
      jsonrpc: '2.0',
      id: 2,
      method: 'session/registerMcpServers',
      params: { servers: [{ name: 'ephemeral-server', transport: 'stdio', command: 'echo' }] },
    });
    await lines;

    expect(views).toHaveLength(2);
    for (const v of views) expect(v.teardownCalled).not.toHaveBeenCalled();

    input.end();
    await new Promise((r) => setImmediate(r));

    for (const v of views) expect(v.teardownCalled).toHaveBeenCalled();
  });

  it('returns rejection for all servers when session views not configured', async () => {
    // No createSessionView provided
    const { input, output } = makeServer({});

    const lines = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/registerMcpServers',
      params: {
        servers: [{ name: 'any-server', transport: 'stdio', command: 'echo' }],
      },
    });

    const [resp] = (await lines) as [
      { result: { registered: string[]; rejected: { name: string; reason: string }[] } },
    ];
    expect(resp.result.registered).toHaveLength(0);
    expect(resp.result.rejected).toHaveLength(1);
    expect(resp.result.rejected[0].reason).toContain('not configured');
  });

  it('open mode (undefined allowlist) allows all servers', async () => {
    const { view } = makeMockSessionView();
    const resolveAllowlist: PersonalityAllowlistResolver = () => undefined;

    const { input, output } = makeServer({
      resolveAllowlist,
      createSessionView: () => view,
    });

    const lines = readLines(output, 1);
    send(input, {
      jsonrpc: '2.0',
      id: 1,
      method: 'session/registerMcpServers',
      params: {
        servers: [
          { name: 'any-server', transport: 'stdio', command: 'echo' },
          { name: 'another-server', transport: 'stdio', command: 'echo' },
        ],
        sessionKey: 'open-session',
      },
    });

    const [resp] = (await lines) as [
      { result: { registered: string[]; rejected: { name: string; reason: string }[] } },
    ];
    expect(resp.result.registered).toContain('any-server');
    expect(resp.result.registered).toContain('another-server');
    expect(resp.result.rejected).toHaveLength(0);
  });
});
