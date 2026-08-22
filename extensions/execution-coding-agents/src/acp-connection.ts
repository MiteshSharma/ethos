import type { Logger } from '@ethosagent/types';
import {
  isJsonRpcNotification,
  isJsonRpcRequest,
  isJsonRpcResponse,
  JSON_RPC_METHOD_NOT_FOUND,
  JsonlReader,
  type JsonRpcId,
  type JsonRpcMessage,
} from './acp-protocol';

/**
 * Answers an inbound request from the peer (the agent asking the client to do
 * something — e.g. `session/request_permission`). Reject to send a JSON-RPC
 * error response back; the connection never lets a handler's throw crash the
 * process or leave the peer's request unanswered.
 */
export type AcpRequestHandler = (method: string, params: unknown) => Promise<unknown>;

/** Handles a one-way notification from the peer — e.g. `session/update`. */
export type AcpNotificationHandler = (method: string, params: unknown) => void;

/**
 * The JSON-RPC 2.0 message framing/correlation layer for one ACP connection,
 * independent of how bytes actually move (spawn, pipe, whatever) — mirrors
 * `PiEventTranslator`'s "pure and clock-injected" shape: this class is fully
 * unit-testable by feeding it synthetic lines through `push()`, with no child
 * process, Docker, or real agent involved.
 *
 * Directionality: this side ORIGINATES `initialize`/`session/new`/
 * `session/prompt` requests (via `request()`) and RECEIVES the agent's own
 * requests (`session/request_permission`) and notifications (`session/update`)
 * through the two handlers passed to the constructor.
 */
export class AcpConnection {
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly reader = new JsonlReader();

  constructor(
    private readonly write: (line: string) => void,
    private readonly onRequest: AcpRequestHandler,
    private readonly onNotification: AcpNotificationHandler,
    private readonly logger?: Logger,
  ) {}

  /** Feed one already-decoded chunk of the peer's stdout. */
  push(chunk: string): void {
    for (const line of this.reader.push(chunk)) this.handleLine(line);
  }

  /** Send a request to the peer; resolves/rejects when its response arrives. */
  request<T>(method: string, params?: unknown): Promise<T> {
    const id = this.nextId++;
    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    });
    this.send({ jsonrpc: '2.0', id, method, params });
    return promise;
  }

  /** Send a one-way notification to the peer. Nothing correlates a reply. */
  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, params });
  }

  /**
   * Reject every still-outstanding request (host teardown / abort) so a
   * caller awaiting `request()` is never left hanging past the connection's
   * own lifetime.
   */
  rejectAllPending(reason: Error): void {
    for (const [, entry] of this.pending) entry.reject(reason);
    this.pending.clear();
  }

  private handleLine(line: string): void {
    let msg: JsonRpcMessage;
    try {
      msg = JSON.parse(line) as JsonRpcMessage;
    } catch {
      this.logger?.debug('acp connection: unparseable line', { line: line.slice(0, 200) });
      return;
    }

    if (isJsonRpcRequest(msg)) {
      const { id, method, params } = msg;
      void this.onRequest(method, params).then(
        (result) => this.send({ jsonrpc: '2.0', id, result }),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger?.warn('acp connection: request handler failed; answering with an error', {
            method,
            error: message,
          });
          this.send({
            jsonrpc: '2.0',
            id,
            error: { code: JSON_RPC_METHOD_NOT_FOUND, message },
          });
        },
      );
      return;
    }

    if (isJsonRpcNotification(msg)) {
      this.onNotification(msg.method, msg.params);
      return;
    }

    if (isJsonRpcResponse(msg)) {
      const entry = this.pending.get(msg.id);
      if (!entry) {
        this.logger?.debug('acp connection: response for an unknown/already-settled id', {
          id: msg.id,
        });
        return;
      }
      this.pending.delete(msg.id);
      if ('error' in msg) entry.reject(new Error(msg.error.message));
      else entry.resolve(msg.result);
    }
  }

  private send(msg: JsonRpcMessage): void {
    this.write(`${JSON.stringify(msg)}\n`);
  }
}
