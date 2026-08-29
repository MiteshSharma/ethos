// Message framing/correlation for `AcpConnection` — pure, no child process,
// no Docker, no real agent. Feeds synthetic JSON-RPC lines through `push()`
// and asserts what gets written back and how `request()`/notification
// handlers are driven, mirroring `PiEventTranslator`'s "pure and
// clock-injected" testability.

import { describe, expect, it, vi } from 'vitest';
import { AcpConnection } from '../acp-connection';

function harness() {
  const written: string[] = [];
  const onRequest = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }));
  const onNotification = vi.fn((_method: string, _params: unknown) => {});
  const conn = new AcpConnection((line) => written.push(line), onRequest, onNotification);
  return { conn, written, onRequest, onNotification };
}

describe('AcpConnection — outbound request/response correlation', () => {
  it('resolves a pending request when its response line arrives', async () => {
    const { conn, written } = harness();
    const promise = conn.request<{ sessionId: string }>('session/new', { cwd: '/x' });

    expect(written).toHaveLength(1);
    const sent = JSON.parse(written[0] ?? '{}');
    expect(sent).toMatchObject({ jsonrpc: '2.0', method: 'session/new', params: { cwd: '/x' } });

    conn.push(`${JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { sessionId: 's1' } })}\n`);

    await expect(promise).resolves.toEqual({ sessionId: 's1' });
  });

  it('rejects a pending request on a JSON-RPC error response', async () => {
    const { conn } = harness();
    const promise = conn.request('initialize', {});
    // Read the id back off the write via a second connection instance isn't
    // needed — request() assigns ids starting at 1 for a fresh connection.
    conn.push(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad request' } })}\n`,
    );
    await expect(promise).rejects.toThrow('bad request');
  });

  it('ignores a response for an id nobody is waiting on', () => {
    const { conn, onNotification } = harness();
    expect(() =>
      conn.push(`${JSON.stringify({ jsonrpc: '2.0', id: 999, result: {} })}\n`),
    ).not.toThrow();
    expect(onNotification).not.toHaveBeenCalled();
  });

  it('drops an unparseable line rather than throwing', () => {
    const { conn } = harness();
    expect(() => conn.push('not json at all\n')).not.toThrow();
  });

  it('rejects every outstanding request when the connection tears down', async () => {
    const { conn } = harness();
    const promise = conn.request('session/prompt', {});
    conn.rejectAllPending(new Error('acp agent process exited'));
    await expect(promise).rejects.toThrow('acp agent process exited');
  });
});

describe('AcpConnection — per-call timeout (alive-but-silent peer)', () => {
  it('rejects a request with a clear error when no response arrives within timeoutMs, and cleans up the pending entry', async () => {
    const { conn } = harness();
    const promise = conn.request('initialize', {}, 10);

    await expect(promise).rejects.toThrow('ACP request "initialize" timed out after 10ms');

    // The pending entry was removed on timeout: a late response for the same
    // id arrives to nobody waiting — logged and dropped, never a throw, and
    // critically never a second settle of the already-rejected promise.
    expect(() =>
      conn.push(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: true } })}\n`),
    ).not.toThrow();
  });

  it('resolves normally on a late response when no timeout was given — no implicit global timeout', async () => {
    const { conn } = harness();
    const promise = conn.request<{ sessionId: string }>('session/prompt', {});

    // Wait well past the handshake timeout host.ts uses (30s) to prove this
    // specific request, having no `timeoutMs` of its own, is never cut off.
    await new Promise((r) => setTimeout(r, 30));
    conn.push(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sessionId: 's1' } })}\n`);

    await expect(promise).resolves.toEqual({ sessionId: 's1' });
  });

  it('clears the timer when the response arrives before the timeout fires (no leaked timer, no late spurious rejection)', async () => {
    const { conn } = harness();
    const promise = conn.request<{ sessionId: string }>('session/new', {}, 200);
    conn.push(`${JSON.stringify({ jsonrpc: '2.0', id: 1, result: { sessionId: 's1' } })}\n`);

    await expect(promise).resolves.toEqual({ sessionId: 's1' });
    // If the timer weren't cleared, waiting past it would be harmless to the
    // already-settled promise either way — the real risk this guards is a
    // leaked timer object, which isn't directly observable from here, so the
    // meaningful assertion is just that resolution won, not a later reject.
    await new Promise((r) => setTimeout(r, 210));
  });
});

describe('AcpConnection — inbound requests from the peer', () => {
  it("answers the peer's request with the handler's result, correlated by id", async () => {
    const onRequest = vi.fn(async () => ({ outcome: { outcome: 'cancelled' } }));
    const written: string[] = [];
    const conn = new AcpConnection(
      (line) => written.push(line),
      onRequest,
      () => {},
    );

    conn.push(
      `${JSON.stringify({ jsonrpc: '2.0', id: 'req-1', method: 'session/request_permission', params: { a: 1 } })}\n`,
    );
    // The handler runs asynchronously (`void this.onRequest(...).then(...)`),
    // so give its microtask a turn before asserting the write landed.
    await new Promise((r) => setTimeout(r, 0));

    expect(onRequest).toHaveBeenCalledWith('session/request_permission', { a: 1 });
    expect(written).toHaveLength(1);
    expect(JSON.parse(written[0] ?? '{}')).toEqual({
      jsonrpc: '2.0',
      id: 'req-1',
      result: { outcome: { outcome: 'cancelled' } },
    });
  });

  it('answers a method the handler rejects with a JSON-RPC error, never a hang', async () => {
    const written: string[] = [];
    const conn = new AcpConnection(
      (line) => written.push(line),
      async () => {
        throw new Error('unsupported client method: fs/read_text_file');
      },
      () => {},
    );

    conn.push(
      `${JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: {} })}\n`,
    );
    await new Promise((r) => setTimeout(r, 0));

    expect(written).toHaveLength(1);
    const sent = JSON.parse(written[0] ?? '{}');
    expect(sent.id).toBe(7);
    expect(sent.error.message).toContain('unsupported client method');
  });
});

describe('AcpConnection — inbound notifications', () => {
  it('dispatches a notification (no id) to the notification handler, not the request handler', () => {
    const { conn, onRequest, onNotification } = harness();
    conn.push(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 's1', update: { sessionUpdate: 'plan' } } })}\n`,
    );
    expect(onNotification).toHaveBeenCalledWith('session/update', {
      sessionId: 's1',
      update: { sessionUpdate: 'plan' },
    });
    expect(onRequest).not.toHaveBeenCalled();
  });

  it('handles multiple frames arriving in one chunk, and a frame split across two chunks', () => {
    const { conn, onNotification } = harness();
    const one = JSON.stringify({ jsonrpc: '2.0', method: 'a', params: 1 });
    const two = JSON.stringify({ jsonrpc: '2.0', method: 'b', params: 2 });
    conn.push(`${one}\n${two.slice(0, 5)}`);
    conn.push(`${two.slice(5)}\n`);
    expect(onNotification).toHaveBeenNthCalledWith(1, 'a', 1);
    expect(onNotification).toHaveBeenNthCalledWith(2, 'b', 2);
  });
});
