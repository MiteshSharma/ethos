import { randomUUID } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { AgentMesh, MeshEntry } from '@ethosagent/agent-mesh';
import type { SessionStore } from '@ethosagent/types';
import { type WebSocket, WebSocketServer } from 'ws';

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

  constructor(config: {
    runner: AgentRunner;
    session: SessionStore;
    input?: Readable;
    output?: Writable;
    mesh?: AgentMesh;
  }) {
    this.runner = config.runner;
    this.session = config.session;
    this.input = config.input ?? process.stdin;
    this.output = config.output ?? process.stdout;
    this.mesh = config.mesh;
  }

  get activeSessionCount(): number {
    return this.busySessions.size;
  }

  // ---------------------------------------------------------------------------
  // Stdio transport (original)
  // ---------------------------------------------------------------------------

  start(): void {
    const rl = createInterface({ input: this.input, terminal: false });
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
        void this.dispatch(req, (msg) => this.send(msg)).catch(() => {});
      }
    });
  }

  // ---------------------------------------------------------------------------
  // HTTP + WebSocket transport (Phase 24)
  // ---------------------------------------------------------------------------

  startHttp(port: number): ReturnType<typeof createHttpServer> {
    const httpServer = createHttpServer((req, res) => {
      void this.handleHttpRequest(req, res).catch((err) => {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    });

    const wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    wss.on('connection', (ws) => this.handleWsConnection(ws));

    httpServer.listen(port);
    return httpServer;
  }

  private async handleHttpRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, activeSessions: this.busySessions.size }));
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
            return { jsonrpc: '2.0', id, result: { text, turnCount } };
          } finally {
            this.busySessions.delete(p.sessionKey);
          }
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

    ws.on('message', (data) => {
      let req: Request;
      try {
        req = JSON.parse(data.toString()) as Request;
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
        return;
      }
      if (req.id !== undefined) {
        void this.dispatch(req, send, abortControllers).catch(() => {});
      }
    });

    ws.on('close', () => {
      for (const ac of abortControllers.values()) ac.abort();
    });
  }

  // ---------------------------------------------------------------------------
  // Core dispatch — used by both stdio and WebSocket transports
  // ---------------------------------------------------------------------------

  private async dispatch(
    req: Request,
    send: (msg: object) => void,
    abortControllers?: Map<Id, AbortController>,
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

        default:
          sendError(-32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      sendError(-32000, err instanceof Error ? err.message : String(err));
    }
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
