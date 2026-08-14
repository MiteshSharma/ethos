// The stdin PCM capture device — the working default `ethos listen` ships.
//
// Two things can silently ruin an ambient listener and neither shows up as an
// error: frames re-aligned at every chunk boundary (a click the VAD hears as
// speech, every few milliseconds forever), and a device that reports itself
// present when nothing is piped in.

import { PassThrough } from 'node:stream';
import type { WakeFrame } from '@ethosagent/voice-satellite';
import { describe, expect, it } from 'vitest';
import { createStdinPcmDevice, STDIN_DEVICE_ID } from '../lib/stdin-pcm-device';

const SAMPLE_RATE = 16_000;
const FRAME_MS = 20;
const SAMPLES_PER_FRAME = (SAMPLE_RATE * FRAME_MS) / 1000; // 320
const BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2;

function pcm(values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 2);
  for (let i = 0; i < values.length; i++) buf.writeInt16LE(values[i] ?? 0, i * 2);
  return buf;
}

function device(stdin: PassThrough & { isTTY?: boolean }) {
  return createStdinPcmDevice({ stdin, sampleRate: SAMPLE_RATE, frameMs: FRAME_MS });
}

describe('stdin PCM capture device', () => {
  it('emits whole 20ms frames and carries the remainder across chunks', async () => {
    const stdin = new PassThrough();
    const frames: WakeFrame[] = [];
    const dev = device(stdin);
    await dev.start((f) => frames.push(f));

    // One and a half frames, then the other half: exactly the shape a pipe
    // delivers, and exactly where a naive implementation drops a sample.
    const first = pcm(new Array(SAMPLES_PER_FRAME + SAMPLES_PER_FRAME / 2).fill(1000));
    stdin.write(first);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.samples.length).toBe(SAMPLES_PER_FRAME);
    expect(frames[0]?.sampleRate).toBe(SAMPLE_RATE);

    stdin.write(pcm(new Array(SAMPLES_PER_FRAME / 2).fill(-1000)));
    expect(frames).toHaveLength(2);
    // The second frame straddles the boundary: first half from chunk one.
    expect(frames[1]?.samples[0]).toBe(1000);
    expect(frames[1]?.samples[SAMPLES_PER_FRAME - 1]).toBe(-1000);

    await dev.stop();
  });

  it('decodes little-endian regardless of the host byte order', async () => {
    const stdin = new PassThrough();
    const frames: WakeFrame[] = [];
    const dev = device(stdin);
    await dev.start((f) => frames.push(f));

    const values = new Array(SAMPLES_PER_FRAME).fill(0);
    values[0] = -32_768;
    values[1] = 32_767;
    values[2] = 0x0102;
    stdin.write(pcm(values));

    expect(frames[0]?.samples[0]).toBe(-32_768);
    expect(frames[0]?.samples[1]).toBe(32_767);
    expect(frames[0]?.samples[2]).toBe(0x0102);
    await dev.stop();
  });

  it('stops delivering frames after stop()', async () => {
    const stdin = new PassThrough();
    const frames: WakeFrame[] = [];
    const dev = device(stdin);
    await dev.start((f) => frames.push(f));
    stdin.write(Buffer.alloc(BYTES_PER_FRAME));
    expect(frames).toHaveLength(1);

    await dev.stop();
    stdin.write(Buffer.alloc(BYTES_PER_FRAME));
    expect(frames).toHaveLength(1);
  });

  it('enumerates one device when something is piped in', async () => {
    const stdin = new PassThrough();
    const devices = await device(stdin).list();
    expect(devices).toHaveLength(1);
    expect(devices[0]?.id).toBe(STDIN_DEVICE_ID);
    expect(devices[0]?.isDefault).toBe(true);
  });

  it('enumerates NOTHING on a TTY — no pipe means no samples, ever', async () => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    expect(await device(stdin).list()).toEqual([]);
  });
});
