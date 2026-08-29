import type { Speaker, TranscriptEntry } from '@ethosagent/platform-callcapture';
import { defaultAlwaysDeny, InMemoryStorage, ScopedStorage } from '@ethosagent/storage-fs';
import type {
  LLMProvider,
  MemoryContext,
  MemoryProvider,
  MemoryUpdate,
  Message,
  PcmChunk,
  Storage,
  StorageDirEntry,
  StorageRemoveOptions,
  StorageWriteOptions,
  StreamingSttProvider,
} from '@ethosagent/types';
import { STT_CONTRACT_VERSION } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { CallCaptureToolsOptions, CaptureBoundary, RunCallCaptureInput } from '../index';
import { runCallCapture } from '../index';

const SAMPLE_RATE = 16_000;
const MIC_MARKER = 111;
const TAP_MARKER = 222;
const FIXED_STARTED_AT = new Date('2026-08-16T14:30:22.123Z').getTime();

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

function pcmChunk(value: number, samples: number): PcmChunk {
  return { data: new Int16Array(samples).fill(value), sampleRate: SAMPLE_RATE };
}

/** A capture stream backed by a fixed set of pre-loaded chunks. After the
 * chunks are drained it does not end the stream on its own — it hangs
 * (still "capturing") until `.stop()` is called, the same way a live tap/mic
 * stream would keep flowing until the call actually ends. This lets tests
 * assert that an abort mid-capture still flushes whatever was captured
 * rather than discarding it. */
function makeControllableStream(chunks: PcmChunk[]): {
  stream: AsyncGenerator<PcmChunk>;
  stop: () => void;
} {
  let resolveStop: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    resolveStop = resolve;
  });
  async function* generate(): AsyncGenerator<PcmChunk> {
    for (const chunk of chunks) yield chunk;
    await stopped;
  }
  return { stream: generate(), stop: () => resolveStop?.() };
}

class FakeCaptureBoundary implements CaptureBoundary {
  startCalled = false;
  stopCalled = false;
  private readonly controllable: ReturnType<typeof makeControllableStream>;

  constructor(chunks: PcmChunk[]) {
    this.controllable = makeControllableStream(chunks);
  }

  async start(): Promise<AsyncIterable<PcmChunk>> {
    this.startCalled = true;
    return this.controllable.stream;
  }

  stop(): void {
    this.stopCalled = true;
    this.controllable.stop();
  }
}

/** Distinguishes mic vs. tap windows by the constant PCM value each stream
 * was filled with (see `pcmChunk` above) rather than by which generator
 * called it — `runTranscriptSession` already assigns the "you"/"other"
 * speaker label per stream; this fake only needs to produce recognizable text. */
function createFakeStt(): StreamingSttProvider {
  return {
    name: 'fake-stt',
    caps: { kind: 'stt', formats: ['pcm'], streaming: true, contractVersion: STT_CONTRACT_VERSION },
    async transcribeBuffer() {
      throw new Error('transcribeBuffer should not be called — streaming path only');
    },
    async *transcribeStream(audio) {
      let firstSample: number | undefined;
      for await (const chunk of audio) {
        if (firstSample === undefined) firstSample = chunk.data[0];
      }
      const text =
        firstSample === MIC_MARKER
          ? 'this is my update'
          : firstSample === TAP_MARKER
            ? 'this is their update'
            : '';
      yield { text, isFinal: true };
    },
  };
}

function createFakeLlmProvider(summaryText: string): { provider: LLMProvider; calls: Message[][] } {
  const calls: Message[][] = [];
  const provider: LLMProvider = {
    name: 'fake-llm',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages) {
      calls.push(messages);
      yield { type: 'text_delta', text: summaryText };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 0;
    },
  };
  return { provider, calls };
}

function createThrowingLlmProvider(message: string): LLMProvider {
  return {
    name: 'throwing-llm',
    model: 'fake-model',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    // biome-ignore lint/correctness/useYield: the throw before any yield is the point
    async *complete() {
      throw new Error(message);
    },
    async countTokens() {
      return 0;
    },
  };
}

class RecordingMemory implements MemoryProvider {
  readonly synced: Array<{ updates: MemoryUpdate[]; ctx: MemoryContext }> = [];
  async prefetch() {
    return null;
  }
  async read() {
    return null;
  }
  async search() {
    return [];
  }
  async sync(updates: MemoryUpdate[], ctx: MemoryContext): Promise<void> {
    this.synced.push({ updates, ctx });
  }
  async list() {
    return [];
  }
}

