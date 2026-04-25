import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import type { SessionStore } from '@ethosagent/types';

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
// AcpServer — JSON-RPC over NDJSON stdio
//
// Protocol:
//   Request:      {"jsonrpc":"2.0","id":1,"method":"...","params":{...}}\n
//   Notification: {"jsonrpc":"2.0","method":"$/stream","params":{"requestId":1,"event":{...}}}\n
//   Response:     {"jsonrpc":"2.0","id":1,"result":{...}}\n
//   Error:        {"jsonrpc":"2.0","id":1,"error":{"code":-32000,"message":"..."}}\n
// ---------------------------------------------------------------------------

export class AcpServer {
  private readonly runner: AgentRunner;
  private readonly session: SessionStore;
  private readonly input: Readable;
  private readonly output: Writable;
  // tracks AbortControllers for in-flight prompt requests
  private readonly abortControllers = new Map<Id, AbortController>();
  // tracks which sessionKeys have an active prompt to prevent concurrent access
  private readonly busySessions = new Set<string>();

  constructor(config: {
    runner: AgentRunner;
    session: SessionStore;
    input?: Readable;
    output?: Writable;
  }) {
    this.runner = config.runner;
    this.session = config.session;
    this.input = config.input ?? process.stdin;
    this.output = config.output ?? process.stdout;
  }

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
        void this.dispatch(req).catch(() => {});
      }
    });
  }

  private async dispatch(req: Request): Promise<void> {
    const id = req.id ?? null;
    try {
      switch (req.method) {
        case 'initialize':
          this.handleInitialize(id);
          break;
        case 'new_session':
          this.handleNewSession(id, req.params as { personalityId?: string } | undefined);
          break;
        case 'prompt':
          await this.handlePrompt(
            id,
            req.params as { sessionKey: string; text: string; personalityId?: string },
          );
          break;
        case 'cancel':
          this.handleCancel(id, req.params as { requestId: Id });
          break;
        case 'fork_session':
          await this.handleForkSession(id, req.params as { sessionKey: string });
          break;
        case 'resume_session':
          await this.handleResumeSession(id, req.params as { sessionKey: string });
          break;
        default:
          this.sendError(id, -32601, `Method not found: ${req.method}`);
      }
    } catch (err) {
      this.sendError(id, -32000, err instanceof Error ? err.message : String(err));
    }
  }

  private handleInitialize(id: Id): void {
    this.sendResult(id, {
      protocolVersion: '1.0',
      serverName: 'ethos',
      capabilities: { streaming: true },
    });
  }

  private handleNewSession(id: Id, params?: { personalityId?: string }): void {
    this.sendResult(id, {
      sessionKey: `acp:${randomUUID()}`,
      personalityId: params?.personalityId ?? null,
    });
  }

  private async handlePrompt(
    id: Id,
    params: { sessionKey: string; text: string; personalityId?: string },
  ): Promise<void> {
    const { sessionKey, text, personalityId } = params;

    if (this.busySessions.has(sessionKey)) {
      this.sendError(id, -32000, `Session ${sessionKey} has a prompt in progress`);
      return;
    }

    const ac = new AbortController();
    this.abortControllers.set(id, ac);
    this.busySessions.add(sessionKey);

    try {
      let fullText = '';
      let turnCount = 0;

      for await (const event of this.runner.run(text, {
        sessionKey,
        personalityId,
        abortSignal: ac.signal,
      })) {
        if (event.type === 'done') {
          turnCount = event.turnCount as number;
        } else {
          if (event.type === 'text_delta') fullText += event.text as string;
          this.sendStream(id, event);
        }
      }

      this.sendResult(id, { text: fullText, turnCount });
    } finally {
      this.abortControllers.delete(id);
      this.busySessions.delete(sessionKey);
    }
  }

  private handleCancel(id: Id, params: { requestId: Id }): void {
    this.abortControllers.get(params.requestId)?.abort();
    this.sendResult(id, { ok: true });
  }

  private async handleForkSession(id: Id, params: { sessionKey: string }): Promise<void> {
    const source = await this.session.getSessionByKey(params.sessionKey);
    if (!source) {
      this.sendError(id, -32000, `Session not found: ${params.sessionKey}`);
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

    this.sendResult(id, { sessionKey: newKey });
  }

  private async handleResumeSession(id: Id, params: { sessionKey: string }): Promise<void> {
    const s = await this.session.getSessionByKey(params.sessionKey);
    if (!s) {
      this.sendResult(id, { exists: false, messageCount: 0 });
      return;
    }
    const messages = await this.session.getMessages(s.id, { limit: 10_000 });
    this.sendResult(id, { exists: true, messageCount: messages.length });
  }

  private send(msg: object): void {
    this.output.write(`${JSON.stringify(msg)}\n`);
  }

  private sendResult(id: Id, result: unknown): void {
    this.send({ jsonrpc: '2.0', id, result });
  }

  private sendError(id: Id, code: number, message: string): void {
    this.send({ jsonrpc: '2.0', id, error: { code, message } });
  }

  private sendStream(requestId: Id, event: AgentEvent): void {
    this.send({ jsonrpc: '2.0', method: '$/stream', params: { requestId, event } });
  }
}
