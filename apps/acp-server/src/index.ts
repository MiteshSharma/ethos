import { randomBytes, randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AgentMesh, MeshEntry } from '@ethosagent/agent-mesh';
import type { PendingNotifyQueue } from '@ethosagent/notify-queue';
import { SessionLane } from '@ethosagent/session-lane';
import type { McpServerConfig, McpSessionView } from '@ethosagent/tools-mcp';
import type { JobStore, SessionStore } from '@ethosagent/types';
import { type WebSocket, WebSocketServer } from 'ws';

/** Maximum number of concurrent MCP session views. */
const MAX_ACP_SESSIONS = 100;

// ---------------------------------------------------------------------------
// Local types — avoids depending on @ethosagent/core
// ---------------------------------------------------------------------------

type AgentEvent = { type: string } & Record<string, unknown>;

interface RunOptions {
  sessionKey?: string;
  personalityId?: string;
  abortSignal?: AbortSignal;
}

export interface AgentRunner {
  run(text: string, opts?: RunOptions): AsyncGenerator<AgentEvent>;
}

/**
 * Resolves the MCP allowlist for a given personality. Returns `undefined`
 * when in open mode (no filtering). Returns `string[]` patterns when the
 * personality has an explicit mcp_servers list.
 */
export type PersonalityAllowlistResolver = (
  personalityId: string | undefined,
) => string[] | undefined;

/**
 * Factory function to create a session-scoped McpSessionView.
 * Injected at construction time to avoid hard-coupling to tools-mcp internals.
 */
export type SessionViewFactory = () => McpSessionView;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 types
// ---------------------------------------------------------------------------

type Id = number | string | null;

interface Request {
  jsonrpc: '2.0';
  id?: Id;
  method: string;
  params?: unknown;
}

// ---------------------------------------------------------------------------
// AcpServer — JSON-RPC 2.0 transport over stdio, HTTP, and WebSocket
//
// Stdio protocol (existing):
//   Request:      {"jsonrpc":"2.0","id":1,"method":"...","params":{...}}\n
//   Notification: {"jsonrpc":"2.0","method":"$/stream","params":{"requestId":1,"event":{...}}}\n
//   Response:     {"jsonrpc":"2.0","id":1,"result":{...}}\n
//   Error:        {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"..."}}\n
//
// HTTP transport (Phase 24):
//   POST /rpc — synchronous JSON-RPC (prompt runs to completion, no streaming)
//   GET  /ws  — WebSocket with same streaming protocol as stdio
// ---------------------------------------------------------------------------

export class AcpServer {
  private readonly runner: AgentRunner;
  private readonly session: SessionStore;
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly mesh: AgentMesh | undefined;
  private readonly abortControllers = new Map<Id, AbortController>();
  // tracks which sessionKeys have an active prompt
  private readonly busySessions = new Set<string>();
  private readonly startedAt = Date.now();
  private lastTurnAt: number | null = null;

  // Phase 5 — client-provided MCP servers
  private readonly _resolveAllowlist: PersonalityAllowlistResolver | undefined;
  private readonly _createSessionView: SessionViewFactory | undefined;
  private readonly _sessionViews = new Map<string, McpSessionView>();

  /** Bearer token required for all authenticated endpoints. */
  private readonly _authToken: string;
  private readonly lane = new SessionLane();

  // Phase C — remote background spawn over the mesh RPC
  private readonly jobStore: JobStore | undefined;
  private readonly backgroundExecutor: { readonly owner: string; nudge(): void } | undefined;

  // Lane C (kanban-hooks-notify-parity, Phase 2) — passive `notify`-mode delivery.
  private readonly personalityId: string | undefined;
  private readonly teamId: string | undefined;
  private readonly notifyQueue: PendingNotifyQueue | undefined;

