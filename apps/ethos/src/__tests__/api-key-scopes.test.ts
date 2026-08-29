import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteApiKeyStore } from '@ethosagent/session-sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;

vi.mock('@ethosagent/config', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@ethosagent/config')>();
  return {
    ...orig,
    ethosDir: () => tempDir,
  };
});

// `SqliteApiKeyStore.create` stores whatever scope strings it is handed. Before
// `--scopes` was validated, a typo minted a key that authenticated fine and
// authorized nothing — the failure only surfaced later as a 403 from `/v1/*`.

describe('ethos api-key create --scopes validation', () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let writeSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'api-key-scopes-test-'));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    writeSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    writeSpy.mockRestore();
    exitSpy.mockRestore();
  });

  function loggedText(): string {
    const calls = logSpy.mock.calls as unknown[][];
    return calls.map((call) => String(call[0] ?? '')).join('\n');
  }

  it('rejects an unknown scope and lists the valid ones', async () => {
    const { runApiKey } = await import('../commands/api-key');
    await expect(runApiKey(['create', '--name', 'typo', '--scopes', 'chats'])).rejects.toThrow(
      /process.exit\(1\)/,
    );

    const output = loggedText();
    expect(output).toMatch(/Unknown scope: chats/);
    expect(output).toMatch(/Valid scopes:/);
    expect(output).toMatch(/events:subscribe/);

    const store = new SqliteApiKeyStore(join(tempDir, 'sessions.db'));
    expect(await store.list()).toEqual([]);
    store.close();
  });

  it('names every unknown scope when several are wrong', async () => {
    const { runApiKey } = await import('../commands/api-key');
    await expect(
      runApiKey(['create', '--name', 'typos', '--scopes', 'chat,nope,alsonope']),
    ).rejects.toThrow(/process.exit\(1\)/);
    expect(loggedText()).toMatch(/Unknown scopes: nope, alsonope/);
  });

  it('accepts every member of the schema', async () => {
    const { ApiKeyScopeSchema } = await import('@ethosagent/web-contracts');
    const { runApiKey } = await import('../commands/api-key');
    await runApiKey([
      'create',
      '--name',
      'all-scopes',
      '--scopes',
      ApiKeyScopeSchema.options.join(','),
      '--json',
    ]);

    const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
    const parsed = JSON.parse(output) as { scopes: string[] };
    expect(parsed.scopes).toEqual([...ApiKeyScopeSchema.options]);
  });

  it('defaults to `chat`, the scope /v1/* requires', async () => {
    const { runApiKey } = await import('../commands/api-key');
    await runApiKey(['create', '--name', 'default-scopes', '--json']);

    const output = String(writeSpy.mock.calls[0]?.[0] ?? '');
    const parsed = JSON.parse(output) as { scopes: string[] };
    expect(parsed.scopes).toEqual(['chat']);
  });
});
