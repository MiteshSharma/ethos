import type { ExecRpcResponse } from '@ethosagent/types';

/**
 * Framed stdio RPC protocol (tools-as-code-api Lane A).
 *
 * LSP-style `Content-Length` frames multiplexed over the container's
 * stdin/stdout. The shim — delivered at exec time, never baked into the
 * digest-pinned runtime images — owns the interpreter's stdout via pipe, so
 * only shim-emitted frames are ever parsed (frame-desync mitigation: a script
 * printing bytes that look like a frame header goes through the shim's output
 * pipe and arrives wrapped in an `output` frame, not as a raw frame).
 *
 * Wire layout, both directions:
 *
 *   Content-Length: <n>\r\n\r\n<n bytes of UTF-8 JSON>
 *
 * The shim's first frame is `hello` carrying its protocol version; the host
 * refuses a mismatch with an actionable error. The host's first frame is
 * `script` (the code to run). After that: `output` / `rpc_request` flow
 * shim→host, `rpc_response` flows host→shim, one in-flight call at a time
 * (serialized v1 contract — the serialization lives in the shim's client).
 */
export const RPC_PROTOCOL_VERSION = 1;

/**
 * Host-side ceiling on a single frame's payload. RPC traffic is deliberately
 * NOT subject to the exec output byte ceiling (that counts only `output`
 * frames — Lane A/D demux), so the frame parser needs its own bound to keep
 * host memory finite while buffering a torn frame.
 */
export const MAX_FRAME_BYTES = 8_000_000;

export class RpcProtocolError extends Error {
  readonly code = 'RPC_PROTOCOL';
  constructor(message: string) {
    super(`Shim RPC protocol error: ${message}`);
    this.name = 'RpcProtocolError';
  }
}

export class RpcVersionMismatchError extends Error {
  readonly code = 'RPC_VERSION_MISMATCH';
  constructor(hostVersion: number, shimVersion: unknown) {
    super(
      `Shim protocol version mismatch: host speaks v${hostVersion}, shim sent v${String(shimVersion)}. ` +
        'The shim source is delivered at exec time and must match RPC_PROTOCOL_VERSION in ' +
        '@ethosagent/execution-docker — update the caller that built the shim command ' +
        '(see buildShimCommand in @ethosagent/tools-code).',
    );
    this.name = 'RpcVersionMismatchError';
  }
}

/** Frames the shim emits on the container's stdout. */
export type ShimFrame =
  | { type: 'hello'; version: number }
  | { type: 'output'; stream: 'stdout' | 'stderr'; data: string }
  | { type: 'rpc_request'; id: number; name: string; args: unknown };

/** Frames the host writes to the container's stdin. */
export type HostFrame =
  | { type: 'script'; version: number; code: string }
  | ({ type: 'rpc_response'; id: number } & ExecRpcResponse);

const HEADER_SEP = Buffer.from('\r\n\r\n', 'ascii');
const HEADER_PREFIX = 'Content-Length:';
/** `Content-Length: ` + digits + CRLFCRLF comfortably fits in 64 bytes. */
const MAX_HEADER_BYTES = 64;

const SHIM_FRAME_TYPES = new Set(['hello', 'output', 'rpc_request']);

export function encodeFrame(payload: HostFrame | ShimFrame): Buffer {
  const body = Buffer.from(JSON.stringify(payload), 'utf-8');
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
}

/**
 * Incremental frame parser. Feed raw stdout chunks (Buffers — parsing happens
 * BEFORE any UTF-8 string conversion so multi-byte characters torn across
 * chunk boundaries survive); get back complete frames. Throws
 * `RpcProtocolError` on desync (bytes that are not a frame header — on a
 * framed stdout that means a shim bug or bytes that bypassed the shim's
 * output pipe) or on an oversized frame.
 */
export class FrameParser {
  private buf: Buffer = Buffer.alloc(0);
  private readonly maxFrameBytes: number;

  constructor(maxFrameBytes: number = MAX_FRAME_BYTES) {
    this.maxFrameBytes = maxFrameBytes;
  }

  push(chunk: Buffer): ShimFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: ShimFrame[] = [];
    while (true) {
      const sep = this.buf.indexOf(HEADER_SEP);
      if (sep < 0) {
        // No complete header yet — fail fast if what we have cannot be one.
        const probe = this.buf.toString(
          'ascii',
          0,
          Math.min(this.buf.length, HEADER_PREFIX.length),
        );
        if (probe !== HEADER_PREFIX.slice(0, probe.length)) {
          throw new RpcProtocolError(
            `non-frame bytes on the framed stdout: ${JSON.stringify(probe)}`,
          );
        }
        if (this.buf.length > MAX_HEADER_BYTES) {
          throw new RpcProtocolError('unterminated frame header');
        }
        return frames;
      }
      const header = this.buf.toString('ascii', 0, sep);
      const match = /^Content-Length: (\d+)$/.exec(header);
      if (!match) {
        throw new RpcProtocolError(
          `malformed frame header: ${JSON.stringify(header.slice(0, 80))}`,
        );
      }
      const length = Number(match[1]);
      if (length > this.maxFrameBytes) {
        throw new RpcProtocolError(
          `frame of ${length} bytes exceeds the ${this.maxFrameBytes}-byte frame ceiling`,
        );
      }
      const start = sep + HEADER_SEP.length;
      if (this.buf.length < start + length) return frames; // torn payload — keep buffering
      const body = this.buf.subarray(start, start + length);
      this.buf = this.buf.subarray(start + length);
      let parsed: unknown;
      try {
        parsed = JSON.parse(body.toString('utf-8'));
      } catch {
        throw new RpcProtocolError('frame payload is not valid JSON');
      }
      const type =
        typeof parsed === 'object' && parsed !== null
          ? (parsed as { type?: unknown }).type
          : undefined;
      if (typeof type !== 'string' || !SHIM_FRAME_TYPES.has(type)) {
        throw new RpcProtocolError(`unknown frame type ${JSON.stringify(type)}`);
      }
      frames.push(parsed as ShimFrame);
    }
  }
}
