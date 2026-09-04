// `ethos backup` / `ethos import` — the CLI half of plan/phases/agent-state-backup.md.
//
// The archive format, the scope table and the restore gates are the core's
// (`packages/wiring/src/backup/`, tested there). What is tested here is the
// part the operator touches: flags, the round trip through the two commands,
// and whether the report says the things it must — that a `state` archive is
// sensitive, whether the in-use check ran, and that a restart is needed.

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import Database from '@ethosagent/sqlite';
import { InMemorySecretsResolver } from '@ethosagent/storage-fs';
import { buildSecretsManifest, injectSecrets, prepareSecrets } from '@ethosagent/wiring';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getSecretsResolver } from '../../wiring';
import {
  defaultBackupDir,
  doctorCommand,
  parseVaultManifest,
  runBackup,
  runImport,
  runPersonalityImport,
  writeTarGz,
} from '../backup';

let stateDir: string;
let prevStateDir: string | undefined;
let out: string[];
let errOut: string[];

// `getSecretsResolver()` is a per-process singleton that pins `~/.ethos/secrets`
// at first call, so it cannot follow the per-test data directory. Pin it once,
// deliberately, to a directory this file owns and removes — otherwise the first
// test to touch the vault decides where every later one writes, and that
// directory is a tmpdir another test already deleted.
let vaultDir: string;

beforeAll(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), 'ethos-backup-cli-vault-'));
  process.env.ETHOS_STATE_DIR = vaultDir;
  await getSecretsResolver();
});

afterAll(async () => {
  await rm(vaultDir, { recursive: true, force: true });
});

beforeEach(async () => {
  stateDir = await mkdtemp(join(tmpdir(), 'ethos-backup-cli-'));
  prevStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = stateDir;
  process.exitCode = undefined;
  out = [];
  errOut = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    out.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errOut.push(args.join(' '));
  });
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    out.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  process.exitCode = undefined;
  if (prevStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = prevStateDir;
  await rm(stateDir, { recursive: true, force: true });
});