function inputWith(
  signal: AbortSignal,
  overrides: Partial<RunCallCaptureInput> = {},
): RunCallCaptureInput {
  return {
    scopeId: 'personality:notes',
    sessionId: 's1',
    sessionKey: 'k1',
    platform: 'callcapture',
    workingDir: '/tmp',
    abortSignal: signal,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Availability
// ---------------------------------------------------------------------------

describe('runCallCapture — availability', () => {
  it('reports unavailable when not configured', async () => {
    const controller = new AbortController();
    const result = await runCallCapture({}, inputWith(controller.signal));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });
});

// ---------------------------------------------------------------------------
// Capture -> transcript -> memory write
// ---------------------------------------------------------------------------

describe('runCallCapture — capture flow', () => {
  it('captures both streams, writes the transcript+summary artifact, and appends the digest index', async () => {
    const tap = new FakeCaptureBoundary([pcmChunk(TAP_MARKER, SAMPLE_RATE)]); // exactly one 1000ms window
    const mic = new FakeCaptureBoundary([pcmChunk(MIC_MARKER, SAMPLE_RATE)]);
    const memory = new RecordingMemory();
    const { provider: llm, calls: llmCalls } = createFakeLlmProvider(
      'Discussed the roadmap. Agreed to ship Friday.',
    );

    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createFakeStt(),
      memory,
      getSummaryProvider: async () => llm,
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const audioLevels: Array<{ speaker: Speaker; level: number; at: number }> = [];
    const controller = new AbortController();
    const resultPromise = runCallCapture(
      opts,
      inputWith(controller.signal, {
        source: 'Zoom',
        onAudioLevel: (speaker, level, at) => audioLevels.push({ speaker, level, at }),
      }),
    );
    controller.abort();
    const result = await resultPromise;

    expect(tap.startCalled).toBe(true);
    expect(mic.startCalled).toBe(true);
    expect(tap.stopCalled).toBe(true);
    expect(mic.stopCalled).toBe(true);

    // Supplying onAudioLevel is purely additive — the tap doesn't alter what
    // reaches the transcript pipeline. One chunk per stream here, so exactly
    // one 'you' and one 'other' reading, both plausible (0 < level <= 1).
    expect(audioLevels).toHaveLength(2);
    const youLevel = audioLevels.find((a) => a.speaker === 'you');
    const otherLevel = audioLevels.find((a) => a.speaker === 'other');
    expect(youLevel).toBeDefined();
    expect(otherLevel).toBeDefined();
    if (youLevel) {
      expect(youLevel.level).toBeGreaterThan(0);
      expect(youLevel.level).toBeLessThanOrEqual(1);
    }
    if (otherLevel) {
      expect(otherLevel.level).toBeGreaterThan(0);
      expect(otherLevel.level).toBeLessThanOrEqual(1);
    }

    // Two memory.sync calls: the artifact write, then the digest-index append.
    expect(memory.synced).toHaveLength(2);

    const artifactCall = memory.synced[0];
    const artifactUpdate = artifactCall?.updates[0];
    expect(artifactUpdate?.action).toBe('replace');
    if (artifactUpdate && artifactUpdate.action === 'replace') {
      // <source>-<date>-<time>.md, source lowercased/sanitized from "Zoom".
      expect(artifactUpdate.key).toBe('zoom-2026-08-16-143022123.md');
      expect(artifactUpdate.content).toContain('## Summary');
      expect(artifactUpdate.content).toContain('## Transcript');
      // "You" lines are plain — the operator's own mic, not adversary-controlled.
      expect(artifactUpdate.content).toContain('- **You:** this is my update');
      // "Other participant" lines are wrapped in the untrusted provenance fence.
      expect(artifactUpdate.content).toContain('- **Other participant:** <untrusted');
      expect(artifactUpdate.content).toContain('this is their update');
      expect(artifactUpdate.content).toContain('</untrusted>');
      // The "You" line itself must never appear inside an untrusted fence.
      const untrustedBlockMatch =
        artifactUpdate.content.match(/<untrusted[\s\S]*?<\/untrusted>/g) ?? [];
      for (const block of untrustedBlockMatch) {
        expect(block).not.toContain('this is my update');
      }
      // The LLM-generated summary is wrapped too (may echo the other side).
      expect(artifactUpdate.content).toContain('Discussed the roadmap');
    }

    const digestCall = memory.synced[1];
    const digestUpdate = digestCall?.updates[0];
    expect(digestUpdate?.action).toBe('add');
    if (digestUpdate && digestUpdate.action === 'add') {
      expect(digestUpdate.key).toBe('call-captures-index.md');
      // hasEntries → the short summary is wrapped in the untrusted provenance
      // fence, collapsed onto one physical line (see Fix 3 / artifact.test.ts).
      expect(digestUpdate.content).toContain('<untrusted source="zoom" tool="call-capture">');
      expect(digestUpdate.content).toContain('</untrusted>');
      expect(digestUpdate.content).toContain('Discussed the roadmap.');
      expect(digestUpdate.content).toContain('(see zoom-2026-08-16-143022123.md)');
      expect(digestUpdate.content).not.toContain('\n');
    }

    // The summarizer was called with the transcript body.
    expect(llmCalls).toHaveLength(1);
    const promptContent = llmCalls[0]?.[0]?.content;
    expect(typeof promptContent).toBe('string');
    expect(promptContent as string).toContain('this is my update');

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifactKey).toBe('zoom-2026-08-16-143022123.md');
      expect(result.summary).toContain('Discussed the roadmap');
    }
  });

  it('defaults the source to "call" when no hint is supplied, and sanitizes an unsafe hint', async () => {
    const memory = new RecordingMemory();
    const opts: CallCaptureToolsOptions = {
      tapCapture: new FakeCaptureBoundary([]),
      micCapture: new FakeCaptureBoundary([]),
      sttProvider: createFakeStt(),
      memory,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    const resultPromise = runCallCapture(opts, inputWith(controller.signal));
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.artifactKey).toBe('call-2026-08-16-143022123.md');

    const controller2 = new AbortController();
    const resultPromise2 = runCallCapture(
      opts,
      inputWith(controller2.signal, { source: '../../etc/passwd' }),
    );
    controller2.abort();
    const result2 = await resultPromise2;
    expect(result2.ok).toBe(true);
    if (result2.ok) expect(result2.artifactKey).toBe('etcpasswd-2026-08-16-143022123.md');
  });

  it('falls back to a plain roll-up and surfaces a warning when the LLM summary call fails', async () => {
    const tap = new FakeCaptureBoundary([pcmChunk(TAP_MARKER, SAMPLE_RATE)]);
    const mic = new FakeCaptureBoundary([pcmChunk(MIC_MARKER, SAMPLE_RATE)]);
    const memory = new RecordingMemory();

    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createFakeStt(),
      memory,
      getSummaryProvider: async () => createThrowingLlmProvider('provider unreachable'),
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    const resultPromise = runCallCapture(opts, inputWith(controller.signal, { source: 'meet' }));
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    // Plain roll-up format, not the (unavailable) LLM summary. The failure is
    // surfaced via `warning`, not silently swallowed.
    if (result.ok) {
      expect(result.summary).toContain('transcript line(s) captured');
      expect(result.warning).toContain('LLM summary generation failed');
    }

    const artifactUpdate = memory.synced[0]?.updates[0];
    if (artifactUpdate && artifactUpdate.action === 'replace') {
      expect(artifactUpdate.content).toContain('transcript line(s) captured');
    }
  });

  it('uses the plain roll-up (no LLM call) when no summary provider is configured', async () => {
    const tap = new FakeCaptureBoundary([pcmChunk(TAP_MARKER, SAMPLE_RATE)]);
    const mic = new FakeCaptureBoundary([pcmChunk(MIC_MARKER, SAMPLE_RATE)]);
    const memory = new RecordingMemory();

    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createFakeStt(),
      memory,
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    const resultPromise = runCallCapture(opts, inputWith(controller.signal));
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.summary).toContain('transcript line(s) captured');
  });

  it('an abort mid-capture still saves whatever partial transcript was captured, not nothing', async () => {
    // Half a 1000ms window (8000 samples) on each stream — a trailing
    // partial window that only flushes once the stream is stopped, the same
    // way a call ending mid-sentence would.
    const tap = new FakeCaptureBoundary([pcmChunk(TAP_MARKER, SAMPLE_RATE / 2)]);
    const mic = new FakeCaptureBoundary([pcmChunk(MIC_MARKER, SAMPLE_RATE / 2)]);
    const memory = new RecordingMemory();

    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createFakeStt(),
      memory,
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    const resultPromise = runCallCapture(opts, inputWith(controller.signal, { source: 'teams' }));
    controller.abort(); // the call "ends" mid-window
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    const artifactUpdate = memory.synced[0]?.updates[0];
    expect(artifactUpdate?.action).toBe('replace');
    if (artifactUpdate && artifactUpdate.action === 'replace') {
      expect(artifactUpdate.content).not.toContain('No speech was captured');
      expect(artifactUpdate.content).toContain('- **You:** this is my update');
      expect(artifactUpdate.content).toContain('this is their update');
    }
  });

  it('reports execution_failed without writing to memory when a capture stream fails to start', async () => {
    const memory = new RecordingMemory();
    const failingTap: CaptureBoundary = {
      start: async () => {
        throw new Error('audiotee binary not found');
      },
      stop: () => {},
    };

    const opts: CallCaptureToolsOptions = {
      tapCapture: failingTap,
      micCapture: new FakeCaptureBoundary([]),
      sttProvider: createFakeStt(),
      memory,
    };

    const controller = new AbortController();
    const result = await runCallCapture(opts, inputWith(controller.signal));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('audiotee binary not found');
    }
    expect(memory.synced).toHaveLength(0);
  });

  it('stops the tap stream when the mic stream fails to start after the tap already started (Bug 5)', async () => {
    const memory = new RecordingMemory();
    const tap = new FakeCaptureBoundary([]);
    const failingMic: CaptureBoundary = {
      start: async () => {
        throw new Error('mic-capture binary not found');
      },
      stop: () => {},
    };

    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: failingMic,
      sttProvider: createFakeStt(),
      memory,
    };

    const controller = new AbortController();
    const result = await runCallCapture(opts, inputWith(controller.signal));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('execution_failed');
    expect(memory.synced).toHaveLength(0);
    // The already-started tap stream must be stopped rather than leaked.
    expect(tap.stopCalled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Documents-tab mirror (plan/phases/call-capture-desktop-ux.md, P4)
// ---------------------------------------------------------------------------

/** Delegates every call to `inner`, recording which of `write`/`writeAtomic`
 * was actually invoked and with what arguments. Used to prove the mirror
 * write goes through `writeAtomic` (finding #7: a crash mid-`write` would
 * leave a truncated `.md` file in the user's real Documents folder). */
class RecordingStorage implements Storage {
  readonly writeAtomicCalls: Array<{ path: string; content: string | Uint8Array }> = [];
  readonly writeCalls: Array<{ path: string; content: string | Uint8Array }> = [];

  constructor(private readonly inner: Storage) {}

  read(path: string) {
    return this.inner.read(path);
  }
  readBytes(path: string) {
    return this.inner.readBytes(path);
  }
  exists(path: string) {
    return this.inner.exists(path);
  }
  mtime(path: string) {
    return this.inner.mtime(path);
  }
  list(dir: string) {
    return this.inner.list(dir);
  }
  listEntries(dir: string): Promise<StorageDirEntry[]> {
    return this.inner.listEntries(dir);
  }
  async write(path: string, content: string | Uint8Array, opts?: StorageWriteOptions) {
    this.writeCalls.push({ path, content });
    return this.inner.write(path, content, opts);
  }
  append(path: string, content: string) {
    return this.inner.append(path, content);
  }
  async writeAtomic(path: string, content: string | Uint8Array, opts?: StorageWriteOptions) {
    this.writeAtomicCalls.push({ path, content });
    return this.inner.writeAtomic(path, content, opts);
  }
  mkdir(dir: string) {
    return this.inner.mkdir(dir);
  }
  remove(path: string, opts?: StorageRemoveOptions) {
    return this.inner.remove(path, opts);
  }
  rename(from: string, to: string) {
    return this.inner.rename(from, to);
  }
  chmod(path: string, mode: number) {
    return this.inner.chmod(path, mode);
  }
}

describe('runCallCapture — Documents mirror', () => {
  it('mirrors the transcript artifact into fs_reach.workdir/call-captures via writeAtomic on a scoped boundary, but not the digest index', async () => {
    const tap = new FakeCaptureBoundary([pcmChunk(TAP_MARKER, SAMPLE_RATE)]);
    const mic = new FakeCaptureBoundary([pcmChunk(MIC_MARKER, SAMPLE_RATE)]);
    const memory = new RecordingMemory();
    const inMemory = new InMemoryStorage();
    await inMemory.mkdir('/workdir');
    const recording = new RecordingStorage(inMemory);
    // Mirrors production wiring (build-agent-loop.ts): `runCallCapture` must
    // receive a Storage already confined to `documentsWorkdir` via
    // `ScopedStorage`, not a bare unscoped store.
    const storage = new ScopedStorage(recording, {
      read: ['/workdir'],
      write: ['/workdir'],
      alwaysDeny: defaultAlwaysDeny(),
    });

    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createFakeStt(),
      memory,
      storage,
      documentsWorkdir: '/workdir',
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    const resultPromise = runCallCapture(opts, inputWith(controller.signal, { source: 'Zoom' }));
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.artifactKey).toBe('zoom-2026-08-16-143022123.md');

    // The write went through writeAtomic, never write — a partial write must
    // never leave a truncated artifact behind.
    expect(recording.writeCalls).toHaveLength(0);
    expect(recording.writeAtomicCalls).toHaveLength(1);
    expect(recording.writeAtomicCalls[0]?.path).toBe(
      '/workdir/call-captures/zoom-2026-08-16-143022123.md',
    );

    // Same content as the memory-scope artifact write.
    const memoryArtifact = memory.synced[0]?.updates[0];
    const mirrored = await storage.read('/workdir/call-captures/zoom-2026-08-16-143022123.md');
    expect(mirrored).not.toBeNull();
    if (memoryArtifact && memoryArtifact.action === 'replace') {
      expect(mirrored).toBe(memoryArtifact.content);
    }

    // The digest index is memory-scope only — never mirrored.
    const entries = await storage.list('/workdir/call-captures');
    expect(entries).toEqual(['zoom-2026-08-16-143022123.md']);
    expect(await storage.exists('/workdir/call-captures-index.md')).toBe(false);
  });

  it('skips the mirror write gracefully when documentsWorkdir is not configured', async () => {
    const tap = new FakeCaptureBoundary([pcmChunk(TAP_MARKER, SAMPLE_RATE)]);
    const mic = new FakeCaptureBoundary([pcmChunk(MIC_MARKER, SAMPLE_RATE)]);
    const memory = new RecordingMemory();
    const storage = new InMemoryStorage();

    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createFakeStt(),
      memory,
      storage, // storage present, but no documentsWorkdir — must not throw
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    const resultPromise = runCallCapture(opts, inputWith(controller.signal, { source: 'Zoom' }));
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    // Memory-scope writes still happen; nothing was ever written to storage.
    expect(memory.synced).toHaveLength(2);
    expect(await storage.list('/')).toEqual([]);
  });

  it('skips the mirror write gracefully when storage is not configured', async () => {
    const tap = new FakeCaptureBoundary([pcmChunk(TAP_MARKER, SAMPLE_RATE)]);
    const mic = new FakeCaptureBoundary([pcmChunk(MIC_MARKER, SAMPLE_RATE)]);
    const memory = new RecordingMemory();

    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createFakeStt(),
      memory,
      documentsWorkdir: '/workdir', // documentsWorkdir present, but no storage — must not throw
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    const resultPromise = runCallCapture(opts, inputWith(controller.signal, { source: 'Zoom' }));
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
    expect(memory.synced).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Live transcript streaming (plan/phases/call-capture-desktop-ux.md, P3)
// ---------------------------------------------------------------------------

/** A fake STT provider that ignores audio content and returns a distinct,
 * incrementing label per `transcribeStream()` call ("window 1", "window 2",
 * ...) — used instead of the shared `createFakeStt` above so this test can
 * tell windows apart by their text, independent of any speaker-marker logic. */
function createSequentialFakeStt(): StreamingSttProvider {
  let calls = 0;
  return {
    name: 'fake-stt-sequential',
    caps: { kind: 'stt', formats: ['pcm'], streaming: true, contractVersion: STT_CONTRACT_VERSION },
    async transcribeBuffer() {
      throw new Error('transcribeBuffer should not be called — streaming path only');
    },
    async *transcribeStream(audio) {
      for await (const _chunk of audio) {
        // Drain — content is irrelevant to this fake.
      }
      calls += 1;
      yield { text: `window ${calls}`, isFinal: true };
    },
  };
}

describe('runCallCapture — live transcript streaming (onEntry)', () => {
  it('fires onEntry once per yielded TranscriptEntry, in the same order they are pushed into the saved transcript', async () => {
    // Two consecutive windows on the tap stream only (mic stream stays empty
    // and never yields before abort) — a single generator, so completion
    // order is strictly window order with no cross-stream merge race to
    // reason about.
    const tap = new FakeCaptureBoundary([
      pcmChunk(TAP_MARKER, SAMPLE_RATE),
      pcmChunk(TAP_MARKER, SAMPLE_RATE),
    ]);
    const mic = new FakeCaptureBoundary([]);
    const memory = new RecordingMemory();

    const liveEntries: TranscriptEntry[] = [];
    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createSequentialFakeStt(),
      memory,
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    const resultPromise = runCallCapture(
      opts,
      inputWith(controller.signal, {
        source: 'meet',
        onEntry: (entry) => liveEntries.push(entry),
      }),
    );
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(true);

    // Exactly one onEntry call per window, in window order.
    expect(liveEntries).toHaveLength(2);
    expect(liveEntries.map((e) => e.text)).toEqual(['window 1', 'window 2']);
    expect(liveEntries.every((e) => e.speaker === 'other')).toBe(true);

    // No divergence between what streamed live and what got saved: the
    // artifact contains both entries, in the same relative order.
    const artifactUpdate = memory.synced[0]?.updates[0];
    expect(artifactUpdate?.action).toBe('replace');
    if (artifactUpdate && artifactUpdate.action === 'replace') {
      const idx1 = artifactUpdate.content.indexOf('window 1');
      const idx2 = artifactUpdate.content.indexOf('window 2');
      expect(idx1).toBeGreaterThan(-1);
      expect(idx2).toBeGreaterThan(idx1);
    }
  });

  it('does not fire onEntry at all when the callback is not supplied (purely additive)', async () => {
    const tap = new FakeCaptureBoundary([pcmChunk(TAP_MARKER, SAMPLE_RATE)]);
    const mic = new FakeCaptureBoundary([pcmChunk(MIC_MARKER, SAMPLE_RATE)]);
    const memory = new RecordingMemory();

    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createFakeStt(),
      memory,
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    // inputWith() omits onEntry by default — this just documents that
    // runCallCapture never assumes it's present.
    const resultPromise = runCallCapture(opts, inputWith(controller.signal, { source: 'meet' }));
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Live audio-level streaming (P2 follow-up: onAudioLevel)
// ---------------------------------------------------------------------------

describe('runCallCapture — live audio-level streaming (onAudioLevel)', () => {
  it('fires onAudioLevel once per PCM chunk on each stream, with the right speaker label and a plausible level', async () => {
    // Two chunks on the tap stream, one on the mic stream — distinguishable
    // counts per stream so the assertion below can tell them apart without
    // relying on interleaving order.
    const tap = new FakeCaptureBoundary([
      pcmChunk(TAP_MARKER, SAMPLE_RATE),
      pcmChunk(TAP_MARKER, SAMPLE_RATE),
    ]);
    const mic = new FakeCaptureBoundary([pcmChunk(MIC_MARKER, SAMPLE_RATE)]);
    const memory = new RecordingMemory();

    const audioLevels: Array<{ speaker: Speaker; level: number; at: number }> = [];
    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createFakeStt(),
      memory,
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    const resultPromise = runCallCapture(
      opts,
      inputWith(controller.signal, {
        source: 'meet',
        onAudioLevel: (speaker, level, at) => audioLevels.push({ speaker, level, at }),
      }),
    );
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(true);

    const youReadings = audioLevels.filter((a) => a.speaker === 'you');
    const otherReadings = audioLevels.filter((a) => a.speaker === 'other');
    expect(youReadings).toHaveLength(1);
    expect(otherReadings).toHaveLength(2);
    for (const reading of audioLevels) {
      expect(reading.level).toBeGreaterThan(0);
      expect(reading.level).toBeLessThanOrEqual(1);
      expect(typeof reading.at).toBe('number');
    }
  });

  it('does not fire onAudioLevel at all when the callback is not supplied (purely additive)', async () => {
    const tap = new FakeCaptureBoundary([pcmChunk(TAP_MARKER, SAMPLE_RATE)]);
    const mic = new FakeCaptureBoundary([pcmChunk(MIC_MARKER, SAMPLE_RATE)]);
    const memory = new RecordingMemory();

    const opts: CallCaptureToolsOptions = {
      tapCapture: tap,
      micCapture: mic,
      sttProvider: createFakeStt(),
      memory,
      windowMs: 1000,
      now: () => FIXED_STARTED_AT,
    };

    const controller = new AbortController();
    // inputWith() omits onAudioLevel by default — this just documents that
    // runCallCapture never assumes it's present.
    const resultPromise = runCallCapture(opts, inputWith(controller.signal, { source: 'meet' }));
    controller.abort();
    const result = await resultPromise;

    expect(result.ok).toBe(true);
  });
});
