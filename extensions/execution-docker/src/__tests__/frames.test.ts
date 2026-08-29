import { describe, expect, it } from 'vitest';
import {
  encodeFrame,
  FrameParser,
  MAX_FRAME_BYTES,
  RpcProtocolError,
  type ShimFrame,
} from '../frames';

describe('encodeFrame / FrameParser round-trip', () => {
  it('round-trips a single frame', () => {
    const frame: ShimFrame = { type: 'output', stream: 'stdout', data: 'hello' };
    const parser = new FrameParser();
    expect(parser.push(encodeFrame(frame))).toEqual([frame]);
  });

  it('round-trips multiple frames in one chunk', () => {
    const a: ShimFrame = { type: 'hello', version: 1 };
    const b: ShimFrame = { type: 'rpc_request', id: 1, name: 'read_file', args: { path: '/x' } };
    const parser = new FrameParser();
    expect(parser.push(Buffer.concat([encodeFrame(a), encodeFrame(b)]))).toEqual([a, b]);
  });

  it('reassembles a frame torn byte-by-byte across pushes', () => {
    const frame: ShimFrame = { type: 'output', stream: 'stderr', data: 'torn across chunks' };
    const encoded = encodeFrame(frame);
    const parser = new FrameParser();
    const collected: ShimFrame[] = [];
    for (let i = 0; i < encoded.length; i++) {
      collected.push(...parser.push(encoded.subarray(i, i + 1)));
    }
    expect(collected).toEqual([frame]);
  });

  it('reassembles a multi-byte UTF-8 character split across a chunk boundary', () => {
    const frame: ShimFrame = { type: 'output', stream: 'stdout', data: 'héllo — 日本語' };
    const encoded = encodeFrame(frame);
    // Split inside the payload, guaranteed to tear some multi-byte sequence.
    const parser = new FrameParser();
    const collected: ShimFrame[] = [];
    const mid = encoded.length - 5;
    collected.push(...parser.push(encoded.subarray(0, mid)));
    collected.push(...parser.push(encoded.subarray(mid)));
    expect(collected).toEqual([frame]);
  });

  it('a torn header followed by the rest parses once complete', () => {
    const frame: ShimFrame = { type: 'hello', version: 1 };
    const encoded = encodeFrame(frame);
    const parser = new FrameParser();
    expect(parser.push(encoded.subarray(0, 10))).toEqual([]); // 'Content-Le'
    expect(parser.push(encoded.subarray(10))).toEqual([frame]);
  });
});

describe('FrameParser protocol errors', () => {
  it('throws on non-frame bytes (desync detection)', () => {
    const parser = new FrameParser();
    expect(() => parser.push(Buffer.from('plain interpreter output\n'))).toThrow(RpcProtocolError);
  });

  it('throws on a malformed header', () => {
    const parser = new FrameParser();
    expect(() => parser.push(Buffer.from('Content-Length: nope\r\n\r\n'))).toThrow(
      RpcProtocolError,
    );
  });

  it('throws when a frame exceeds the frame ceiling', () => {
    const parser = new FrameParser(1000);
    expect(() => parser.push(Buffer.from('Content-Length: 5000\r\n\r\n'))).toThrow(
      /frame of 5000 bytes exceeds the 1000-byte frame ceiling/,
    );
  });

  it('throws on a payload that is not valid JSON', () => {
    const parser = new FrameParser();
    expect(() => parser.push(Buffer.from('Content-Length: 3\r\n\r\nnot'))).toThrow(
      /not valid JSON/,
    );
  });

  it('throws on an unknown frame type', () => {
    const parser = new FrameParser();
    const body = JSON.stringify({ type: 'script', version: 1, code: '' }); // host frame, not shim
    expect(() => parser.push(Buffer.from(`Content-Length: ${body.length}\r\n\r\n${body}`))).toThrow(
      /unknown frame type/,
    );
  });

  it('exports a sane default frame ceiling', () => {
    expect(MAX_FRAME_BYTES).toBeGreaterThanOrEqual(1_000_000);
  });
});
