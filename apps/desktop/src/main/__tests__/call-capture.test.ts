import type { TranscriptEntry } from '@ethosagent/platform-callcapture';
import type { WiringConfig } from '@ethosagent/wiring';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// `call-capture.ts` transitively imports `call-capture-notification-gate.ts`,
// which touches `electron` (`BrowserWindow`, `screen`) at module scope — same
// minimal fake used by `call-capture-notification-gate.test.ts`.
vi.mock('electron', () => ({
  BrowserWindow: class {},
  screen: {
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
  },
}));

const pillMock = vi.hoisted(() => ({
  appendCallCaptureTranscriptEntry: vi.fn(),
  appendCallCaptureAudioLevel: vi.fn(),
  onCallCapturePillCloseRequested: vi.fn(),
}));

// `startCallCaptureDesktop` itself is darwin-gated and, in the real world,
// constructs a real `CallCaptureOwnershipManager`/`FsStorage`/native
// binaries — too heavy to run for real here. But its `runCapture` closure
// (the thing that forwards `onEntry`/`onAudioLevel` into `captureRunner`,
// see the "startCallCaptureDesktop — runCapture wiring" describe below) is
// pure wiring worth locking down, so `@ethosagent/platform-callcapture` and
// `@ethosagent/storage-fs` are faked just enough to drive
// `startCallCaptureDesktop` to the point where it constructs the daemon,
// without touching real native binaries, locks, or disk.
const platformCaptureMock = vi.hoisted(() => ({
  daemonOptions: [] as Array<Record<string, unknown>>,
  // #4 (code review) — when true, the fake `CallCaptureOwnershipManager`
  // simulates losing the ownership claim (another process already owns
  // call-capture) instead of claiming it, so tests can verify
  // `startCallCaptureDesktop`'s desktop-specific `onClaimFailed` logging
  // without a real cross-process lock file.
  forceClaimFailure: false,
  claimFailurePid: 4242,
}));

vi.mock('@ethosagent/platform-callcapture', () => ({
  MicActivityDetector: class {},
  NotificationGate: class {},
  checkCallCaptureDependencies: vi.fn(async () => ({ ok: true, missing: [], errors: [] })),
  callCaptureHealthPath: () => '/tmp/ethos-call-capture-test-health.json',
  callCaptureLockPath: () => '/tmp/ethos-call-capture-test.lock',
  CallCaptureOwnershipManager: class {
    private readonly options: {
      onOwnershipClaimed: () => (() => Promise<void> | void) | void;
      onClaimFailed?: (ownerPid: number) => void;
    };
    private stopDaemon: (() => Promise<void> | void) | undefined;
    constructor(options: {
      onOwnershipClaimed: () => (() => Promise<void> | void) | void;
      onClaimFailed?: (ownerPid: number) => void;
    }) {
      this.options = options;
    }
    start() {
      if (platformCaptureMock.forceClaimFailure) {
        this.options.onClaimFailed?.(platformCaptureMock.claimFailurePid);
        return;
      }
      this.stopDaemon = this.options.onOwnershipClaimed() ?? undefined;
    }
    async stop() {
      await this.stopDaemon?.();
    }
  },
  CallCaptureDaemon: class {
    constructor(options: Record<string, unknown>) {
      platformCaptureMock.daemonOptions.push(options);
    }
    start() {}
    stop() {}
  },
}));

vi.mock('@ethosagent/storage-fs', () => ({
  FsStorage: class {
    writeAtomic = vi.fn(async () => {});
    remove = vi.fn(async () => {});
  },
}));

// `startCallCaptureDesktop` also has too heavy and environment-specific to
// unit-test meaningfully here without the fakes above. This file covers the
// exported `desktopCallCaptureIndicator` object's wiring in isolation,
// mocking `./call-capture-pill` so no real `BrowserWindow` needs to be
// driven.
vi.mock('../call-capture-pill', () => ({
  appendCallCaptureTranscriptEntry: pillMock.appendCallCaptureTranscriptEntry,
  appendCallCaptureAudioLevel: pillMock.appendCallCaptureAudioLevel,
  createCallCapturePillStateHandler: vi.fn(),
  onCallCapturePillCloseRequested: pillMock.onCallCapturePillCloseRequested,
}));

import { desktopCallCaptureIndicator, startCallCaptureDesktop } from '../call-capture';

function entry(speaker: TranscriptEntry['speaker'], text: string): TranscriptEntry {
  return { speaker, text, at: 0 };
}

