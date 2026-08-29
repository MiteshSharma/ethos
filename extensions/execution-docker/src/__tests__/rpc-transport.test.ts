import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { ExecChunk, ExecOpts, ExecRpcRequest, ExecRpcResponse } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  ExecAbortedError,
  encodeFrame,
  RpcProtocolError,
  RpcVersionMismatchError,
  type ShimFrame,
  streamChild,
  withByteCeiling,
} from '../index';

/** Scripted stand-in for a spawned docker child. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdinChunks: Buffer[] = [];
  stdinEnded = false;
  killedWith: string | null = null;
  stdin = {
    destroyed: false,
    write: (data: Buffer | string): boolean => {
      this.stdinChunks.push(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
  };
  kill(signal?: string): boolean {
    this.killedWith = signal ?? 'SIGTERM';
    return true;
  }
  asChild(): ChildProcess {
    return this as unknown as ChildProcess;
  }
  stdinBytes(): Buffer {
    return Buffer.concat(this.stdinChunks);
  }
}

/** Decode LSP-style frames from the host→shim stdin capture. */
function decodeHostFrames(buf: Buffer): Array<Record<string, unknown>> {
  const frames: Array<Record<string, unknown>> = [];
  let rest = buf;
  while (rest.length > 0) {
    const sep = rest.indexOf('\r\n\r\n');
    if (sep < 0) break;
    const match = /^Content-Length: (\d+)$/.exec(rest.toString('ascii', 0, sep));
    if (!match) throw new Error('malformed host frame in test capture');
    const len = Number(match[1]);
    const start = sep + 4;
    frames.push(JSON.parse(rest.toString('utf-8', start, start + len)));
    rest = rest.subarray(start + len);
  }
  return frames;
}

const tick = () => new Promise<void>((r) => setImmediate(r));

function collect(stream: AsyncIterable<ExecChunk>): {
  chunks: ExecChunk[];
  done: Promise<unknown>;
} {
  const chunks: ExecChunk[] = [];
  const done = (async () => {
    for await (const c of stream) chunks.push(c);
  })();
  // Surface rejections via `done`; callers await or assert on it.
  done.catch(() => {});
  return { chunks, done };
}

const shimFrame = (f: ShimFrame): Buffer => encodeFrame(f);

describe('streamChild — no-RPC path (unchanged behavior)', () => {
  it('passes stdout/stderr through raw and writes-then-ends stdin', async () => {
    const child = new FakeChild();
    const { chunks, done } = collect(
      streamChild(child.asChild(), { stdin: 'print(1)', timeoutMs: 5000 }, () => {}),
    );
    await tick();
    expect(child.stdinBytes().toString('utf-8')).toBe('print(1)');
    expect(child.stdinEnded).toBe(true); // write-then-end, byte-identical path
    child.stdout.emit('data', Buffer.from('raw out'));
    child.stderr.emit('data', Buffer.from('raw err'));
    await tick();
    child.emit('close', 0);
    await done;
    expect(chunks).toEqual([
      { stream: 'stdout', data: 'raw out' },
      { stream: 'stderr', data: 'raw err' },
      { stream: 'exit', code: 0 },
    ]);
  });

  it('does not parse frames: frame-shaped stdout is passed through as bytes', async () => {
    const child = new FakeChild();
    const { chunks, done } = collect(streamChild(child.asChild(), { timeoutMs: 5000 }, () => {}));
    await tick();
    const frameish = shimFrame({ type: 'output', stream: 'stdout', data: 'x' });
    child.stdout.emit('data', frameish);
    await tick();
    child.emit('close', 0);
    await done;
    expect(chunks[0]).toEqual({ stream: 'stdout', data: frameish.toString('utf-8') });
  });
});