/** Everything a round trip should carry back: identity, skills, boards, pins. */
async function seedDataDir(dir: string): Promise<void> {
  await mkdir(join(dir, 'personalities', 'demo'), { recursive: true });
  await mkdir(join(dir, 'skills', 'greet'), { recursive: true });
  await mkdir(join(dir, 'plugins'), { recursive: true });
  await writeFile(join(dir, 'config.yaml'), 'provider: anthropic\nmodel: m\npersonality: demo\n');
  await writeFile(join(dir, 'MEMORY.md'), 'project context\n');
  await writeFile(join(dir, 'personalities', 'demo', 'config.yaml'), 'name: Demo\n');
  await writeFile(join(dir, 'personalities', 'demo', 'SOUL.md'), '# Demo\n');
  await writeFile(join(dir, 'personalities', 'demo', 'plugins.lock'), 'acme@1.0.0\n');
  await writeFile(join(dir, 'skills', 'greet', 'SKILL.md'), 'name: greet\n');
  await writeFile(join(dir, 'plugins', 'package.json'), '{"dependencies":{"acme":"1.0.0"}}');

  // Two real SQLite stores, so the round trip covers a snapshot and the
  // restore's lock gate has something to take.
  for (const [file, table] of [
    ['sessions.db', 'messages'],
    ['board.db', 'tickets'],
  ] as const) {
    const db = new Database(join(dir, file));
    db.exec('PRAGMA journal_mode = WAL');
    db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, body TEXT)`);
    db.prepare(`INSERT INTO ${table} (id, body) VALUES (?, ?)`).run('one', `hello ${table}`);
    db.close();
  }
}

function joined(): string {
  return out.join('\n');
}

function lastJson(): Record<string, unknown> {
  const line = out.filter((l) => l.trimStart().startsWith('{')).at(-1);
  if (line === undefined) throw new Error(`no JSON in output:\n${joined()}`);
  return JSON.parse(line);
}

async function backupTo(argv: string[]): Promise<string> {
  const archive = join(stateDir, 'out.tar.gz');
  await runBackup(['--out', archive, ...argv]);
  return archive;
}

describe('ethos backup — flags', () => {
  it('defaults to the backups directory next to the data dir', async () => {
    await seedDataDir(stateDir);
    await runBackup(['--json']);
    const json = lastJson();
    expect(String(json.path).startsWith(defaultBackupDir())).toBe(true);
    expect(json.ok).toBe(true);
  });

  it('accepts a positional out-path, as the old CLI did', async () => {
    await seedDataDir(stateDir);
    const archive = join(stateDir, 'positional.tar.gz');
    await runBackup([archive, '--json']);
    expect(lastJson().path).toBe(archive);
    await expect(stat(archive)).resolves.toBeTruthy();
  });

  it('--out with no value is refused', async () => {
    await runBackup(['--out']);
    expect(process.exitCode).toBe(1);
    expect(errOut.join('\n')).toContain('--out requires a path');
  });

  it('--scope narrows what is archived', async () => {
    await seedDataDir(stateDir);
    await backupTo(['--scope', 'identity', '--json']);
    const json = lastJson();
    expect(json.scopes).toEqual(['identity']);
    // sessions.db is `state`; identity alone must neither carry it nor claim
    // the sensitivity that carrying it would imply.
    expect(json.sensitive).toBe(false);

    await rm(join(stateDir, 'sessions.db'), { force: true });
    out = [];
    await runImport([join(stateDir, 'out.tar.gz')]);
    await expect(stat(join(stateDir, 'sessions.db'))).rejects.toThrow();
    expect(await readFile(join(stateDir, 'config.yaml'), 'utf8')).toContain('personality: demo');
  });

  it('--scope rejects an unknown name and does not write an archive', async () => {
    await seedDataDir(stateDir);
    const archive = join(stateDir, 'never.tar.gz');
    await runBackup(['--out', archive, '--scope', 'identity,nonsense']);
    expect(process.exitCode).toBe(1);
    expect(errOut.join('\n')).toContain('Unknown backup scope "nonsense"');
    await expect(stat(archive)).rejects.toThrow();
  });

  it('--scope with no value is refused', async () => {
    await runBackup(['--scope']);
    expect(process.exitCode).toBe(1);
    expect(errOut.join('\n')).toContain('--scope requires one of');
  });

  it('says a state archive holds conversation history', async () => {
    await seedDataDir(stateDir);
    await backupTo([]);
    expect(joined()).toContain('conversation history');
  });

  it('--bootstrap prints the exact restore command line', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo(['--bootstrap']);
    // The path is single-quoted: this line is meant to be pasted into a shell.
    expect(joined()).toContain(`ethos import '${archive}' --scope identity,state --secrets prompt`);
  });

  it('--bootstrap --json carries the command in the payload', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo(['--bootstrap', '--json']);
    expect(lastJson().bootstrap).toBe(
      `ethos import '${archive}' --scope identity,state --secrets prompt`,
    );
  });

  // The bootstrap line is the one output an operator is told to PASTE into a
  // shell, on a machine that has nothing on it yet, and `--out` is theirs to
  // choose. Unquoted, a space breaks it and a metacharacter turns it into a
  // different command. Every case below is a real archive actually written to
  // that path, so what is asserted is the line the operator would really get.
  describe('--bootstrap quotes the archive path', () => {
    it.each([
      ['a space', 'my backups.tar.gz'],
      ['a semicolon', 'out;rm -rf ~.tar.gz'],
      ['a command substitution', 'out$(id).tar.gz'],
      ['backticks and an ampersand', 'out`id`&.tar.gz'],
    ])('survives %s', async (_label, name) => {
      await seedDataDir(stateDir);
      const archive = join(stateDir, name);
      await runBackup(['--out', archive, '--bootstrap', '--json']);
      // Wholly inside one pair of single quotes — the shell reads none of it.
      expect(lastJson().bootstrap).toBe(
        `ethos import '${archive}' --scope identity,state --secrets prompt`,
      );
    });

    it('closes and reopens the quote around an embedded single quote', async () => {
      await seedDataDir(stateDir);
      const archive = join(stateDir, "mitesh's out.tar.gz");
      await runBackup(['--out', archive, '--bootstrap', '--json']);
      const line = String(lastJson().bootstrap);
      expect(line).toBe(
        `ethos import '${archive.replaceAll("'", `'\\''`)}' --scope identity,state --secrets prompt`,
      );
      // The escape is the POSIX one, and the path is never left bare.
      expect(line).toContain(`mitesh'\\''s out.tar.gz`);
      expect(line).not.toContain(`ethos import ${archive}`);
    });
  });
});

describe('ethos import — flags', () => {
  it('refuses a missing positional archive', async () => {
    await runImport([]);
    expect(process.exitCode).toBe(1);
    expect(errOut.join('\n')).toContain('No archive given');
  });

  it('refuses an archive path that does not exist', async () => {
    await runImport([join(stateDir, 'nope.tar.gz')]);
    expect(process.exitCode).toBe(1);
    expect(errOut.join('\n')).toContain('File not found');
  });

  it('refuses --secrets with no value', async () => {
    await runImport([join(stateDir, 'x.tar.gz'), '--secrets']);
    expect(process.exitCode).toBe(1);
    expect(errOut.join('\n')).toContain('--secrets requires');
  });

  it('refuses an unknown --scope before reading the archive', async () => {
    await runImport([join(stateDir, 'x.tar.gz'), '--scope', 'bogus']);
    expect(process.exitCode).toBe(1);
    expect(errOut.join('\n')).toContain('Unknown backup scope "bogus"');
  });

  it('reports a bad flag as JSON under --json', async () => {
    await runImport(['--json', '--scope', 'bogus']);
    const json = lastJson();
    expect(json.ok).toBe(false);
    expect(json.error).toMatchObject({ code: 'scope_invalid' });
  });
});

