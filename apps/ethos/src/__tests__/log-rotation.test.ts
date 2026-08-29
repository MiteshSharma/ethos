// Phase 7 — log rotation config interface and rotation logic.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type LogRotationConfig, rotateIfNeeded } from '../error-log';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ethos-log-rotation-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const defaultConfig: LogRotationConfig = {
  maxBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  enabled: true,
};

describe('rotateIfNeeded', () => {
  it('does nothing when file is under maxBytes', () => {
    const filePath = join(tmpDir, 'errors.jsonl');
    writeFileSync(filePath, 'small content\n');
    rotateIfNeeded(filePath, { ...defaultConfig, maxBytes: 1024 * 1024 });
    // File still exists at original path, no backup created
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.1`)).toBe(false);
  });

  it('rotates file to .1 when it exceeds maxBytes', () => {
    const filePath = join(tmpDir, 'errors.jsonl');
    const bigContent = `${'x'.repeat(2 * 1024)}\n`;
    writeFileSync(filePath, bigContent);
    rotateIfNeeded(filePath, { ...defaultConfig, maxBytes: 1024 });
    // Original file renamed to .1
    expect(existsSync(`${filePath}.1`)).toBe(true);
    expect(readFileSync(`${filePath}.1`, 'utf-8')).toBe(bigContent);
    // Original no longer exists (new writes create it fresh)
    expect(existsSync(filePath)).toBe(false);
  });

  it('does nothing when file does not exist', () => {
    const filePath = join(tmpDir, 'nonexistent.jsonl');
    // Should not throw
    rotateIfNeeded(filePath, defaultConfig);
    expect(existsSync(filePath)).toBe(false);
    expect(existsSync(`${filePath}.1`)).toBe(false);
  });

  it('does nothing when enabled is false', () => {
    const filePath = join(tmpDir, 'errors.jsonl');
    // File is big enough to rotate
    writeFileSync(filePath, `${'x'.repeat(2 * 1024)}\n`);
    rotateIfNeeded(filePath, { ...defaultConfig, maxBytes: 1024, enabled: false });
    // No rotation happened
    expect(existsSync(filePath)).toBe(true);
    expect(existsSync(`${filePath}.1`)).toBe(false);
  });

  it('shifts existing backups: .1 becomes .2, new .1 created', () => {
    const filePath = join(tmpDir, 'errors.jsonl');
    const oldBackup = 'old backup\n';
    writeFileSync(`${filePath}.1`, oldBackup);
    const bigContent = `${'x'.repeat(2 * 1024)}\n`;
    writeFileSync(filePath, bigContent);
    rotateIfNeeded(filePath, { ...defaultConfig, maxBytes: 1024 });
    // Old .1 shifted to .2
    expect(existsSync(`${filePath}.2`)).toBe(true);
    expect(readFileSync(`${filePath}.2`, 'utf-8')).toBe(oldBackup);
    // Current file became .1
    expect(existsSync(`${filePath}.1`)).toBe(true);
    expect(readFileSync(`${filePath}.1`, 'utf-8')).toBe(bigContent);
  });

  it('deletes oldest file when maxFiles is reached', () => {
    const filePath = join(tmpDir, 'errors.jsonl');
    const maxFiles = 3;
    // Pre-seed backups .1, .2, .3
    writeFileSync(`${filePath}.1`, 'backup1\n');
    writeFileSync(`${filePath}.2`, 'backup2\n');
    writeFileSync(`${filePath}.3`, 'backup3\n');
    const bigContent = `${'x'.repeat(2 * 1024)}\n`;
    writeFileSync(filePath, bigContent);
    rotateIfNeeded(filePath, { ...defaultConfig, maxBytes: 1024, maxFiles });
    // .3 (the oldest at maxFiles) should be deleted
    expect(existsSync(`${filePath}.3`)).toBe(true); // .2 was moved here
    expect(readFileSync(`${filePath}.3`, 'utf-8')).toBe('backup2\n');
    expect(existsSync(`${filePath}.2`)).toBe(true); // .1 was moved here
    expect(readFileSync(`${filePath}.2`, 'utf-8')).toBe('backup1\n');
    expect(existsSync(`${filePath}.1`)).toBe(true); // current → .1
    expect(readFileSync(`${filePath}.1`, 'utf-8')).toBe(bigContent);
    // No .4 should exist
    expect(existsSync(`${filePath}.4`)).toBe(false);
  });

  it('handles multiple sequential rotations correctly', () => {
    const filePath = join(tmpDir, 'errors.jsonl');
    const config: LogRotationConfig = { ...defaultConfig, maxBytes: 100, maxFiles: 3 };

    // First rotation
    writeFileSync(filePath, 'a'.repeat(200));
    rotateIfNeeded(filePath, config);
    expect(existsSync(`${filePath}.1`)).toBe(true);
    expect(existsSync(filePath)).toBe(false);

    // Write new content and rotate again
    writeFileSync(filePath, 'b'.repeat(200));
    rotateIfNeeded(filePath, config);
    expect(existsSync(`${filePath}.2`)).toBe(true);
    expect(readFileSync(`${filePath}.2`, 'utf-8')).toBe('a'.repeat(200));
    expect(readFileSync(`${filePath}.1`, 'utf-8')).toBe('b'.repeat(200));

    // Third rotation — oldest (.3 after shift) gets overwritten by maxFiles delete
    writeFileSync(filePath, 'c'.repeat(200));
    rotateIfNeeded(filePath, config);
    expect(existsSync(`${filePath}.3`)).toBe(true);
    expect(readFileSync(`${filePath}.3`, 'utf-8')).toBe('a'.repeat(200));
    expect(readFileSync(`${filePath}.2`, 'utf-8')).toBe('b'.repeat(200));
    expect(readFileSync(`${filePath}.1`, 'utf-8')).toBe('c'.repeat(200));
  });
});

describe('log-rotation config parsing', () => {
  it('logs.rotation fields are parsed via parseConfigYaml', async () => {
    const { join: pathJoin } = await import('node:path');
    const { InMemoryStorage } = await import('@ethosagent/storage-fs');
    const { ethosDir, readRawConfig } = await import('@ethosagent/config');
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      pathJoin(ethosDir(), 'config.yaml'),
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk',
        'personality: p',
        'logs.rotation.maxBytes: 5242880',
        'logs.rotation.maxFiles: 3',
        'logs.rotation.enabled: false',
      ].join('\n'),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.logs?.rotation).toEqual({ maxBytes: 5242880, maxFiles: 3, enabled: false });
  });

  it('logs field is undefined when no rotation config present', async () => {
    const { join: pathJoin } = await import('node:path');
    const { InMemoryStorage } = await import('@ethosagent/storage-fs');
    const { ethosDir, readRawConfig } = await import('@ethosagent/config');
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      pathJoin(ethosDir(), 'config.yaml'),
      ['provider: anthropic', 'model: claude-opus-4-7', 'apiKey: sk', 'personality: p'].join('\n'),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg?.logs).toBeUndefined();
  });

  it('round-trips logs.rotation through writeConfig', async () => {
    const { InMemorySecretsResolver, InMemoryStorage } = await import('@ethosagent/storage-fs');
    const { ethosDir, readRawConfig, writeConfig } = await import('@ethosagent/config');
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      logs: { rotation: { maxBytes: 5242880, maxFiles: 3, enabled: false } },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.logs?.rotation).toEqual(original.logs.rotation);
  });
});