describe('streamChild — framed RPC mode', () => {
  const rpcOpts = (
    onRequest: (req: ExecRpcRequest) => Promise<ExecRpcResponse>,
    extra?: Partial<ExecOpts>,
  ): ExecOpts => ({ stdin: 'script-code', timeoutMs: 5000, rpc: { onRequest }, ...extra });

  it('delivers the script as frame 0 and keeps stdin open', async () => {
    const child = new FakeChild();
    const { done } = collect(
      streamChild(
        child.asChild(),
        rpcOpts(async () => ({ ok: true })),
        () => {},
      ),
    );
    await tick();
    expect(decodeHostFrames(child.stdinBytes())).toEqual([
      { type: 'script', version: 1, code: 'script-code' },
    ]);
    expect(child.stdinEnded).toBe(false); // stays open for rpc_response frames
    child.emit('close', 0);
    await done;
    expect(child.stdinEnded).toBe(true); // teardown closes it at stream end
  });

  it('demuxes output frames into chunks and answers rpc_request via onRequest', async () => {
    const child = new FakeChild();
    const seen: ExecRpcRequest[] = [];
    const { chunks, done } = collect(
      streamChild(
        child.asChild(),
        rpcOpts(async (req) => {
          seen.push(req);
          return { ok: true, value: 'tool-result' };
        }),
        () => {},
      ),
    );
    await tick();
    child.stdout.emit('data', shimFrame({ type: 'hello', version: 1 }));
    child.stdout.emit('data', shimFrame({ type: 'output', stream: 'stdout', data: 'before ' }));
    child.stdout.emit(
      'data',
      shimFrame({ type: 'rpc_request', id: 1, name: 'read_file', args: { path: '/x' } }),
    );
    await tick();
    await tick();
    expect(seen).toEqual([{ name: 'read_file', args: { path: '/x' } }]);
    const hostFrames = decodeHostFrames(child.stdinBytes());
    expect(hostFrames[1]).toEqual({ type: 'rpc_response', id: 1, ok: true, value: 'tool-result' });
    child.stdout.emit('data', shimFrame({ type: 'output', stream: 'stderr', data: 'after' }));
    await tick();
    child.emit('close', 0);
    await done;
    expect(chunks).toEqual([
      { stream: 'stdout', data: 'before ' },
      { stream: 'stderr', data: 'after' },
      { stream: 'exit', code: 0 },
    ]);
  });

  it('a throwing onRequest becomes an ok:false rpc_response (errors are data)', async () => {
    const child = new FakeChild();
    const { done } = collect(
      streamChild(
        child.asChild(),
        rpcOpts(async () => {
          throw new Error('handler exploded');
        }),
        () => {},
      ),
    );
    await tick();
    child.stdout.emit('data', shimFrame({ type: 'hello', version: 1 }));
    child.stdout.emit('data', shimFrame({ type: 'rpc_request', id: 7, name: 'x', args: {} }));
    await tick();
    await tick();
    const hostFrames = decodeHostFrames(child.stdinBytes());
    expect(hostFrames[1]).toEqual({
      type: 'rpc_response',
      id: 7,
      ok: false,
      error: 'handler exploded',
      code: 'rpc_handler_error',
    });
    child.emit('close', 1);
    await done;
  });

  it('fails with an actionable error on a protocol version mismatch', async () => {
    const child = new FakeChild();
    let containerKilled = false;
    const { done } = collect(
      streamChild(
        child.asChild(),
        rpcOpts(async () => ({ ok: true })),
        () => {
          containerKilled = true;
        },
      ),
    );
    await tick();
    child.stdout.emit('data', shimFrame({ type: 'hello', version: 99 }));
    await expect(done).rejects.toBeInstanceOf(RpcVersionMismatchError);
    await expect(done).rejects.toThrow(/host speaks v1, shim sent v99/);
    expect(containerKilled).toBe(true);
    expect(child.killedWith).toBe('SIGKILL');
  });

  it('fails when the first frame is not hello', async () => {
    const child = new FakeChild();
    const { done } = collect(
      streamChild(
        child.asChild(),
        rpcOpts(async () => ({ ok: true })),
        () => {},
      ),
    );
    await tick();
    child.stdout.emit('data', shimFrame({ type: 'output', stream: 'stdout', data: 'x' }));
    await expect(done).rejects.toThrow(/first frame must be 'hello'/);
  });

  it('fails on non-frame stdout bytes (desync)', async () => {
    const child = new FakeChild();
    const { done } = collect(
      streamChild(
        child.asChild(),
        rpcOpts(async () => ({ ok: true })),
        () => {},
      ),
    );
    await tick();
    child.stdout.emit('data', Buffer.from('plain interpreter noise'));
    await expect(done).rejects.toBeInstanceOf(RpcProtocolError);
  });

  it('kill mid-RPC: abort rejects the stream promptly with a pending onRequest', async () => {
    const child = new FakeChild();
    const controller = new AbortController();
    const { done } = collect(
      streamChild(
        child.asChild(),
        rpcOpts(() => new Promise<ExecRpcResponse>(() => {}), { signal: controller.signal }),
        () => {},
      ),
    );
    await tick();
    child.stdout.emit('data', shimFrame({ type: 'hello', version: 1 }));
    child.stdout.emit('data', shimFrame({ type: 'rpc_request', id: 1, name: 'hang', args: {} }));
    await tick();
    controller.abort();
    await expect(done).rejects.toBeInstanceOf(ExecAbortedError);
    // The never-resolving handler must not have wedged teardown.
    expect(child.stdinEnded).toBe(true);
  });

  it('timeout mid-RPC rejects the stream while onRequest is pending', async () => {
    const child = new FakeChild();
    const { done } = collect(
      streamChild(
        child.asChild(),
        rpcOpts(() => new Promise<ExecRpcResponse>(() => {}), { timeoutMs: 50 }),
        () => {},
      ),
    );
    await tick();
    child.stdout.emit('data', shimFrame({ type: 'hello', version: 1 }));
    child.stdout.emit('data', shimFrame({ type: 'rpc_request', id: 1, name: 'hang', args: {} }));
    const started = Date.now();
    await expect(done).rejects.toThrow(/timed out/i);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe('byte ceiling counts only output frames (Lane A + Lane D demux)', () => {
  it('a 900KB in-script tool result does not trip a 1MB output ceiling', async () => {
    const child = new FakeChild();
    const bigValue = 'v'.repeat(900_000);
    let ceilingTripped = false;
    const inner = streamChild(
      child.asChild(),
      {
        stdin: 's',
        timeoutMs: 5000,
        rpc: { onRequest: async () => ({ ok: true, value: bigValue }) },
      },
      () => {},
    );
    const { chunks, done } = collect(
      withByteCeiling(inner, 1_000_000, () => {
        ceilingTripped = true;
      }),
    );
    await tick();
    child.stdout.emit('data', shimFrame({ type: 'hello', version: 1 }));
    // 900KB of script output — under the ceiling on its own.
    for (let i = 0; i < 9; i++) {
      child.stdout.emit(
        'data',
        shimFrame({ type: 'output', stream: 'stdout', data: 'o'.repeat(100_000) }),
      );
    }
    // Plus a 900KB tool result crossing host→script. If RPC traffic counted,
    // the total (1.8MB) would trip the 1MB ceiling.
    child.stdout.emit(
      'data',
      shimFrame({ type: 'rpc_request', id: 1, name: 'read_file', args: {} }),
    );
    await tick();
    await tick();
    const hostFrames = decodeHostFrames(child.stdinBytes());
    expect((hostFrames[1] as { value: string }).value).toHaveLength(900_000);
    child.emit('close', 0);
    await done;
    expect(ceilingTripped).toBe(false);
    const outputBytes = chunks
      .filter((c): c is Extract<ExecChunk, { data: string }> => c.stream !== 'exit')
      .reduce((n, c) => n + Buffer.byteLength(c.data), 0);
    expect(outputBytes).toBe(900_000);
  });

  it('a 1MB+ script print still trips the ceiling', async () => {
    const child = new FakeChild();
    let ceilingTripped = false;
    const inner = streamChild(
      child.asChild(),
      { stdin: 's', timeoutMs: 5000, rpc: { onRequest: async () => ({ ok: true }) } },
      () => {},
    );
    const { chunks, done } = collect(
      withByteCeiling(inner, 1_000_000, () => {
        ceilingTripped = true;
      }),
    );
    await tick();
    child.stdout.emit('data', shimFrame({ type: 'hello', version: 1 }));
    for (let i = 0; i < 11; i++) {
      child.stdout.emit(
        'data',
        shimFrame({ type: 'output', stream: 'stdout', data: 'o'.repeat(100_000) }),
      );
      await tick();
    }
    await done;
    expect(ceilingTripped).toBe(true);
    const last = chunks[chunks.length - 1];
    expect(last && last.stream === 'stderr' ? last.data : '').toMatch(/output truncated/);
  });
});