describe('ethos backup → wipe → ethos import', () => {
  it('carries sessions, skills, boards and plugin pins back', async () => {
    await seedDataDir(stateDir);
    const archive = join(tmpdir(), `ethos-roundtrip-${Date.now()}.tar.gz`);
    try {
      await runBackup(['--out', archive]);

      // Wipe everything the archive should be able to rebuild.
      for (const entry of ['personalities', 'skills', 'plugins']) {
        await rm(join(stateDir, entry), { recursive: true, force: true });
      }
      for (const entry of ['config.yaml', 'MEMORY.md', 'sessions.db', 'board.db']) {
        await rm(join(stateDir, entry), { force: true });
      }

      out = [];
      await runImport([archive]);

      expect(await readFile(join(stateDir, 'config.yaml'), 'utf8')).toContain('personality: demo');
      expect(await readFile(join(stateDir, 'MEMORY.md'), 'utf8')).toBe('project context\n');
      expect(await readFile(join(stateDir, 'skills', 'greet', 'SKILL.md'), 'utf8')).toBe(
        'name: greet\n',
      );
      expect(await readFile(join(stateDir, 'personalities', 'demo', 'plugins.lock'), 'utf8')).toBe(
        'acme@1.0.0\n',
      );
      expect(await readFile(join(stateDir, 'plugins', 'package.json'), 'utf8')).toContain('acme');

      const sessions = new Database(join(stateDir, 'sessions.db'));
      expect(sessions.prepare('SELECT body FROM messages').all()).toEqual([
        { body: 'hello messages' },
      ]);
      sessions.close();
      const board = new Database(join(stateDir, 'board.db'));
      expect(board.prepare('SELECT body FROM tickets').all()).toEqual([{ body: 'hello tickets' }]);
      board.close();
    } finally {
      await rm(archive, { force: true });
    }
  });

  it('tells the operator to restart after an identity restore', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    out = [];
    await runImport([archive]);
    expect(joined()).toContain('Restart Ethos');
  });

  it('reports that the in-use check ran, and over what', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    out = [];
    await runImport([archive, '--json']);
    const json = lastJson();
    expect(json.inUseCheck).toBe('held');
    expect(json.lockedDatabases).toEqual(expect.arrayContaining(['sessions.db', 'board.db']));
    expect(json.restartRequired).toBe(true);
  });

  it('--force says outright that nothing verified the databases were idle', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    out = [];
    await runImport([archive, '--force']);
    expect(joined()).toContain('in-use check: SKIPPED');
    expect(joined()).toContain('--force');

    out = [];
    await runImport([archive, '--force', '--json']);
    expect(lastJson().inUseCheck).toBe('skipped_force');
    expect(lastJson().lockedDatabases).toEqual([]);
  });
});

describe('ethos import --dry-run', () => {
  it('reports the restore and changes nothing on disk', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    await rm(join(stateDir, 'MEMORY.md'), { force: true });

    out = [];
    await runImport([archive, '--dry-run']);

    expect(joined()).toContain('Would restore');
    expect(joined()).toContain('Dry run — nothing on disk was changed.');
    await expect(stat(join(stateDir, 'MEMORY.md'))).rejects.toThrow();
  });

  it('says the in-use check was NOT made, so an empty lock list is not read as clean', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    out = [];
    await runImport([archive, '--dry-run', '--json']);
    const json = lastJson();
    expect(json.dryRun).toBe(true);
    expect(json.inUseCheck).toBe('skipped_dry_run');
    expect(json.lockedDatabases).toEqual([]);
    out = [];
    await runImport([archive, '--dry-run']);
    expect(joined()).toContain('in-use check: NOT made');
  });
});

describe('ethos import — warnings', () => {
  it('surfaces an fs_reach absolute-path warning from a restored personality', async () => {
    await seedDataDir(stateDir);
    await writeFile(
      join(stateDir, 'personalities', 'demo', 'config.yaml'),
      'name: Demo\nfs_reach.read: /Users/ada/src\n',
    );
    const archive = await backupTo([]);
    out = [];
    await runImport([archive, '--json']);
    const warnings = lastJson().warnings;
    expect(Array.isArray(warnings)).toBe(true);
    expect(JSON.stringify(warnings)).toContain('fs_reach_absolute');

    out = [];
    await runImport([archive]);
    expect(joined()).toContain('/Users/ada/src');
  });
});

