import { join } from 'node:path';
import { ethosDir, readRawConfig, writeConfig } from '@ethosagent/config';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { grantQuickCommandConsent, hasQuickCommandConsent } from '../lib/onboarding';
import { formatQuickCommandOutput, runQuickCommand } from '../lib/quick-command-runner';

describe('runQuickCommand', () => {
  it('returns stdout for successful command', () => {
    const result = runQuickCommand('echo hello');
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello');
    expect(result.stderr).toBe('');
  });

  it('returns non-zero exitCode for failing command', () => {
    const result = runQuickCommand('sh -c "exit 7"');
    expect(result.exitCode).toBe(7);
  });

  it('captures stderr separately', () => {
    const result = runQuickCommand('sh -c "echo err >&2"');
    expect(result.stderr.trim()).toBe('err');
  });

  it('enforces timeout', () => {
    // 50ms timeout on a command that sleeps 10s should fail fast
    const start = Date.now();
    const result = runQuickCommand('sleep 10', 50);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(result.exitCode).not.toBe(0);
  });
});

describe('formatQuickCommandOutput', () => {
  it('wraps stdout in a fenced code block', () => {
    const output = formatQuickCommandOutput({ stdout: 'hello\n', stderr: '', exitCode: 0 });
    expect(output).toContain('```');
    expect(output).toContain('hello');
  });

  it('adds [stderr] block when stderr is non-empty', () => {
    const output = formatQuickCommandOutput({ stdout: '', stderr: 'oops\n', exitCode: 1 });
    expect(output).toContain('[stderr]');
    expect(output).toContain('oops');
  });

  it('shows exit code when non-zero', () => {
    const output = formatQuickCommandOutput({ stdout: '', stderr: '', exitCode: 3 });
    expect(output).toContain('[exit code: 3]');
  });

  it('returns "(no output)" when all fields are empty', () => {
    const output = formatQuickCommandOutput({ stdout: '', stderr: '', exitCode: 0 });
    expect(output).toBe('(no output)');
  });
});

describe('quick command consent', () => {
  it('hasQuickCommandConsent returns false initially', async () => {
    const storage = new InMemoryStorage();
    expect(await hasQuickCommandConsent('/ethos', storage)).toBe(false);
  });

  it('grantQuickCommandConsent latches the flag', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/ethos');
    await grantQuickCommandConsent('/ethos', storage);
    expect(await hasQuickCommandConsent('/ethos', storage)).toBe(true);
  });

  it('consent persists across reads (idempotent)', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir('/ethos');
    await grantQuickCommandConsent('/ethos', storage);
    await grantQuickCommandConsent('/ethos', storage);
    expect(await hasQuickCommandConsent('/ethos', storage)).toBe(true);
  });
});

describe('quick_commands config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  it('parses quick_commands from config.yaml', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-test',
        'personality: researcher',
        'quick_commands.status.type: exec',
        'quick_commands.status.command: echo running',
      ].join('\n'),
    );
    expect(cfg?.quick_commands).toEqual({
      status: { type: 'exec', command: 'echo running' },
    });
  });

  it('parses multiple quick commands', async () => {
    const cfg = await load(
      [
        'provider: anthropic',
        'model: claude-opus-4-7',
        'apiKey: sk-test',
        'personality: researcher',
        'quick_commands.gs.type: exec',
        'quick_commands.gs.command: git status',
        'quick_commands.ls.type: exec',
        'quick_commands.ls.command: ls -la',
      ].join('\n'),
    );
    expect(cfg?.quick_commands).toEqual({
      gs: { type: 'exec', command: 'git status' },
      ls: { type: 'exec', command: 'ls -la' },
    });
  });

  it('returns undefined quick_commands when none configured', async () => {
    const cfg = await load(
      ['provider: anthropic', 'model: m', 'apiKey: sk', 'personality: p'].join('\n'),
    );
    expect(cfg?.quick_commands).toBeUndefined();
  });

  it('round-trips quick_commands through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'anthropic',
      model: 'claude-opus-4-7',
      apiKey: 'sk',
      personality: 'researcher',
      quick_commands: {
        gs: { type: 'exec' as const, command: 'git status' },
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.quick_commands).toEqual(original.quick_commands);
  });
});
