import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it, vi } from 'vitest';

// Mock electron-store before importing serve (store.ts depends on it)
vi.mock('electron-store', () => ({
  default: class MockStore {
    get(_key: string) {
      return undefined;
    }
  },
}));

// Mock keychain (depends on Electron safeStorage)
vi.mock('../keychain', () => ({
  getKeychainValue: vi.fn().mockResolvedValue(null),
}));

import { getPort, readSharedVoiceAndCallCaptureConfig } from '../serve';

// Builds a literal `${secrets:<path>}` ref via concatenation (not a template
// literal) so biome's noTemplateCurlyInString rule doesn't mistake the
// config-file placeholder syntax for an unresolved template string.
function secretRef(path: string): string {
  return ['${', 'secrets:', path, '}'].join('');
}

describe('serve', () => {
  it('getPort returns null when no server is running', () => {
    expect(getPort()).toBeNull();
  });
});

// `readSharedVoiceAndCallCaptureConfig` — the desktop app's read of the
// CLI's `~/.ethos/config.yaml` `auxiliary.asr`/`auxiliary.tts`/`callCapture`
// sections, so call-capture's STT provider AND its personality binding are
// wired the same way `ethos serve` wires them (see the doc comment on the
// function in `../serve` for the full story, including why the
// `callCapture` fallback exists — without it, a fresh desktop install
// crashes on startup whenever a personality unconditionally ships the
// `call_capture` toolset capability).
describe('readSharedVoiceAndCallCaptureConfig', () => {
  it('maps auxiliary.asr into auxiliaryAsr, with secret refs resolved', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await secrets.set('auxiliary/asr/apiKey', 'sk-real-stt-key');
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-ant-unrelated',
        'personality: researcher',
        'auxiliary.asr.provider: openai-stt',
        `auxiliary.asr.apiKey: ${secretRef('auxiliary/asr/apiKey')}`,
        'auxiliary.asr.model: whisper-1',
      ].join('\n'),
    );

    const result = await readSharedVoiceAndCallCaptureConfig(storage, secrets);

    expect(result.auxiliaryAsr).toEqual({
      provider: 'openai-stt',
      apiKey: 'sk-real-stt-key',
      model: 'whisper-1',
    });
    expect(result.auxiliaryTts).toBeUndefined();
    expect(result.callCapture).toBeUndefined();
  });

  it('maps callCapture.personalityId into callCapture', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-ant-unrelated',
        'personality: researcher',
        'callCapture.personalityId: voice',
      ].join('\n'),
    );

    const result = await readSharedVoiceAndCallCaptureConfig(storage, secrets);

    expect(result.callCapture).toEqual({ personalityId: 'voice' });
    expect(result.auxiliaryAsr).toBeUndefined();
    expect(result.auxiliaryTts).toBeUndefined();
  });

  it('returns {} when config.yaml does not exist', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();

    const result = await readSharedVoiceAndCallCaptureConfig(storage, secrets);

    expect(result).toEqual({});
  });

  it('returns {} when config.yaml has no auxiliary.asr/auxiliary.tts/callCapture section', async () => {
    const storage = new InMemoryStorage();
    const secrets = new InMemorySecretsResolver();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-ant-unrelated',
        'personality: researcher',
      ].join('\n'),
    );

    const result = await readSharedVoiceAndCallCaptureConfig(storage, secrets);

    expect(result).toEqual({});
  });
});

// Settings › Execution probe — the desktop's half of the registry thread
// (plan `remote-execution-routing.md`, T7 follow-up). The desktop is the third
// in-process web-API host alongside `ethos serve` and `ethos boot`; without
// this the probe answers `backend_unresolved` in the desktop app only.
//
// The property is INSTANCE IDENTITY: `DefaultExecutionBackendRegistry.resolve()`
// memoises, so the loop's registry holds the SAME backend the tools execute on.
// A probe against a second registry built here would report on an object
// nothing runs commands through — worse than no probe, because it reads as
// reassurance. Asserted against source (`startServer` cannot be called without
// a live Electron main process), the same way apps/ethos's
// execution-probe-thread.test.ts covers `serve.ts`/`boot.ts`.
describe('the desktop backend threads the loop execution-backend registry', () => {
  it('takes the registry off the createAgentLoop result and forwards it', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'serve.ts'), 'utf8');
    // Destructured from the loop result — not constructed here.
    expect(src).toContain('executionBackends,');
    expect(src).not.toContain('new DefaultExecutionBackendRegistry');
    // One binding, used twice: once out of `createAgentLoop`, once into
    // `createWebApi`. Two occurrences is the thread; one would mean a dangling
    // destructure or an invented object.
    expect(src.match(/^\s*executionBackends,$/gm)).toHaveLength(2);
  });
});

// The browser-takeover screencast lane (plan B3, T8). The desktop is the third
// in-process web-API host: `createAgentLoop` builds the browser tools HERE, so
// the session `browser_request_takeover` locked is one this process can reach —
// unlike `ethos gateway`, which opens its Chromium elsewhere and is honestly
// refused. Two halves, both host-side: the registry the socket looks sessions
// up in, and the attach without which the path never upgrades at all. Asserted
// against source for the same reason as the block above — `startServer` needs a
// live Electron main process.
describe('the desktop backend wires the browser-takeover lane', () => {
  it('passes the session registry and attaches the socket to the bound server', async () => {
    const src = await readFile(join(import.meta.dirname, '..', 'serve.ts'), 'utf8');
    expect(src).toContain('browserTakeoverSessions: createBrowserTakeoverRegistry(),');
    expect(src).toContain('takeoverSocket.attach(s);');
    // Taken off the `createWebApi` result, like the other two lanes.
    expect(src).toMatch(/^\s*takeoverSocket,$/m);
    // Closed before `server.close()`, which waits on the open lane otherwise.
    expect(src).toContain('if (takeover) await takeover.close();');
  });
});