describe('ethos import --secrets', () => {
  it('writes values from a manifest file into the vault', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    const manifest = join(stateDir, 'fill.yaml');
    await writeFile(
      manifest,
      [
        'global:',
        '  MY_KEY: sk-abc',
        'personalities:',
        '  demo:',
        '    GITHUB_TOKEN: ghp-1',
        '',
      ].join('\n'),
    );

    out = [];
    await runImport([archive, '--secrets', manifest, '--json']);
    expect(lastJson().secretsInjected).toBe(2);

    const secrets = await getSecretsResolver();
    expect(await secrets.get('MY_KEY')).toBe('sk-abc');
    expect(await secrets.get('personalities/demo/GITHUB_TOKEN')).toBe('ghp-1');
    // Nothing typed or read is ever echoed.
    expect(joined()).not.toContain('sk-abc');
  });

  it('reads a manifest from stdin', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: Readable.from([Buffer.from('global:\n  STDIN_KEY: v1\n')]),
    });
    try {
      out = [];
      await runImport([archive, '--secrets', '-', '--json']);
      expect(lastJson().secretsInjected).toBe(1);
    } finally {
      if (original) Object.defineProperty(process, 'stdin', original);
    }
    expect(await (await getSecretsResolver()).get('STDIN_KEY')).toBe('v1');
  });

  it('refuses a --secrets path that does not exist BEFORE the restore commits', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    await rm(join(stateDir, 'MEMORY.md'), { force: true });

    out = [];
    errOut = [];
    await runImport([archive, '--secrets', join(stateDir, 'typo.yaml')]);

    expect(process.exitCode).toBe(1);
    expect(errOut.join('\n')).toContain('Secrets manifest not found');
    // The whole point: the destructive half never ran, so the file the archive
    // would have restored is still missing.
    await expect(stat(join(stateDir, 'MEMORY.md'))).rejects.toThrow();
  });

  it('refuses a manifest with nothing injectable in it, restore untouched', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    await rm(join(stateDir, 'MEMORY.md'), { force: true });
    const manifest = join(stateDir, 'empty.yaml');
    await writeFile(manifest, '# just a comment\nnot_a_section: 1\n');

    out = [];
    errOut = [];
    await runImport([archive, '--secrets', manifest]);

    expect(process.exitCode).toBe(1);
    expect(errOut.join('\n')).toContain('nothing would be injected');
    await expect(stat(join(stateDir, 'MEMORY.md'))).rejects.toThrow();
  });

  it('reports a committed restore and a failed injection as two separate facts', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    await rm(join(stateDir, 'MEMORY.md'), { force: true });
    // A well-formed ref the VAULT refuses: `personalities/blocked` is a file,
    // so the scoped write cannot make its directory. No mocking, and nothing
    // the pre-restore check could have seen — it validates refs, not the state
    // of the filesystem — so injection fails over a restore that succeeded.
    const blocked = join(vaultDir, 'secrets', 'personalities', 'blocked');
    await mkdir(join(vaultDir, 'secrets', 'personalities'), { recursive: true });
    await writeFile(blocked, 'not a directory\n');
    const manifest = join(stateDir, 'bad-ref.yaml');
    await writeFile(manifest, 'personalities:\n  blocked:\n    TOKEN: sk-must-never-print\n');

    try {
      out = [];
      await runImport([archive, '--secrets', manifest]);

      // The restore committed.
      expect(await readFile(join(stateDir, 'MEMORY.md'), 'utf8')).toBe('project context\n');
      // And is reported as such, rather than as a failed import.
      expect(joined()).toContain('✓ Restored');
      expect(joined()).toContain('The restore is complete');
      expect(joined()).toContain('Injecting secrets FAILED');
      // The FIRST write failed, so nothing landed — and it says exactly that.
      expect(joined()).toContain('only the vault write did not happen');
      expect(joined()).not.toContain('PARTWAY');
      // The remedy is not the destructive command again.
      expect(joined()).toContain('which is not the fix');
      expect(joined()).toContain('ethos secrets set');
      expect(joined()).not.toContain('sk-must-never-print');
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(blocked, { force: true });
    }
  });

  it('carries both outcomes in --json, not one ok', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    const blocked = join(vaultDir, 'secrets', 'personalities', 'blocked');
    await mkdir(join(vaultDir, 'secrets', 'personalities'), { recursive: true });
    await writeFile(blocked, 'not a directory\n');
    const manifest = join(stateDir, 'bad-ref.yaml');
    await writeFile(manifest, 'personalities:\n  blocked:\n    TOKEN: sk-must-never-print\n');

    try {
      out = [];
      await runImport([archive, '--secrets', manifest, '--json']);
      const json = lastJson();
      expect(json.ok).toBe(false);
      expect(json.restoreOk).toBe(true);
      expect(Array.isArray(json.restored) && json.restored.length > 0).toBe(true);
      expect(json.secretsInjected).toBe(0);
      expect(json.secretsWrittenRefs).toEqual([]);
      expect(json.secretsFailedRef).toBe('personalities/blocked/TOKEN');
      expect(String(json.secretsError).length).toBeGreaterThan(0);
      expect(String(json.secretsError)).not.toContain('sk-');
      expect(joined()).not.toContain('sk-must-never-print');
      expect(process.exitCode).toBe(1);
    } finally {
      await rm(blocked, { force: true });
    }
  });

  it('refuses --secrets prompt under --json instead of writing prompts to stdout', async () => {
    // The vault decides how many questions the walk asks, and this test must
    // not depend on what an earlier test left in it.
    await rm(join(vaultDir, 'secrets'), { recursive: true, force: true });
    await seedDataDir(stateDir);
    const archive = await backupTo([]);

    out = [];
    await runImport([archive, '--secrets', 'prompt', '--json']);

    const json = lastJson();
    expect(json.ok).toBe(false);
    expect(json.error).toMatchObject({ code: 'input_invalid' });
    expect(process.exitCode).toBe(1);
    // Nothing but the JSON document on stdout.
    expect(out.join('').trim()).toBe(JSON.stringify(json));
  });

  it('keeps whitespace inside a prompted secret exactly as typed', async () => {
    // One key in the vault → the walk asks exactly one question.
    await rm(join(vaultDir, 'secrets'), { recursive: true, force: true });
    const secrets = await getSecretsResolver();
    await secrets.set('WS_KEY', 'old');
    await seedDataDir(stateDir);
    const archive = await backupTo([]);

    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: Readable.from(['  padded value  \n']),
    });
    try {
      out = [];
      await runImport([archive, '--secrets', 'prompt']);
    } finally {
      if (original) Object.defineProperty(process, 'stdin', original);
    }

    expect(await secrets.get('WS_KEY')).toBe('  padded value  ');
    expect(joined()).not.toContain('padded value');
  });

  it('names the secrets that DID land when injection fails partway', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    // A real mid-run failure, no mocking: `personalities/blocked` is a FILE in
    // the vault, so the global key ahead of it is written and the scoped key
    // behind it cannot be (EEXIST on mkdir). Pre-validation cannot see this —
    // both refs are well formed.
    const blocked = join(vaultDir, 'secrets', 'personalities', 'blocked');
    await mkdir(join(vaultDir, 'secrets', 'personalities'), { recursive: true });
    await writeFile(blocked, 'not a directory\n');
    const manifest = join(stateDir, 'partial.yaml');
    await writeFile(
      manifest,
      [
        'global:',
        '  PARTIAL_OK: sk-landed',
        'personalities:',
        '  blocked:',
        '    TOKEN: sk-lost',
        '',
      ].join('\n'),
    );

    try {
      out = [];
      await runImport([archive, '--secrets', manifest]);

      const secrets = await getSecretsResolver();
      expect(await secrets.get('PARTIAL_OK')).toBe('sk-landed');
      // The scoped write never happened — its destination is still the file.
      expect(await readFile(blocked, 'utf8')).toBe('not a directory\n');

      // Reported as partial, and the "only the vault write did not happen"
      // line — false here — is not printed.
      expect(joined()).toContain('Injecting secrets FAILED PARTWAY');
      expect(joined()).not.toContain('only the vault write did not happen');
      expect(joined()).toContain('1 secret(s) reached the vault');
      expect(joined()).toContain('PARTIAL_OK');
      expect(joined()).toContain(`ethos secrets set 'personalities/blocked/TOKEN' <value>`);
      expect(joined()).toContain('which is not the fix');
      expect(joined()).not.toContain('sk-landed');
      expect(joined()).not.toContain('sk-lost');
      expect(process.exitCode).toBe(1);

      out = [];
      process.exitCode = undefined;
      await runImport([archive, '--secrets', manifest, '--json']);
      const json = lastJson();
      expect(json.ok).toBe(false);
      expect(json.restoreOk).toBe(true);
      expect(json.secretsInjected).toBe(1);
      expect(json.secretsWrittenRefs).toEqual(['PARTIAL_OK']);
      expect(json.secretsFailedRef).toBe('personalities/blocked/TOKEN');
      expect(String(json.secretsError)).not.toContain('sk-');
      expect(joined()).not.toContain('sk-landed');
    } finally {
      await rm(blocked, { force: true });
    }
  });

  it('refuses a manifest whose destination ref is invalid BEFORE the restore commits', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    await rm(join(stateDir, 'MEMORY.md'), { force: true });
    const manifest = join(stateDir, 'nothing.yaml');
    // A `global:` header, so a scan for injectable SECTIONS sees a fine
    // manifest — and a ref beneath it the vault will never accept. A valid
    // entry AHEAD of the malformed one, so "nothing was written" is true
    // rather than nearly true.
    await writeFile(
      manifest,
      'global:\n  NEVER_WRITTEN: sk-must-never-print\n  BAD\\KEY: sk-nope\n',
    );

    out = [];
    errOut = [];
    await runImport([archive, '--secrets', manifest]);

    expect(process.exitCode).toBe(1);
    expect(errOut.join('\n')).toContain('BAD\\KEY');
    expect(errOut.join('\n')).toContain('backslashes');
    // The destructive half never ran: the file the archive would have restored
    // is still missing, and nothing claims a restore happened.
    await expect(stat(join(stateDir, 'MEMORY.md'))).rejects.toThrow();
    expect(joined()).not.toContain('Restored');
    expect(await (await getSecretsResolver()).get('NEVER_WRITTEN')).toBeNull();
    expect(errOut.join('\n')).not.toContain('sk-must-never-print');
    expect(errOut.join('\n')).not.toContain('sk-nope');

    out = [];
    errOut = [];
    process.exitCode = undefined;
    await runImport([archive, '--secrets', manifest, '--json']);
    const json = lastJson();
    expect(json.ok).toBe(false);
    expect(json.error).toMatchObject({ code: 'secrets_invalid' });
    expect(json.restored).toBeUndefined();
    await expect(stat(join(stateDir, 'MEMORY.md'))).rejects.toThrow();
    expect(joined()).not.toContain('sk-must-never-print');
  });

  it('does not write secrets during a --dry-run', async () => {
    await seedDataDir(stateDir);
    const archive = await backupTo([]);
    const manifest = join(stateDir, 'fill.yaml');
    await writeFile(manifest, 'global:\n  DRY_KEY: nope\n');

    out = [];
    await runImport([archive, '--dry-run', '--secrets', manifest, '--json']);
    expect(lastJson().secretsInjected).toBeUndefined();
    expect(await (await getSecretsResolver()).get('DRY_KEY')).toBeNull();
  });
});

