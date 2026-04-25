import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

// ---------------------------------------------------------------------------
// ACP JSON-RPC types (subset needed by the bridge)
// ---------------------------------------------------------------------------

type RpcId = number;

interface RpcResponse {
  jsonrpc: '2.0';
  id?: RpcId;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
  params?: unknown;
}

interface StreamNotification {
  jsonrpc: '2.0';
  method: '$/stream';
  params: { requestId: RpcId; event: AgentEvent };
}

interface AgentEvent {
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// SendOpts
// ---------------------------------------------------------------------------

export interface SendOpts {
  sessionKey?: string;
  personalityId?: string;
}

// ---------------------------------------------------------------------------
// AcpBridge — spawns `ethos acp` and speaks JSON-RPC over stdio
// ---------------------------------------------------------------------------

export class AcpBridge extends EventEmitter {
  private readonly proc: ChildProcess;
  private nextId = 1;
  private sessionKey = '';
  readonly model: string;
  readonly personality: string;

  // pending prompt requests: id → stream event handler
  private readonly streamHandlers = new Map<RpcId, (event: AgentEvent) => void>();
  // pending call requests: id → { resolve, reject }
  private readonly callHandlers = new Map<
    RpcId,
    { resolve: (result: unknown) => void; reject: (err: Error) => void }
  >();

  private constructor(proc: ChildProcess, model: string, personality: string) {
    super();
    this.proc = proc;
    this.model = model;
    this.personality = personality;
  }

  static async create(cliPath: string, model: string, personality: string): Promise<AcpBridge> {
    const proc = spawn(cliPath, ['acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    const bridge = new AcpBridge(proc, model, personality);
    bridge.wireStdout();

    proc.on('error', (err) => bridge.emit('error', err.message, 'SPAWN_ERROR'));
    proc.stderr?.on('data', () => {}); // drain stderr silently

    // Handshake
    await bridge.call('initialize', {});
    const { sessionKey } = (await bridge.call('new_session', { personalityId: personality })) as {
      sessionKey: string;
    };
    bridge.sessionKey = sessionKey;

    return bridge;
  }

  // ---------------------------------------------------------------------------
  // Public API — same surface as the old EthosBridge
  // ---------------------------------------------------------------------------

  send(input: string, opts: SendOpts = {}): void {
    const id = this.nextId++;
    const sessionKey = opts.sessionKey ?? this.sessionKey;

    this.streamHandlers.set(id, (event) => {
      switch (event.type) {
        case 'text_delta':
          this.emit('text_delta', event.text as string);
          break;
        case 'tool_start':
          this.emit('tool_start', event.toolCallId as string, event.toolName as string);
          break;
        case 'tool_end':
          this.emit(
            'tool_end',
            event.toolCallId as string,
            event.toolName as string,
            event.ok as boolean,
            event.durationMs as number,
          );
          break;
        case 'error':
          this.emit('error', event.error as string, event.code as string);
          break;
      }
    });

    // Resolve when the final result arrives (handled in wireStdout)
    const rid = id;
    this.callHandlers.set(rid, {
      resolve: (result) => {
        this.streamHandlers.delete(rid);
        const r = result as { text: string; turnCount: number };
        this.emit('done', r.text);
      },
      reject: (err) => {
        this.streamHandlers.delete(rid);
        this.emit('error', err.message, 'ACP_ERROR');
      },
    });

    this.write({
      jsonrpc: '2.0',
      id,
      method: 'prompt',
      params: { sessionKey, text: input, personalityId: opts.personalityId },
    });
  }

  newSession(): void {
    void this.call('new_session', { personalityId: this.personality }).then((r) => {
      const { sessionKey } = r as { sessionKey: string };
      this.sessionKey = sessionKey;
    });
  }

  abortTurn(): void {
    // cancel is best-effort — the process keeps running
    void this.call('cancel', { requestId: this.nextId - 1 }).catch(() => {});
  }

  dispose(): void {
    this.removeAllListeners();
    this.proc.kill();
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private wireStdout(): void {
    const rl = createInterface({ input: this.proc.stdout!, terminal: false });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let msg: RpcResponse;
      try {
        msg = JSON.parse(line) as RpcResponse;
      } catch {
        return;
      }

      // Stream notification
      if (msg.method === '$/stream') {
        const n = msg as unknown as StreamNotification;
        const handler = this.streamHandlers.get(n.params.requestId);
        handler?.(n.params.event);
        return;
      }

      // Final response
      if (msg.id !== undefined) {
        const pending = this.callHandlers.get(msg.id as RpcId);
        if (!pending) return;
        this.callHandlers.delete(msg.id as RpcId);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
    });
  }

  private call(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.callHandlers.set(id, { resolve, reject });
      this.write({ jsonrpc: '2.0', id, method, params });
    });
  }

  private write(msg: object): void {
    this.proc.stdin?.write(`${JSON.stringify(msg)}\n`);
  }
}
