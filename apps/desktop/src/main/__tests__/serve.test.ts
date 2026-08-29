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