describe('parseVaultManifest', () => {
  const MANIFEST = [
    '# Generated by ethos backup',
    'backed_up_at: 2026-09-04T00:00:00.000Z',
    '',
    'global:',
    '  - key: ANTHROPIC_API_KEY',
    '    fill_with: ethos secrets set ANTHROPIC_API_KEY <value>',
    '',
    'personalities:',
    '  demo:',
    '    secrets:',
    '      - key: GITHUB_TOKEN',
    '        fill_with: ethos secrets set personalities/demo/GITHUB_TOKEN <value>',
    '    mcp_auth:',
    '      - server: github',
    '        fill_with: ethos mcp auth github',
    '',
    'other:',
    '  - key: teams/atlas/KEY',
    '    fill_with: ethos secrets set teams/atlas/KEY <value>',
    '',
  ].join('\n');

  it('reads global, per-personality and other keys', () => {
    const hints = parseVaultManifest(MANIFEST);
    expect(hints.filter((h) => h.key !== undefined).map((h) => h.key)).toEqual([
      'ANTHROPIC_API_KEY',
      'GITHUB_TOKEN',
      'teams/atlas/KEY',
    ]);
    expect(hints.find((h) => h.key === 'GITHUB_TOKEN')?.personality).toBe('demo');
    expect(hints.find((h) => h.key === 'ANTHROPIC_API_KEY')?.personality).toBeUndefined();
  });

  it('keeps mcp_auth entries as commands, not values to type', () => {
    const oauth = parseVaultManifest(MANIFEST).filter((h) => h.server !== undefined);
    expect(oauth).toEqual([
      { personality: 'demo', server: 'github', fillWith: 'ethos mcp auth github' },
    ]);
  });

  it('returns nothing for a manifest with no secrets', () => {
    expect(parseVaultManifest('# nothing\nbacked_up_at: x\n')).toEqual([]);
  });
});