// Covers the design decision documented on `desktopCallCaptureIndicator` in
// `call-capture.ts`: `show`/`hide` are no-ops (pill visibility stays owned by
// `createCallCapturePillStateHandler`'s `onStateChange` handler), while
// `updateTranscript`/`onEndRequested` are real delegates into
// `call-capture-pill.ts`.
describe('desktopCallCaptureIndicator', () => {
  it('show and hide are no-ops', () => {
    expect(() => desktopCallCaptureIndicator.show('zoom')).not.toThrow();
    expect(() => desktopCallCaptureIndicator.hide()).not.toThrow();
    expect(pillMock.appendCallCaptureTranscriptEntry).not.toHaveBeenCalled();
    expect(pillMock.onCallCapturePillCloseRequested).not.toHaveBeenCalled();
  });

  it('updateTranscript delegates to appendCallCaptureTranscriptEntry', () => {
    const transcriptEntry = entry('you', 'hello there');

    desktopCallCaptureIndicator.updateTranscript(transcriptEntry);

    expect(pillMock.appendCallCaptureTranscriptEntry).toHaveBeenCalledWith(transcriptEntry);
  });

  it('onEndRequested delegates to onCallCapturePillCloseRequested', () => {
    const callback = vi.fn();

    desktopCallCaptureIndicator.onEndRequested(callback);

    expect(pillMock.onCallCapturePillCloseRequested).toHaveBeenCalledWith(callback);
  });

  it('updateAudioLevel delegates to appendCallCaptureAudioLevel, dropping the unused `at` timestamp', () => {
    desktopCallCaptureIndicator.updateAudioLevel?.('other', 0.6, 12345);

    expect(pillMock.appendCallCaptureAudioLevel).toHaveBeenCalledWith('other', 0.6);
  });
});

// Regression test for the bug where `runCapture`'s closure destructured only
// 3 of the 4 params `CallCaptureDaemon.handleAccepted` calls it with,
// silently dropping `onAudioLevel` so the pill's audio-level meter never
// animated even though the transcript (`onEntry`) worked fine.
describe('startCallCaptureDesktop — runCapture wiring', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    platformCaptureMock.daemonOptions.length = 0;
    platformCaptureMock.forceClaimFailure = false;
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  it('forwards both onEntry and onAudioLevel from the daemon-provided runCapture closure into captureRunner', async () => {
    const captureRunner = vi.fn(async (_personalityId: string, _opts: Record<string, unknown>) => ({
      ok: true as const,
      artifactKey: 'artifact-1',
      summary: 'summary',
    }));
    const wiringConfig = {
      provider: 'anthropic',
      model: 'test-model',
      apiKey: 'test-key',
      callCapture: { personalityId: 'test-personality' },
    } as unknown as WiringConfig;

    const handle = startCallCaptureDesktop({ wiringConfig, runCallCapture: captureRunner });
    expect(handle).not.toBeNull();

    expect(platformCaptureMock.daemonOptions).toHaveLength(1);
    const runCapture = platformCaptureMock.daemonOptions[0]?.runCapture as (
      abortSignal: AbortSignal,
      source: string | undefined,
      onEntry: (entry: TranscriptEntry) => void,
      onAudioLevel: (speaker: TranscriptEntry['speaker'], level: number, at: number) => void,
    ) => Promise<void>;
    expect(runCapture).toBeInstanceOf(Function);

    const abortController = new AbortController();
    const onEntry = vi.fn();
    const onAudioLevel = vi.fn();

    await runCapture(abortController.signal, 'zoom', onEntry, onAudioLevel);

    expect(captureRunner).toHaveBeenCalledTimes(1);
    const [personalityId, opts] = captureRunner.mock.calls[0] ?? ['', {}];
    expect(personalityId).toBe('test-personality');
    expect(opts.abortSignal).toBe(abortController.signal);
    expect(opts.source).toBe('zoom');
    expect(opts.onEntry).toBe(onEntry);
    expect(opts.onAudioLevel).toBe(onAudioLevel);

    await handle?.stop();
  });
});

// #4 (code review) — a LaunchAgent-hosted `ethos serve`/`ethos gateway` is
// meant to run continuously, so in that common, intentional deployment shape
// desktop loses the ownership claim on every startup and its own capture UI
// never activates. That must be observable, not silent (ARCHITECTURE.md §V
// S7) — `startCallCaptureDesktop` wires `CallCaptureOwnershipManager`'s
// `onClaimFailed` to a desktop-specific one-time `logger.warn` explaining
// the consequence, on top of the ownership manager's own generic
// `logger.info` line.
describe('startCallCaptureDesktop — ownership claim failure logging', () => {
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(() => {
    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    platformCaptureMock.daemonOptions.length = 0;
    platformCaptureMock.forceClaimFailure = false;
    platformCaptureMock.claimFailurePid = 4242;
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    platformCaptureMock.forceClaimFailure = false;
  });

  it('logs a desktop-specific warning naming the owner pid when another process already owns call-capture', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    platformCaptureMock.forceClaimFailure = true;
    platformCaptureMock.claimFailurePid = 4242;
    const wiringConfig = {
      provider: 'anthropic',
      model: 'test-model',
      apiKey: 'test-key',
      callCapture: { personalityId: 'test-personality' },
    } as unknown as WiringConfig;

    const handle = startCallCaptureDesktop({ wiringConfig, runCallCapture: vi.fn() });

    expect(handle).not.toBeNull();
    // No daemon should have been constructed — this process never won the
    // claim.
    expect(platformCaptureMock.daemonOptions).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('4242'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('will not activate'));

    warnSpy.mockRestore();
  });

  it('does not log the claim-failure warning when this process wins the claim', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const wiringConfig = {
      provider: 'anthropic',
      model: 'test-model',
      apiKey: 'test-key',
      callCapture: { personalityId: 'test-personality' },
    } as unknown as WiringConfig;

    const handle = startCallCaptureDesktop({ wiringConfig, runCallCapture: vi.fn() });

    expect(handle).not.toBeNull();
    expect(platformCaptureMock.daemonOptions).toHaveLength(1);
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});