  constructor(config: {
    runner: AgentRunner;
    session: SessionStore;
    input?: Readable;
    output?: Writable;
    mesh?: AgentMesh;
    /** Phase 5: resolves personality MCP allowlist given a personalityId. */
    resolveAllowlist?: PersonalityAllowlistResolver;
    /** Phase 5: factory to create McpSessionView instances. */
    createSessionView?: SessionViewFactory;
    /** Optional bearer token. If omitted, a 32-byte random hex token is generated. */
    authToken?: string;
    /** Phase C: durable background job store, enables the `spawn`/`job_status` methods. */
    jobStore?: JobStore;
    // Structural — avoids depending on @ethosagent/job-runner. Only owner + nudge are needed.
    backgroundExecutor?: { readonly owner: string; nudge(): void };
    /**
     * This server's own personality identity (Lane C, kanban-hooks-notify-parity,
     * Phase 2). Every `/notify` call already targets this exact process —
     * `Dispatcher.fireDispatch` and `KanbanService.notifyAssignee` both resolve
     * host:port per-assignee via the mesh — so a passive `notify`-mode delivery
     * is written to the pending-notify queue under THIS personality's id, never
     * one read off the wire. Required (alongside `teamId` and `notifyQueue`)
     * for the passive path to have anywhere to land; absent on a solo
     * (non-team) ACP server, which then just drops that path.
     */
    personalityId?: string;
    /** Team this server belongs to. See `personalityId` above. */
    teamId?: string;
    /** Pending-notify queue writer for the passive `notify` mode (Phase 2). */
    notifyQueue?: PendingNotifyQueue;
  }) {
    this.runner = config.runner;
    this.session = config.session;
    this.input = config.input ?? process.stdin;
    this.output = config.output ?? process.stdout;
    this.mesh = config.mesh;
    this._resolveAllowlist = config.resolveAllowlist;
    this._createSessionView = config.createSessionView;
    this._authToken = config.authToken ?? randomBytes(32).toString('hex');
    this.jobStore = config.jobStore;
    this.backgroundExecutor = config.backgroundExecutor;
    this.personalityId = config.personalityId;
    this.teamId = config.teamId;
    this.notifyQueue = config.notifyQueue;
  }

  /**
   * Writes a passive `notify`-mode delivery to the pending-notify queue
   * (Lane C, kanban-hooks-notify-parity, D6) instead of forcing a turn. A
   * no-op when the queue isn't wired (solo/non-team ACP server) — there is
   * nowhere for the notice to land, and falling back to the forced-turn path
   * would defeat the point of asking for `notify`-only delivery.
   */
  private async deliverPassiveNotify(kind: string, ref: string | undefined): Promise<void> {
    if (!this.notifyQueue || !this.teamId || !this.personalityId) return;
    await this.notifyQueue.write({
      team: this.teamId,
      assigneePersonalityId: this.personalityId,
      kind,
      ref,
    });
  }

  /** Returns the bearer token clients must present to access authenticated endpoints. */
  get token(): string {
    return this._authToken;
  }

  get activeSessionCount(): number {
    return this.busySessions.size;
  }

  // ---------------------------------------------------------------------------
  // Stdio transport (original)
  // ---------------------------------------------------------------------------