// The manifest's `fill_with:` lines are shell-quoted (they are pasted into a
// terminal); the `- key:` lines are not (they are parsed back). This is the
// proof the quoting stayed on the display side: a manifest built from hostile
// refs, read back by the importer, filled in, and prepared for the vault still
// names exactly the refs it started from.
describe('quoted fill_with hints survive the fill round trip', () => {
  const REFS = ['HAS SPACE', 'HAS;semicolon', 'HAS$(id)SUB', "HAS'quote"];
  const PERSONALITY_REFS = ['personalities/demo/HAS SPACE', "personalities/demo/HAS'quote"];

  it('parses back to the same refs the vault listed', async () => {
    const vault = new InMemorySecretsResolver();
    for (const ref of [...REFS, ...PERSONALITY_REFS]) await vault.set(ref, 'sk-must-never-print');

    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map([['demo', new Set(["o'brien"])]]),
    });
    expect(manifest).not.toContain('sk-must-never-print');

    const hints = parseVaultManifest(manifest);
    // The OAuth hint is a command, not a value to type — and it is quoted.
    expect(hints.filter((h) => h.server !== undefined)).toEqual([
      { personality: 'demo', server: "o'brien", fillWith: `ethos mcp auth 'o'\\''brien'` },
    ]);

    // Exactly what `promptForSecrets` writes once the operator has typed a
    // value for every key: `key: "value"`, grouped by namespace.
    const lines: string[] = ['global:'];
    for (const hint of hints.filter((h) => h.key !== undefined && h.personality === undefined)) {
      lines.push(`  ${hint.key}: "filled"`);
    }
    lines.push('personalities:', '  demo:');
    for (const hint of hints.filter((h) => h.key !== undefined && h.personality === 'demo')) {
      lines.push(`    ${hint.key}: "filled"`);
    }

    const prepared = prepareSecrets(`${lines.join('\n')}\n`);
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;

    const target = new InMemorySecretsResolver();
    const result = await injectSecrets(prepared.prepared, target);
    expect(result.error).toBeUndefined();
    expect([...result.writtenRefs].sort()).toEqual([...REFS, ...PERSONALITY_REFS].sort());
    expect([...(await target.list())].sort()).toEqual([...REFS, ...PERSONALITY_REFS].sort());
  });
});

