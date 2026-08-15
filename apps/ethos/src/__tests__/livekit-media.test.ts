import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { LiveKitAudioFrame, LiveKitRoomClient } from '@ethosagent/platform-voice';
import { describe, expect, it } from 'vitest';
import { resolveLiveKitMedia } from '../livekit-media';

// The optional-dependency loader for `@livekit/rtc-node`. Everything here runs
// on a machine WITHOUT that package installed — which is the point: the loader's
// whole job is to make its absence a clean degrade rather than a crash, and to
// tell an operator apart from "you never installed it" the case where they did
// and it will not load.

/** A module object shaped like the slice of `@livekit/rtc-node` the adapter binds to. */
function fakeRtcNode(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  class FakeRoom {
    connect = async (): Promise<void> => {};
    disconnect = async (): Promise<void> => {};
    on = (): void => {};
    off = (): void => {};
    localParticipant = { publishTrack: async (): Promise<void> => {} };
    remoteParticipants = new Map<string, { identity?: string }>();
  }
  return {
    Room: FakeRoom,
    RoomEvent: { TrackSubscribed: 'trackSubscribed', Disconnected: 'disconnected' },
    AudioStream: class {
      async *[Symbol.asyncIterator](): AsyncGenerator<{ data: Int16Array; sampleRate: number }> {}
      close(): void {}
    },
    AudioSource: class {
      captureFrame = async (): Promise<void> => {};
    },
    AudioFrame: class {},
    LocalAudioTrack: { createAudioTrack: () => ({}) },
    TrackPublishOptions: class {},
    TrackSource: { SOURCE_MICROPHONE: 1 },
    TrackKind: { KIND_AUDIO: 1 },
    ...overrides,
  };
}

function moduleNotFound(): Error & { code: string } {
  const err = new Error(
    "Cannot find package '@livekit/rtc-node' imported from /somewhere",
  ) as Error & { code: string };
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

describe('resolveLiveKitMedia', () => {
  it('reports a missing module as a clean degrade with the install hint', async () => {
    const result = await resolveLiveKitMedia({
      importModule: async () => {
        throw moduleNotFound();
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('is not installed');
    expect(result.reason).toContain('pnpm add @livekit/rtc-node');
  });

  it('distinguishes installed-but-unloadable from not-installed', async () => {
    // A native-binary/arch mismatch. Both cases arrive as a rejected import();
    // telling this operator to "install it" would send them down the wrong path.
    const loadFailure = await resolveLiveKitMedia({
      importModule: async () => {
        throw new Error('dlopen failed: wrong ELF class: ELFCLASS32');
      },
    });
    expect(loadFailure.ok).toBe(false);
    if (loadFailure.ok) return;
    expect(loadFailure.reason).toContain('installed but failed to load');
    expect(loadFailure.reason).toContain('platform/architecture');
    // The underlying message survives — it is the only clue to WHICH mismatch.
    expect(loadFailure.reason).toContain('wrong ELF class');
    expect(loadFailure.reason).not.toContain('is not installed');

    const missing = await resolveLiveKitMedia({
      importModule: async () => {
        throw moduleNotFound();
      },
    });
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).not.toBe(loadFailure.reason);
  });

  it('names the missing export when the module loads but is the wrong shape', async () => {
    const mod = fakeRtcNode();
    delete mod.AudioSource;
    const result = await resolveLiveKitMedia({ importModule: async () => mod });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('AudioSource');
    // Never a client that throws on the first frame — that is a mid-call
    // failure where a boot-time reason was available.
    expect(result.reason).toContain('does not export');
  });

  it('rejects a module whose LocalAudioTrack.createAudioTrack is missing', async () => {
    const result = await resolveLiveKitMedia({
      importModule: async () => fakeRtcNode({ LocalAudioTrack: {} }),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('LocalAudioTrack.createAudioTrack');
  });

  it('rejects a non-object module', async () => {
    const result = await resolveLiveKitMedia({ importModule: async () => undefined });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('did not export a module object');
  });

  it('accepts a well-shaped module and returns a structural LiveKitRoomClient', async () => {
    const result = await resolveLiveKitMedia({ importModule: async () => fakeRtcNode() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const client = result.createClient();
    // Structural conformance to the boundary the transport binds to. The
    // `onDisconnected` member is the one the post-call summary depends on: a
    // binding without it can never observe a caller hanging up.
    expect(typeof client.connect).toBe('function');
    expect(typeof client.disconnect).toBe('function');
    expect(typeof client.onRemoteAudio).toBe('function');
    expect(typeof client.publishAudio).toBe('function');
    expect(typeof client.remoteIdentity).toBe('function');
    expect(typeof client.onDisconnected).toBe('function');

    // Assignable to the interface, not merely duck-shaped by accident.
    const typed: LiveKitRoomClient = client;
    expect(typed.remoteIdentity()).toBe('');

    // Subscribe/unsubscribe round-trips without touching the room.
    const frames: LiveKitAudioFrame[] = [];
    const off = typed.onRemoteAudio((f) => frames.push(f));
    expect(typeof off).toBe('function');
    off();

    let hungUp = 0;
    const offClosed = typed.onDisconnected?.(() => {
      hungUp += 1;
    });
    expect(typeof offClosed).toBe('function');
    offClosed?.();
    expect(hungUp).toBe(0);

    await typed.disconnect();
  });

  it('does not report a version when the caller injected the module', async () => {
    // Reporting the installed package's version for a module the caller did NOT
    // load would be a lie in a line whose only job is to be true.
    const result = await resolveLiveKitMedia({ importModule: async () => fakeRtcNode() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.version).toBeUndefined();
  });

  it('resolves against the REAL (absent) dependency without throwing', async () => {
    // The case every non-telephony deployment hits: importing this module and
    // calling the loader on a machine with no `@livekit/rtc-node` must be
    // harmless. Paired with the package.json scan below — the dependency is
    // never declared, so in any checkout it is genuinely absent here.
    const result = await resolveLiveKitMedia();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('@livekit/rtc-node');
  });

  it('is never declared as a dependency in any workspace package.json', () => {
    // The entire point of the loader. `@livekit/rtc-node` ships a per-arch
    // native binary that CI cannot verify without a running livekit-server, so
    // it stays operator-installed; the moment it appears in a manifest, every
    // install everywhere starts downloading and building it — and the test
    // above ("the real dependency is absent") stops meaning anything.
    const repoRoot = join(import.meta.dirname, '..', '..', '..', '..');
    const hit = spawnSync('git', ['grep', '-l', '@livekit/rtc-node', '--', '*package.json'], {
      cwd: repoRoot,
      encoding: 'utf-8',
    });
    // git grep exits 1 with no output when nothing matched — that is the pass.
    expect(hit.stdout.trim()).toBe('');
  });
});
