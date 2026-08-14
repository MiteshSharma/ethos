import { readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { createFfmpegTranscoder, type FfmpegRunner, type TranscodeStageEvent } from '../transcode';

const INPUT = new Uint8Array([1, 2, 3, 4]);
const OUTPUT = new Uint8Array([9, 8, 7, 6, 5]);
const TEMP_PREFIX = 'ethos-transcode-';

/** How the fake ffmpeg responds to one invocation. */
type Behaviour =
  | { kind: 'wrote'; bytes?: Uint8Array }
  | { kind: 'code'; code: number | null; stderr?: string }
  | { kind: 'timeout' };

function isProbe(args: readonly string[]): boolean {
  return args.includes('-version');
}

/**
 * A fake ffmpeg. `wrote` actually creates the output file (the last arg), which
 * is what the real binary does and what the module reads back.
 */
function fakeFfmpeg(respond: (args: readonly string[]) => Behaviour = defaultRespond) {
  const calls: string[][] = [];
  const run: FfmpegRunner = async (args) => {
    calls.push([...args]);
    const behaviour = respond(args);
    if (behaviour.kind === 'timeout') return { code: null, stderr: '', timedOut: true };
    if (behaviour.kind === 'code') {
      return { code: behaviour.code, stderr: behaviour.stderr ?? '', timedOut: false };
    }
    const outputPath = args.at(-1);
    if (!outputPath) throw new Error('fake ffmpeg: no output path in args');
    await writeFile(outputPath, behaviour.bytes ?? OUTPUT);
    return { code: 0, stderr: '', timedOut: false };
  };
  return { run, calls, conversions: () => calls.filter((c) => !isProbe(c)) };
}

function defaultRespond(args: readonly string[]): Behaviour {
  return isProbe(args) ? { kind: 'code', code: 0 } : { kind: 'wrote' };
}

async function tempLeftovers(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((e) => e.startsWith(TEMP_PREFIX));
}

describe('createFfmpegTranscoder — pass-through', () => {
  it('returns the original bytes without calling ffmpeg when the source is already the target', async () => {
    const fake = fakeFfmpeg();
    const t = createFfmpegTranscoder({ run: fake.run });

    const result = await t.transcode({
      data: INPUT,
      sourceMimeType: 'audio/ogg; codecs=opus',
      targets: ['opus'],
    });

    expect(result).toEqual({
      ok: true,
      data: INPUT,
      format: 'opus',
      mimeType: 'audio/ogg; codecs=opus',
      transcoded: false,
    });
    expect(fake.calls).toHaveLength(0);
  });

  it('treats opus bytes as satisfying an ogg target, but not the reverse', async () => {
    const fake = fakeFfmpeg();
    const t = createFfmpegTranscoder({ run: fake.run });

    const opusToOgg = await t.transcode({
      data: INPUT,
      sourceMimeType: 'audio/ogg; codecs=opus',
      targets: ['ogg'],
    });
    expect(opusToOgg.ok && opusToOgg.transcoded).toBe(false);
    expect(fake.conversions()).toHaveLength(0);

    // A plain .ogg may hold vorbis — an opus target must actually re-encode.
    const oggToOpus = await t.transcode({
      data: INPUT,
      sourceMimeType: 'audio/ogg',
      targets: ['opus'],
    });
    expect(oggToOpus.ok && oggToOpus.transcoded).toBe(true);
    expect(fake.conversions()).toHaveLength(1);
  });
});

describe('createFfmpegTranscoder — conversion', () => {
  it('transcodes to the primary target', async () => {
    const fake = fakeFfmpeg();
    const stages: TranscodeStageEvent[] = [];
    const t = createFfmpegTranscoder({ run: fake.run, onStage: (e) => stages.push(e) });

    const result = await t.transcode({
      data: INPUT,
      sourceMimeType: 'audio/mpeg',
      targets: ['opus'],
    });

    if (!result.ok) throw new Error(`expected success, got ${result.error}`);
    expect(result.data).toEqual(OUTPUT);
    expect(result.format).toBe('opus');
    expect(result.mimeType).toBe('audio/ogg; codecs=opus');
    expect(result.transcoded).toBe(true);
    expect(result.fallbackFrom).toBeUndefined();

    const [args] = fake.conversions();
    expect(args?.slice(0, 5)).toEqual(['-hide_banner', '-loglevel', 'error', '-y', '-i']);
    expect(args?.join(' ')).toContain('-c:a libopus -b:a 32k -ac 1 -ar 48000 -f ogg');
    expect(args?.[5]).toMatch(/\.mp3$/);
    expect(args?.at(-1)).toMatch(/\.ogg$/);

    expect(stages).toEqual([
      {
        from: 'mp3',
        to: 'opus',
        ok: true,
        bytesIn: INPUT.length,
        bytesOut: OUTPUT.length,
        durationMs: expect.any(Number),
      },
    ]);
  });

  it('honours the requested bitrate', async () => {
    const fake = fakeFfmpeg();
    const t = createFfmpegTranscoder({ run: fake.run });

    await t.transcode({ data: INPUT, targets: ['mp3'], bitrateKbps: 64 });

    expect(fake.conversions()[0]?.join(' ')).toContain('-c:a libmp3lame -b:a 64k');
  });

  it('falls back to the next target and reports fallbackFrom', async () => {
    const fake = fakeFfmpeg((args) => {
      if (isProbe(args)) return { kind: 'code', code: 0 };
      if (args.includes('ipod')) return { kind: 'code', code: 1, stderr: 'aac encoder missing' };
      return { kind: 'wrote' };
    });
    const t = createFfmpegTranscoder({ run: fake.run });

    const result = await t.transcode({
      data: INPUT,
      sourceMimeType: 'audio/wav',
      targets: ['m4a', 'mp3'],
    });

    if (!result.ok) throw new Error(`expected success, got ${result.error}`);
    expect(result.format).toBe('mp3');
    expect(result.mimeType).toBe('audio/mpeg');
    expect(result.fallbackFrom).toBe('m4a');
    expect(fake.conversions()).toHaveLength(2);
  });

  it('retries past a timeout, not just a non-zero exit', async () => {
    const fake = fakeFfmpeg((args) => {
      if (isProbe(args)) return { kind: 'code', code: 0 };
      return args.includes('libopus') ? { kind: 'timeout' } : { kind: 'wrote' };
    });
    const t = createFfmpegTranscoder({ run: fake.run });

    const result = await t.transcode({ data: INPUT, targets: ['opus', 'mp3'] });

    expect(result.ok && result.fallbackFrom).toBe('opus');
  });

  it('fails an attempt whose output file is empty', async () => {
    const fake = fakeFfmpeg((args) =>
      isProbe(args) ? { kind: 'code', code: 0 } : { kind: 'wrote', bytes: new Uint8Array() },
    );
    const t = createFfmpegTranscoder({ run: fake.run });

    const result = await t.transcode({ data: INPUT, targets: ['mp3'] });

    expect(result).toMatchObject({ ok: false, code: 'failed' });
  });
});

describe('createFfmpegTranscoder — typed failures', () => {
  it('reports failed with the ffmpeg stderr tail when every target fails', async () => {
    const fake = fakeFfmpeg((args) =>
      isProbe(args)
        ? { kind: 'code', code: 0 }
        : { kind: 'code', code: 1, stderr: 'Invalid data found when processing input' },
    );
    const stages: TranscodeStageEvent[] = [];
    const t = createFfmpegTranscoder({ run: fake.run, onStage: (e) => stages.push(e) });

    const result = await t.transcode({ data: INPUT, targets: ['opus', 'mp3'] });

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('failed');
    expect(result.error).toContain('Invalid data found when processing input');
    expect(stages.map((s) => s.to)).toEqual(['opus', 'mp3']);
    expect(stages.every((s) => !s.ok)).toBe(true);
  });

  it('truncates a huge stderr to 500 characters', async () => {
    const fake = fakeFfmpeg((args) =>
      isProbe(args)
        ? { kind: 'code', code: 0 }
        : { kind: 'code', code: 1, stderr: `${'x'.repeat(2000)}THE REAL ERROR` },
    );
    const t = createFfmpegTranscoder({ run: fake.run });

    const result = await t.transcode({ data: INPUT, targets: ['mp3'] });

    if (result.ok) throw new Error('expected failure');
    expect(result.error).toHaveLength(500);
    expect(result.error.endsWith('THE REAL ERROR')).toBe(true);
  });

  it('reports timeout when the run times out', async () => {
    const fake = fakeFfmpeg((args) =>
      isProbe(args) ? { kind: 'code', code: 0 } : { kind: 'timeout' },
    );
    const t = createFfmpegTranscoder({ run: fake.run, timeoutMs: 1234 });

    const result = await t.transcode({ data: INPUT, targets: ['mp3'] });

    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('timeout');
    expect(result.error).toContain('1234ms');
  });

  it('reports unavailable without attempting a conversion when the probe fails', async () => {
    const fake = fakeFfmpeg((args) =>
      isProbe(args) ? { kind: 'code', code: null, stderr: 'ffmpeg not found' } : { kind: 'wrote' },
    );
    const t = createFfmpegTranscoder({ run: fake.run });

    const result = await t.transcode({ data: INPUT, targets: ['mp3'] });

    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('unavailable');
    expect(fake.conversions()).toHaveLength(0);

    // Pass-through needs no ffmpeg, so it still works on an unavailable host.
    const passed = await t.transcode({
      data: INPUT,
      sourceMimeType: 'audio/mpeg',
      targets: ['mp3'],
    });
    expect(passed).toMatchObject({ ok: true, transcoded: false });
    expect(fake.conversions()).toHaveLength(0);
  });

  it('rejects a silk target with an explanatory message', async () => {
    const fake = fakeFfmpeg();
    const t = createFfmpegTranscoder({ run: fake.run });

    const result = await t.transcode({ data: INPUT, targets: ['silk'] });

    if (result.ok) throw new Error('expected failure');
    expect(result.code).toBe('failed');
    expect(result.error).toContain('silk requires a platform-specific encoder');
    expect(fake.conversions()).toHaveLength(0);
  });

  it('rejects an empty target list', async () => {
    const fake = fakeFfmpeg();
    const t = createFfmpegTranscoder({ run: fake.run });

    const result = await t.transcode({ data: INPUT, targets: [] });

    expect(result).toMatchObject({ ok: false, code: 'failed' });
    expect(fake.calls).toHaveLength(0);
  });
});

describe('createFfmpegTranscoder — housekeeping', () => {
  it('leaves no temp files behind, on success or failure', async () => {
    const before = await tempLeftovers();
    const ok = createFfmpegTranscoder({ run: fakeFfmpeg().run });
    const bad = createFfmpegTranscoder({
      run: fakeFfmpeg((args) =>
        isProbe(args) ? { kind: 'code', code: 0 } : { kind: 'code', code: 1, stderr: 'boom' },
      ).run,
    });

    await ok.transcode({ data: INPUT, sourceMimeType: 'audio/wav', targets: ['opus'] });
    await bad.transcode({ data: INPUT, targets: ['opus', 'mp3'] });

    expect(await tempLeftovers()).toEqual(before);
  });

  it('probes ffmpeg once and caches the answer', async () => {
    const fake = fakeFfmpeg();
    const t = createFfmpegTranscoder({ run: fake.run });

    expect(await t.available()).toBe(true);
    expect(await t.available()).toBe(true);
    await t.transcode({ data: INPUT, targets: ['mp3'] });

    expect(fake.calls.filter(isProbe)).toHaveLength(1);
  });

  it('caches a negative probe too', async () => {
    const fake = fakeFfmpeg((args) =>
      isProbe(args) ? { kind: 'code', code: 127 } : { kind: 'wrote' },
    );
    const t = createFfmpegTranscoder({ run: fake.run });

    expect(await t.available()).toBe(false);
    await t.transcode({ data: INPUT, targets: ['mp3'] });

    expect(fake.calls.filter(isProbe)).toHaveLength(1);
  });
});