// ---------------------------------------------------------------------------
// `ethos personality import` — the doctor paste line
// ---------------------------------------------------------------------------
//
// Every import branch ends by telling the operator to run
// `ethos personality doctor <id>`, and `<id>` comes off the ARCHIVE: the bundle
// manifest's `personalityId`, or a `personalities/<id>/` path SEGMENT on the
// legacy path. Whoever authored the archive chose it, so the line is pasted
// straight into a shell with a value the operator did not pick.
//
// `VALID_ID_RE` is the gate that actually stops a hostile one, and the last
// test here pins that. The quoting is the second lock on the same door: the
// line stays a single safe word for any caller that reaches the print without
// having come through that gate.
describe('ethos personality import — the doctor paste line', () => {
  /**
   * Decode ONE POSIX single-quoted argument back to its literal text, refusing
   * anything a shell would not read as a single word: a character outside the
   * quotes, an unterminated quote, or junk between two quoted runs. An id that
   * survives this round trip cannot have broken out of the quoting.
   */
  function decodeSingleQuoted(arg: string): string {
    let text = '';
    let i = 0;
    while (i < arg.length) {
      if (arg[i] !== "'") throw new Error(`unquoted text at ${i}: ${arg}`);
      const close = arg.indexOf("'", i + 1);
      if (close < 0) throw new Error(`unterminated quote: ${arg}`);
      text += arg.slice(i + 1, close);
      i = close + 1;
      if (i < arg.length) {
        if (arg.slice(i, i + 2) !== "\\'") throw new Error(`junk between quotes: ${arg}`);
        text += "'";
        i += 2;
      }
    }
    return text;
  }

  const PREFIX = 'ethos personality doctor ';

  it.each([
    ['a space', 'demo plug'],
    ['a semicolon', 'demo;rm -rf ~'],
    ['a command substitution', 'demo$(id)'],
    ['backticks and an ampersand', 'demo`id`&'],
    ['an embedded single quote', "o'brien"],
  ])('quotes %s so no metacharacter reaches the shell', (_label, id) => {
    const line = doctorCommand(id);
    expect(line.startsWith(PREFIX)).toBe(true);
    // Wholly inside the quoting — the shell reads the whole id as one word.
    expect(decodeSingleQuoted(line.slice(PREFIX.length))).toBe(id);
    expect(line).not.toBe(`${PREFIX}${id}`);
  });

  // The two legacy branches below are driven through the REAL import, so what
  // is asserted is the line an operator would actually be handed.
  it('quotes the id in the line a real legacy directory import prints', async () => {
    const src = join(stateDir, 'incoming', 'demo-plug');
    await mkdir(src, { recursive: true });
    await writeFile(join(src, 'config.yaml'), 'name: Demo\n');
    await writeFile(join(src, 'SOUL.md'), '# Demo\n');

    await runPersonalityImport([src]);

    expect(out.join('\n')).toContain(`Run: ethos personality doctor 'demo-plug'  to verify.`);
  });

  // The manifest below is deliberately FLAT. `parseManifestHints` matches its
  // `- key:` / `fill_with:` lines against `line.trimEnd()`, which keeps LEADING
  // whitespace, so the indented shape every exporter actually writes matches
  // nothing and this branch is unreachable with a real manifest — a pre-existing
  // defect in that parser, left alone here. A flat manifest reaches the branch,
  // and would still parse if the indentation handling were later fixed.
  it('quotes the id on the legacy branch that also lists required secrets', async () => {
    const archive = join(stateDir, 'legacy.tar.gz');
    await writeTarGz(
      [
        {
          relPath: 'personalities/demo-plug/config.yaml',
          content: Buffer.from('name: Demo\n'),
        },
        { relPath: 'personalities/demo-plug/SOUL.md', content: Buffer.from('# Demo\n') },
        {
          relPath: 'secrets.manifest.yaml',
          content: Buffer.from(
            [
              'global:',
              '- key: ANTHROPIC_API_KEY',
              `fill_with: ethos secrets set 'ANTHROPIC_API_KEY' <value>`,
              '',
            ].join('\n'),
          ),
        },
      ],
      archive,
    );

    await runPersonalityImport([archive]);

    const printed = out.join('\n');
    expect(printed).toContain('1 secret(s) required before use:');
    expect(printed).toContain(`Run: ethos personality doctor 'demo-plug'  to verify when ready.`);
  });

  // The lock that matters, pinned: a hostile segment never reaches the print at
  // all, so the quoting above is defence in depth rather than the only guard.
  it('refuses an archive whose personalities/<id>/ segment is not a plain id', async () => {
    const archive = join(stateDir, 'hostile.tar.gz');
    await writeTarGz(
      [
        {
          relPath: 'personalities/demo;rm -rf ~/config.yaml',
          content: Buffer.from('name: Demo\n'),
        },
      ],
      archive,
    );

    await expect(runPersonalityImport([archive])).rejects.toThrow(/Invalid personality ID/);
    expect(out.join('\n')).not.toContain('ethos personality doctor');
  });
});