  start(): void {
    const rl = createInterface({ input: this.input, terminal: false });
    const ownedSessionKeys = new Set<string>();
    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let req: Request;
      try {
        req = JSON.parse(trimmed) as Request;
      } catch {
        this.sendError(null, -32700, 'Parse error');
        return;
      }
      if (req.id !== undefined) {
        void this.dispatch(
          req,
          (msg) => this.send(msg),
          this.abortControllers,
          ownedSessionKeys,
        ).catch(() => {});
      }
    });
    rl.on('close', () => {
      void this.teardownOwnedSessions(ownedSessionKeys);
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP + WebSocket transport (Phase 24)
  // ---------------------------------------------------------------------------

  startHttp(port: number): ReturnType<typeof createHttpServer> {
    const host = process.env.ETHOS_ACP_BIND_ALL === '1' ? '0.0.0.0' : '127.0.0.1';

    const httpServer = createHttpServer((req, res) => {
      void this.handleHttpRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });

    const wss = new WebSocketServer({ noServer: true });

    httpServer.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      // Only handle /ws path
      if (req.url !== '/ws') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // Origin validation — block DNS rebinding
      const origin = req.headers.origin;
      if (origin) {
        let url: URL;
        try {
          url = new URL(origin);
        } catch {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
        if (url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      // Bearer token authentication
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${this._authToken}`) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit('connection', ws, req);
      });
    });

    wss.on('connection', (ws) => this.handleWsConnection(ws));

    httpServer.listen(port, host);
    return httpServer;
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Health check is unauthenticated
    if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          status: 'ok',
          uptime_s: Math.floor((Date.now() - this.startedAt) / 1000),
          active_sessions: this.busySessions.size,
          last_turn_at: this.lastTurnAt ? new Date(this.lastTurnAt).toISOString() : null,
        }),
      );
      return;
    }

    // Require bearer token for all other requests
    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${this._authToken}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    if (req.method === 'POST' && req.url === '/notify') {
      const body = await readBody(req);
      let parsed: { kind?: unknown; ref?: unknown; mode?: unknown };
      try {
        parsed = JSON.parse(body) as { kind?: unknown; ref?: unknown; mode?: unknown };
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }
      if (!parsed.kind || typeof parsed.kind !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'kind is required and must be a non-empty string' }));
        return;
      }
      const kind = parsed.kind;
      const ref = typeof parsed.ref === 'string' ? parsed.ref : undefined;

      // Lane C (kanban-hooks-notify-parity), Phase 2 — `notify` mode is a
      // passive delivery: no forced turn, no minted sessionKey. It is
      // surfaced later by the pending-notify ContextInjector at this
      // personality's own next turn (D6). `wake`/`notify+wake`/absent all
      // keep today's exact forced-turn behavior below.
      if (parsed.mode === 'notify') {
        await this.deliverPassiveNotify(kind, ref).catch(() => {});
        res.writeHead(202, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queued: this.lane.length }));
        return;
      }

      const prompt = renderNotifyPrompt(kind, ref);
      const sessionKey = `notify:${kind}:${Date.now()}`;
      void this.lane.enqueue(async (_signal) => {
        await this.runBlocking(prompt, sessionKey).catch(() => {});
      });
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, queued: this.lane.length }));
      return;
    }

    if (req.method !== 'POST' || req.url !== '/rpc') {
      res.writeHead(404);
      res.end();
      return;
    }

    const body = await readBody(req);
    let rpcReq: Request;
    try {
      rpcReq = JSON.parse(body) as Request;
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32700, message: 'Parse error' },
        }),
      );
      return;
    }

    // For HTTP, run blocking (no intermediate streaming)
    const response = await this.handleHttpRpc(rpcReq);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(response));
  }

  private async handleHttpRpc(req: Request): Promise<object> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '1.0',
              serverName: 'ethos',
              capabilities: { streaming: true },
            },
          };

        case 'new_session':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              sessionKey: `acp:${randomUUID()}`,
              personalityId:
                (req.params as { personalityId?: string } | undefined)?.personalityId ?? null,
            },
          };

        case 'prompt': {
          const p = req.params as { sessionKey: string; text: string; personalityId?: string };
          if (this.busySessions.has(p.sessionKey)) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: `Session ${p.sessionKey} has a prompt in progress` },
            };
          }
          this.busySessions.add(p.sessionKey);
          try {
            const { text, turnCount } = await this.runBlocking(
              p.text,
              p.sessionKey,
              p.personalityId,
            );
            this.lastTurnAt = Date.now();
            return { jsonrpc: '2.0', id, result: { text, turnCount } };
          } finally {
            this.busySessions.delete(p.sessionKey);
          }
        }

        case 'session/registerMcpServers': {
          const p = req.params as {
            servers: McpServerConfig[];
            personalityId?: string;
            sessionKey?: string;
          };
          const result = await this.handleRegisterMcpServers(p);
          return { jsonrpc: '2.0', id, result };
        }

        case 'session/end': {
          const p = req.params as { sessionKey: string };
          await this.handleSessionEnd(p.sessionKey);
          return { jsonrpc: '2.0', id, result: { ok: true } };
        }

        case 'mesh.register': {
          const p = req.params as Omit<MeshEntry, 'registeredAt' | 'lastHeartbeatAt'>;
          if (!this.mesh)
            return { jsonrpc: '2.0', id, error: { code: -32000, message: 'Mesh not configured' } };
          await this.mesh.register(p);
          return { jsonrpc: '2.0', id, result: { ok: true } };
        }

        case 'mesh.status':
          return {
            jsonrpc: '2.0',
            id,
            result: { agents: this.mesh ? await this.mesh.list() : [] },
          };

        case 'notify': {
          const p = req.params as { kind: string; ref?: string; mode?: string };
          if (!p.kind || typeof p.kind !== 'string') {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'kind is required' } };
          }
          if (p.mode === 'notify') {
            await this.deliverPassiveNotify(p.kind, p.ref).catch(() => {});
            return { jsonrpc: '2.0', id, result: { ok: true, queued: this.lane.length } };
          }
          const prompt = renderNotifyPrompt(p.kind, p.ref);
          const sessionKey = `notify:${p.kind}:${Date.now()}`;
          void this.lane.enqueue(async (_signal) => {
            await this.runBlocking(prompt, sessionKey).catch(() => {});
          });
          return { jsonrpc: '2.0', id, result: { ok: true, queued: this.lane.length } };
        }

        case 'spawn': {
          if (!this.jobStore || !this.backgroundExecutor) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: 'Background jobs are not enabled on this agent' },
            };
          }
          const p = req.params as {
            text: string;
            personalityId?: string;
            label?: string;
            maxCostUsd?: number | null;
          };
          if (!p.text || typeof p.text !== 'string') {
            return { jsonrpc: '2.0', id, error: { code: -32602, message: 'text is required' } };
          }
          const sk = `acp:${randomUUID()}`;
          const label = sanitizeJobLabel(p.label);
          const job = await this.jobStore.create({
            owner: this.backgroundExecutor.owner,
            parentSessionKey: sk,
            rootSessionKey: sk,
            childSessionKey: `${sk}:job`,
            depth: 0,
            prompt: p.text,
            ...(p.personalityId ? { personalityId: p.personalityId } : {}),
            ...(label ? { label } : {}),
            ...(typeof p.maxCostUsd === 'number' ? { maxCostUsd: p.maxCostUsd } : {}),
          });
          this.backgroundExecutor.nudge();
          return { jsonrpc: '2.0', id, result: { jobId: job.id, status: job.status } };
        }

        case 'job_status': {
          if (!this.jobStore) {
            return {
              jsonrpc: '2.0',
              id,
              error: { code: -32000, message: 'Background jobs are not enabled on this agent' },
            };
          }
          const p = req.params as { jobId: string };
          const job = await this.jobStore.get(p.jobId);
          if (!job) return { jsonrpc: '2.0', id, result: { found: false } };
          return {
            jsonrpc: '2.0',
            id,
            result: {
              found: true,
              status: job.status,
              summary: job.summary ?? null,
              error: job.error ?? null,
              spendUsd: job.spendUsd,
            },
          };
        }

        default:
          return {
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${req.method}` },
          };
      }
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  private handleWsConnection(ws: WebSocket): void {
    const send = (msg: object) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
    };
    const abortControllers = new Map<Id, AbortController>();
    const ownedSessionKeys = new Set<string>();

    ws.on('message', (data) => {
      let req: Request;
      try {
        req = JSON.parse(data.toString()) as Request;
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (req.id !== undefined) {
        void this.dispatch(req, send, abortControllers, ownedSessionKeys).catch(() => {});
      }
    });

    ws.on('close', () => {
      for (const ac of abortControllers.values()) ac.abort();
      void this.teardownOwnedSessions(ownedSessionKeys);
    });
  }

  // ---------------------------------------------------------------------------
  // Core dispatch — used by both stdio and WebSocket transports
  // ---------------------------------------------------------------------------

  private async dispatch(
    req: Request,
    send: (msg: object) => void,
    abortControllers?: Map<Id, AbortController>,
    /** Session keys granted over this connection — torn down when it closes. */
    ownedSessionKeys?: Set<string>,
  ): Promise<void> {
    const id = req.id ?? null;
    const controllers = abortControllers ?? this.abortControllers;

    const sendResult = (result: unknown) => send({ jsonrpc: '2.0', id, result });
    const sendError = (code: number, message: string) =>
      send({ jsonrpc: '2.0', id, error: { code, message } });
    const sendStream = (event: AgentEvent) =>
      send({ jsonrpc: '2.0', method: '$/stream', params: { requestId: id, event } });

    try {
      switch (req.method) {
        case 'initialize':
          sendResult({
            protocolVersion: '1.0',
            serverName: 'ethos',
            capabilities: { streaming: true },
          });
          break;

        case 'new_session':
          sendResult({
            sessionKey: `acp:${randomUUID()}`,
            personalityId:
              (req.params as { personalityId?: string } | undefined)?.personalityId ?? null,
          });
          break;

        case 'prompt': {
          const p = req.params as { sessionKey: string; text: string; personalityId?: string };
          if (this.busySessions.has(p.sessionKey)) {
            sendError(-32000, `Session ${p.sessionKey} has a prompt in progress`);
            return;
          }
          const ac = new AbortController();
          controllers.set(id, ac);
          this.busySessions.add(p.sessionKey);
          try {
            let fullText = '';
            let turnCount = 0;
            for await (const event of this.runner.run(p.text, {
              sessionKey: p.sessionKey,
              personalityId: p.personalityId,
              abortSignal: ac.signal,
            })) {
              if (event.type === 'done') {
                turnCount = event.turnCount as number;
              } else {
                if (event.type === 'text_delta') fullText += event.text as string;
                sendStream(event);
              }
            }
            this.lastTurnAt = Date.now();
            sendResult({ text: fullText, turnCount });
          } finally {
            controllers.delete(id);
            this.busySessions.delete(p.sessionKey);
          }
          break;
        }

        case 'cancel': {
          const p = req.params as { requestId: Id };
          controllers.get(p.requestId)?.abort();
          sendResult({ ok: true });
          break;
        }

        case 'fork_session':
          await this.handleForkSession(id, req.params as { sessionKey: string }, send);
          break;

        case 'resume_session':
          await this.handleResumeSession(id, req.params as { sessionKey: string }, send);
          break;

        case 'session/registerMcpServers': {
          const p = req.params as {
            servers: McpServerConfig[];
            personalityId?: string;
            sessionKey?: string;
          };
          const result = await this.handleRegisterMcpServers(p, ownedSessionKeys);
          sendResult(result);
          break;
        }

        case 'session/end': {
          const p = req.params as { sessionKey: string };
          await this.handleSessionEnd(p.sessionKey);
          sendResult({ ok: true });
          break;
        }

        case 'mesh.register': {
          const p = req.params as Omit<MeshEntry, 'registeredAt' | 'lastHeartbeatAt'>;
          if (!this.mesh) {
            sendError(-32000, 'Mesh not configured');
            return;
          }
          await this.mesh.register(p);
          sendResult({ ok: true });
          break;
        }

        case 'mesh.status':
          sendResult({ agents: this.mesh ? await this.mesh.list() : [] });
          break;

        case 'notify': {
          const p = req.params as { kind: string; ref?: string; mode?: string };
          if (!p.kind || typeof p.kind !== 'string') {
            sendError(-32602, 'kind is required');
            return;
          }
          if (p.mode === 'notify') {
            await this.deliverPassiveNotify(p.kind, p.ref).catch(() => {});
            sendResult({ ok: true, queued: this.lane.length });
            break;
          }
          const prompt = renderNotifyPrompt(p.kind, p.ref);
          const sessionKey = `notify:${p.kind}:${Date.now()}`;
          void this.lane.enqueue(async (_signal) => {
            await this.runBlocking(prompt, sessionKey).catch(() => {});
          });
          sendResult({ ok: true, queued: this.lane.length });
          break;
        }

        case 'spawn': {
          if (!this.jobStore || !this.backgroundExecutor) {
            sendError(-32000, 'Background jobs are not enabled on this agent');
            return;
          }
          const p = req.params as {
            text: string;
            personalityId?: string;
            label?: string;
            maxCostUsd?: number | null;
          };
          if (!p.text || typeof p.text !== 'string') {
            sendError(-32602, 'text is required');
            return;
          }
          const sk = `acp:${randomUUID()}`;
          const label = sanitizeJobLabel(p.label);
          const job = await this.jobStore.create({
            owner: this.backgroundExecutor.owner,
            parentSessionKey: sk,
            rootSessionKey: sk,
            childSessionKey: `${sk}:job`,
            depth: 0,
            prompt: p.text,
            ...(p.personalityId ? { personalityId: p.personalityId } : {}),
            ...(label ? { label } : {}),
            ...(typeof p.maxCostUsd === 'number' ? { maxCostUsd: p.maxCostUsd } : {}),
          });
          this.backgroundExecutor.nudge();
          sendResult({ jobId: job.id, status: job.status });
          break;
        }

        case 'job_status': {
          if (!this.jobStore) {
            sendError(-32000, 'Background jobs are not enabled on this agent');
            return;
          }
          const p = req.params as { jobId: string };
          const job = await this.jobStore.get(p.jobId);
          if (!job) {
            sendResult({ found: false });
            return;
          }
          sendResult({
            found: true,
            status: job.status,
            summary: job.summary ?? null,
            error: job.error ?? null,
            spendUsd: job.spendUsd,
          });
          break;
        }

        default:
          sendError(-32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      sendError(-32000, err instanceof Error ? err.message : String(err));
    }
  }

  // ---------------------------------------------------------------------------
  // Phase 5 — session/registerMcpServers handler
  // ---------------------------------------------------------------------------

  private async handleRegisterMcpServers(
    params: {
      servers: McpServerConfig[];
      personalityId?: string;
      sessionKey?: string;
    },
    ownedSessionKeys?: Set<string>,
  ): Promise<{ registered: string[]; rejected: { name: string; reason: string }[] }> {
    if (!this._createSessionView) {
      return {
        registered: [],
        rejected: params.servers.map((s) => ({
          name: s.name,
          reason: 'MCP session views not configured on this server',
        })),
      };
    }

    const sessionKey = params.sessionKey ?? `acp:ephemeral:${randomUUID()}`;
    const allowlist = this._resolveAllowlist?.(params.personalityId);

    let view = this._sessionViews.get(sessionKey);
    if (!view) {
      if (this._sessionViews.size >= MAX_ACP_SESSIONS) {
        return {
          registered: [],
          rejected: params.servers.map((s) => ({
            name: s.name,
            reason: `Session limit reached (max ${MAX_ACP_SESSIONS})`,
          })),
        };
      }
      view = this._createSessionView();
      this._sessionViews.set(sessionKey, view);
    }
    ownedSessionKeys?.add(sessionKey);

    return view.registerSessionServers(params.servers, allowlist);
  }

  private async handleSessionEnd(sessionKey: string): Promise<void> {
    const view = this._sessionViews.get(sessionKey);
    if (view) {
      await view.teardown();
      this._sessionViews.delete(sessionKey);
    }
  }

  /**
   * Tear down every session view granted over a transport connection that has
   * closed. A client that drops or crashes without sending `session/end` would
   * otherwise leave its granted MCP connections live until process exit, and
   * the orphaned views would keep counting against MAX_ACP_SESSIONS. The
   * connectionless HTTP `/rpc` transport has no such signal — those clients
   * must call `session/end`.
   */
  private async teardownOwnedSessions(sessionKeys: Set<string>): Promise<void> {
    const keys = [...sessionKeys];
    sessionKeys.clear();
    await Promise.allSettled(keys.map((key) => this.handleSessionEnd(key)));
  }

  // ---------------------------------------------------------------------------
  // Session helpers
  // ---------------------------------------------------------------------------

  private async handleForkSession(
    id: Id,
    params: { sessionKey: string },
    send: (msg: object) => void,
  ): Promise<void> {
    const sendResult = (r: unknown) => send({ jsonrpc: '2.0', id, result: r });
    const sendError = (code: number, msg: string) =>
      send({ jsonrpc: '2.0', id, error: { code, message: msg } });

    const source = await this.session.getSessionByKey(params.sessionKey);
    if (!source) {
      sendError(-32000, `Session not found: ${params.sessionKey}`);
      return;
    }

    const messages = await this.session.getMessages(source.id, { limit: 10_000 });
    const newKey = `acp:fork:${randomUUID()}`;

    const forked = await this.session.createSession({
      key: newKey,
      platform: source.platform,
      model: source.model,
      provider: source.provider,
      personalityId: source.personalityId,
      workingDir: source.workingDir,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    });

    for (const msg of messages) {
      await this.session.appendMessage({
        sessionId: forked.id,
        role: msg.role,
        content: msg.content,
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
        toolCalls: msg.toolCalls,
      });
    }

    sendResult({ sessionKey: newKey });
  }

  private async handleResumeSession(
    id: Id,
    params: { sessionKey: string },
    send: (msg: object) => void,
  ): Promise<void> {
    const sendResult = (r: unknown) => send({ jsonrpc: '2.0', id, result: r });
    const s = await this.session.getSessionByKey(params.sessionKey);
    if (!s) {
      sendResult({ exists: false, messageCount: 0 });
      return;
    }
    const messages = await this.session.getMessages(s.id, { limit: 10_000 });
    sendResult({ exists: true, messageCount: messages.length });
  }

  // ---------------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------------

  private async runBlocking(
    text: string,
    sessionKey: string,
    personalityId?: string,
  ): Promise<{ text: string; turnCount: number }> {
    let fullText = '';
    let turnCount = 0;
    for await (const event of this.runner.run(text, { sessionKey, personalityId })) {
      if (event.type === 'text_delta') fullText += event.text as string;
      if (event.type === 'done') turnCount = event.turnCount as number;
      if (event.type === 'error') throw new Error(event.error as string);
    }
    return { text: fullText.trim(), turnCount };
  }

  private send(msg: object): void {
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  // Keep legacy private helpers for stdio compat (still called by start() via dispatch)
  private sendError(id: Id, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * A `label` supplied by a peer is untrusted. Accept it only when it matches the
 * slug shape jobs use internally; otherwise drop it (the job just has no label).
 */
function sanitizeJobLabel(label: unknown): string | undefined {
  return typeof label === 'string' && /^[a-z0-9-]{1,32}$/.test(label) ? label : undefined;
}

function renderNotifyPrompt(kind: string, ref?: string): string {
  if (kind === 'kanban_comment') {
    const target = ref ? `task ${ref}` : 'a task';
    return [
      `A human posted a new comment on kanban ${target}.`,
      ref
        ? `Read the latest discussion with kanban_show passing "${ref}".`
        : 'Read the latest discussion with kanban_show.',
      'Then respond or act on it — reconsider the approach, unblock, or continue the work as the comment directs.',
    ].join(' ');
  }
  // Default + 'kanban' (assignment) — preserve existing generic prompt.
  const parts = [`You have been notified: kind=${kind}`];
  if (ref) parts.push(`ref=${ref}`);
  parts.push('Use your tools to check the relevant state and act on this notification.');
  return parts.join('. ');
}