// ---------------------------------------------------------------------------
// `--secrets prompt` carries the destination structurally, not as text
// ---------------------------------------------------------------------------
//
// The walk holds the `personality`/`key` it parsed out of the archive's
// manifest. It used to serialise each answer back into `key: "value"` manifest
// text so that `prepareSecrets` could split it apart again — a round trip
// through a colon-delimited, line-oriented format, applied to a key that is a
// vault FILENAME and may legally contain both.
describe('ethos import --secrets prompt — the destination survives the walk', () => {
  /** Type one answer on a muted stdin and run the prompted import. */
  async function importAnswering(archive: string, answers: string[]): Promise<void> {
    const original = Object.getOwnPropertyDescriptor(process, 'stdin');
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: Readable.from(answers.map((a) => `${a}\n`)),
    });
    try {
      out = [];
      await runImport([archive, '--secrets', 'prompt']);
    } finally {
      if (original) Object.defineProperty(process, 'stdin', original);
    }
  }

  it('writes a key containing a colon to the ref the manifest named', async () => {
    // A colon is legal in a vault ref: `validateRef` refuses only a DRIVE
    // letter (`^[A-Za-z]:`), so `TOK:EN` is a ref the vault really can hold and
    // `list()` really can return.
    await rm(join(vaultDir, 'secrets'), { recursive: true, force: true });
    const secrets = await getSecretsResolver();
    await secrets.set('TOK:EN', 'old');
    await seedDataDir(stateDir);
    const archive = await backupTo([]);

    await importAnswering(archive, ['sk-must-never-print']);

    // Before: the text round trip cut `TOK:EN: "…"` at its FIRST colon, so the
    // value landed under `TOK` — mangled, with the rest of the line attached —
    // while the command reported success.
    expect(await secrets.get('TOK:EN')).toBe('sk-must-never-print');
    expect(await secrets.get('TOK')).toBeNull();
    expect(joined()).toContain('Injected 1 secret(s)');
    expect(joined()).not.toContain('sk-must-never-print');
  });

  it('keeps a personality-scoped key with a colon under its own personality', async () => {
    await rm(join(vaultDir, 'secrets'), { recursive: true, force: true });
    const secrets = await getSecretsResolver();
    await secrets.set('personalities/demo/A:B', 'old');
    await seedDataDir(stateDir);
    const archive = await backupTo([]);

    await importAnswering(archive, ['sk-must-never-print']);

    expect(await secrets.get('personalities/demo/A:B')).toBe('sk-must-never-print');
    expect(await secrets.get('personalities/demo/A')).toBeNull();
    expect(joined()).not.toContain('sk-must-never-print');
  });
});
