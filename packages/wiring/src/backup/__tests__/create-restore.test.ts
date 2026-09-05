// backup → wipe → restore, and every way a restore is supposed to refuse.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import Database from '@ethosagent/sqlite';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import { EthosError, type SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBackup } from '../create';
import { MANIFEST_PATH } from '../manifest';
import { restoreBackup } from '../restore';
import { SECRETS_MANIFEST_PATH } from '../secrets-manifest';
import { createTarGzWriter, type TarFileRecord } from '../tar';

let root: string;
let dataDir: string;
let out: string;

/** Rows written into every fixture database, uncheckpointed. */
function seedDb(path: string, table: string, rows: number): void {
  mkdirSync(join(path, '..'), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY, body TEXT NOT NULL) STRICT`);
  const insert = db.prepare(`INSERT INTO ${table} VALUES (?, ?)`);
  for (let i = 0; i < rows; i++) insert.run(`${table}-${i}`, `body ${i}`);
  db.close();
}

function count(path: string, table: string): number | string {
  const db = new Database(path, { readonly: true });
  try {
    const row = db.prepare(`SELECT count(*) AS c FROM ${table}`).get();
    return typeof row?.c === 'number' ? row.c : 'unreadable';
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  } finally {
    db.close();
  }
}

/** Size + mtime of a `dataDir`-relative file, or `'absent'`. */
function fingerprint(rel: string): string {
  const stat = statSync(join(dataDir, rel), { throwIfNoEntry: false });
  return stat === undefined ? 'absent' : `${stat.size}:${stat.mtimeMs}`;
}

function write(rel: string, body: string): void {
  const full = join(dataDir, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, body);
}

function secretsResolver(): FileSecretsResolver {
  return new FileSecretsResolver({ dir: join(dataDir, 'secrets'), storage: new FsStorage() });
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'ethos-backup-e2e-'));
  dataDir = join(root, 'home');
  out = join(root, 'archive.tar.gz');
  mkdirSync(dataDir, { recursive: true });

  write('config.yaml', 'provider: anthropic\nmodel: claude-opus-4-7\n');
  write('mcp.json', '{"servers":{}}');
  write('MEMORY.md', '# project\nships on fridays\n');
  write('USER.md', '# user\nprefers metric\n');
  write('cron/jobs.json', '[{"id":"daily"}]');
  write('cron/jobs.json.lock', 'pid 1234');
  write('cron/output/daily.txt', 'ran ok');
  write('personalities/alice/SOUL.md', 'I am Alice.\n');
  write(
    'personalities/alice/config.yaml',
    `name: Alice\nfs_reach.read: /Users/ada/src, \${ETHOS_HOME}/notes\nfs_reach.write: ~/scratch\n`,
  );
  write('personalities/alice/plugins.lock', '{"weather":{"package":"ethos-weather"}}');
  write('personalities/alice/mcp/github/access_token', 'ghs_do_not_archive');
  write('skills/pdf/SKILL.md', '# PDF skill\n');
  write('teams/atlas/manifest.yaml', 'name: atlas\n');
  write('users/u1.json', '{"id":"u1"}');
  write('digests/2026-09-04.md', 'digest\n');
  write('plugins/package.json', '{"dependencies":{"ethos-weather":"1.2.3"}}');
  write('plugins/package-lock.json', '{"lockfileVersion":3}');
  write('plugins/node_modules/ethos-weather/index.js', 'module.exports = {}');
  write('keys.json', '{"ANTHROPIC_API_KEY":"sk-live-do-not-archive"}');
  write('web-token', 'do-not-archive');
  write('logs/ethos.log', 'noise');
  write('cache/blob', 'noise');

  seedDb(join(dataDir, 'sessions.db'), 'messages', 120);
  seedDb(join(dataDir, 'teams', 'atlas', 'board.db'), 'tickets', 7);
  seedDb(join(dataDir, 'observability.db'), 'events', 5);
  seedDb(join(dataDir, 'delivery-ledger.db'), 'obligations', 3);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Round trip
// ---------------------------------------------------------------------------

describe('createBackup → restoreBackup', () => {
  it('brings back sessions, skills, boards and plugin pins after a wipe', async () => {
    const secrets = secretsResolver();
    await secrets.set('ANTHROPIC_API_KEY', 'sk-live');
    await secrets.set('personalities/alice/GITHUB_TOKEN', 'ghs_live');

    const result = await createBackup({ dataDir, outPath: out, secrets, snapshot: 'vacuum' });
    expect(result.scopes).toEqual(['identity', 'state']);
    expect(result.unclassifiedDatabases).toEqual([]);

    rmSync(dataDir, { recursive: true, force: true });

    const report = await restoreBackup({ dataDir, archivePath: out });
    expect(report.dryRun).toBe(false);
    expect(report.scopes).toEqual(['identity', 'state']);
    expect(report.displaced).toEqual([]);
    expect(report.restartRequired).toBe(true);

    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toContain('provider: anthropic');
    expect(readFileSync(join(dataDir, 'MEMORY.md'), 'utf8')).toContain('ships on fridays');
    expect(readFileSync(join(dataDir, 'skills/pdf/SKILL.md'), 'utf8')).toContain('PDF skill');
    expect(readFileSync(join(dataDir, 'plugins/package.json'), 'utf8')).toContain('1.2.3');
    expect(readFileSync(join(dataDir, 'plugins/package-lock.json'), 'utf8')).toContain(
      'lockfileVersion',
    );
    expect(readFileSync(join(dataDir, 'personalities/alice/plugins.lock'), 'utf8')).toContain(
      'ethos-weather',
    );
    expect(count(join(dataDir, 'sessions.db'), 'messages')).toBe(120);
    expect(count(join(dataDir, 'teams/atlas/board.db'), 'tickets')).toBe(7);
  });

  it('leaves secrets, keys.json, the web token, logs and node_modules out of the archive', async () => {
    const result = await createBackup({
      dataDir,
      outPath: out,
      secrets: secretsResolver(),
      snapshot: 'vacuum',
    });
    const archived = result.manifest.files.map((f) => f.path);
    for (const path of [
      'secrets/ANTHROPIC_API_KEY',
      'keys.json',
      'web-token',
      'logs/ethos.log',
      'cache/blob',
      'plugins/node_modules/ethos-weather/index.js',
      'cron/jobs.json.lock',
      'personalities/alice/mcp/github/access_token',
      'delivery-ledger.db',
      'observability.db',
    ]) {
      expect(archived, path).not.toContain(path);
    }
    // No archived byte contains the live key value either.
    const raw = gunzipSync(readFileSync(out)).toString('latin1');
    expect(raw).not.toContain('sk-live-do-not-archive');
    expect(raw).not.toContain('ghs_do_not_archive');
  });

  it('adds observability.db only when telemetry is requested', async () => {
    const result = await createBackup({
      dataDir,
      outPath: out,
      scopes: ['telemetry'],
      snapshot: 'vacuum',
    });
    // The manifest lists every OTHER entry; it is not in its own file list.
    expect(result.manifest.files.map((f) => f.path)).toEqual(['observability.db']);
  });

  it('writes the manifest last and cleans its staging directory up', async () => {
    const staging = join(root, 'staging');
    await createBackup({ dataDir, outPath: out, snapshot: 'backup', stagingDir: staging });
    const entries = gunzipSync(readFileSync(out));
    expect(entries.length).toBeGreaterThan(0);
    // An explicit staging dir is the caller's to remove; the default one is not.
    expect(existsSync(staging)).toBe(true);

    // The default staging root is created under `os.tmpdir()`, which every
    // other test process on this machine shares — counting `ethos-backup-*`
    // entries there measures the machine, not this call, and any suite running
    // in parallel moves the count. Point `TMPDIR` at a directory this test
    // owns, so whatever is left in it afterwards can only be this call's.
    const ownTmp = join(root, 'tmp');
    mkdirSync(ownTmp, { recursive: true });
    vi.stubEnv('TMPDIR', ownTmp);
    try {
      await createBackup({ dataDir, outPath: join(root, 'b.tar.gz'), snapshot: 'backup' });
    } finally {
      vi.unstubAllEnvs();
    }
    expect(readdirSync(ownTmp)).toEqual([]);
  });

  it('restores a single scope and leaves the rest of the archive alone', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    rmSync(dataDir, { recursive: true, force: true });

    const report = await restoreBackup({ dataDir, archivePath: out, scopes: ['identity'] });
    expect(report.scopes).toEqual(['identity']);
    expect(existsSync(join(dataDir, 'config.yaml'))).toBe(true);
    expect(existsSync(join(dataDir, 'sessions.db'))).toBe(false);
    expect(report.skipped).toContain('sessions.db');
    expect(report.restartRequired).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The lock gate (D4)
// ---------------------------------------------------------------------------

describe('restore lock gate', () => {
  it('refuses while another connection holds the live database', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });

    const holder = new Database(join(dataDir, 'sessions.db'));
    holder.pragma('journal_mode = WAL');
    holder.prepare('SELECT count(*) FROM messages').get();
    try {
      await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(
        /sessions\.db is in use by another process/,
      );
    } finally {
      holder.close();
    }
  });

  it('names the file and the lock error in the typed refusal', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const holder = new Database(join(dataDir, 'sessions.db'));
    holder.pragma('journal_mode = WAL');
    try {
      const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(EthosError);
      if (!(err instanceof EthosError)) return;
      expect(err.code).toBe('IMPORT_BLOCKED');
      expect(err.action).toMatch(/Stop anything using this Ethos home/);
    } finally {
      holder.close();
    }
  });

  it('touches nothing when it refuses', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    write('config.yaml', 'provider: openai\n');
    const holder = new Database(join(dataDir, 'sessions.db'));
    holder.pragma('journal_mode = WAL');
    holder.prepare('SELECT count(*) FROM messages').get();
    try {
      await restoreBackup({ dataDir, archivePath: out }).catch(() => undefined);
    } finally {
      holder.close();
    }
    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toBe('provider: openai\n');
    expect(existsSync(join(dataDir, '.pre-restore'))).toBe(false);
  });

  it('succeeds once the holder lets go', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const holder = new Database(join(dataDir, 'sessions.db'));
    holder.close();
    const report = await restoreBackup({ dataDir, archivePath: out });
    expect(report.lockedDatabases).toContain('sessions.db');
  });

  it('--force skips the gate the operator has taken responsibility for', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const holder = new Database(join(dataDir, 'sessions.db'));
    try {
      const report = await restoreBackup({ dataDir, archivePath: out, force: true });
      expect(report.lockedDatabases).toEqual([]);
      expect(report.restored).toContain('sessions.db');
    } finally {
      holder.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Dry run, displacement
// ---------------------------------------------------------------------------

describe('restore dry run and displacement', () => {
  it('reports what it would do and changes nothing', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    write('config.yaml', 'provider: openai\n');

    const report = await restoreBackup({ dataDir, archivePath: out, dryRun: true });
    expect(report.dryRun).toBe(true);
    expect(report.restored).toContain('config.yaml');
    expect(report.restored).toContain('sessions.db');
    expect(report.displaced).toContain('config.yaml');
    expect(report.displacedTo).toMatch(/^\.pre-restore\//);

    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toBe('provider: openai\n');
    expect(existsSync(join(dataDir, '.pre-restore'))).toBe(false);
  });

  // "Changes nothing" has to include the databases. The in-use gate opens each
  // one READ-WRITE, sets `locking_mode = EXCLUSIVE` and runs a write
  // transaction — which checkpoints the WAL and removes the `-wal`/`-shm`
  // sidecars on close. A dry run that does that has changed SQLite state on
  // disk while promising it changed nothing.
  it('leaves every database and its sidecars exactly as they were', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });

    const files = [
      'sessions.db',
      'sessions.db-wal',
      'sessions.db-shm',
      'teams/atlas/board.db',
      'teams/atlas/board.db-wal',
    ];
    expect(fingerprint('sessions.db-wal')).not.toBe('absent'); // the fixture never checkpointed
    const before = files.map(fingerprint);

    const report = await restoreBackup({ dataDir, archivePath: out, dryRun: true });

    expect(report.inUseCheck).toBe('skipped_dry_run');
    expect(report.lockedDatabases).toEqual([]);
    expect(files.map(fingerprint)).toEqual(before);
  });

  // The price of the fix, stated: a dry run cannot tell the operator whether
  // the real restore would be refused, because asking is a write. It must not
  // pretend otherwise in either direction — neither by refusing, nor by
  // reporting an empty `lockedDatabases` that reads as a check that passed.
  it('is not refused by a database another process is holding, and says the check was skipped', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const holder = new Database(join(dataDir, 'sessions.db'));
    holder.prepare('SELECT count(*) FROM messages').get();
    try {
      const report = await restoreBackup({ dataDir, archivePath: out, dryRun: true });
      expect(report.inUseCheck).toBe('skipped_dry_run');
      expect(report.restored).toContain('sessions.db');
    } finally {
      holder.close();
    }
  });

  it('moves what it replaces into .pre-restore/<timestamp>/ instead of overwriting', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    write('config.yaml', 'provider: openai\n');

    const report = await restoreBackup({ dataDir, archivePath: out });
    expect(report.displacedTo).toBeDefined();
    const displacedTo = report.displacedTo ?? '';
    expect(readFileSync(join(dataDir, displacedTo, 'config.yaml'), 'utf8')).toBe(
      'provider: openai\n',
    );
    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toContain('provider: anthropic');
  });

  it('takes a database’s -wal sidecar with it so no stale log is applied', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    // The fixture writer never checkpointed, so a -wal is sitting there.
    expect(existsSync(join(dataDir, 'sessions.db-wal'))).toBe(true);

    // `force` so the lock probe does not run: opening the live database to
    // take the lock also checkpoints it, which removes the -wal on its own.
    // Skipping the gate is exactly when a stale sidecar could survive.
    const report = await restoreBackup({ dataDir, archivePath: out, force: true });
    expect(report.displaced).toContain('sessions.db');
    expect(report.displaced).toContain('sessions.db-wal');
    expect(existsSync(join(dataDir, 'sessions.db-wal'))).toBe(false);
    expect(count(join(dataDir, 'sessions.db'), 'messages')).toBe(120);
  });

  it('warns about fs_reach literal absolute paths and never rewrites them', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    rmSync(dataDir, { recursive: true, force: true });

    const report = await restoreBackup({ dataDir, archivePath: out });
    const fsReach = report.warnings.filter((w) => w.kind === 'fs_reach_absolute');
    expect(fsReach).toHaveLength(1);
    expect(fsReach[0]?.path).toBe('personalities/alice/config.yaml');
    expect(fsReach[0]?.message).toContain('/Users/ada/src');

    const restored = readFileSync(join(dataDir, 'personalities/alice/config.yaml'), 'utf8');
    expect(restored).toContain('/Users/ada/src');
    expect(restored).toContain(`\${ETHOS_HOME}/notes`);
  });

  it('hands the secrets manifest back instead of writing it into the data dir', async () => {
    await createBackup({ dataDir, outPath: out, secrets: secretsResolver(), snapshot: 'vacuum' });
    rmSync(dataDir, { recursive: true, force: true });

    const report = await restoreBackup({ dataDir, archivePath: out });
    expect(report.secretsManifest).toContain('backed_up_at:');
    expect(existsSync(join(dataDir, SECRETS_MANIFEST_PATH))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

describe('restore refusals', () => {
  it('refuses a truncated archive before touching anything', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const size = readFileSync(out).length;
    truncateSync(out, Math.floor(size / 2));

    await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(
      /Backup archive is corrupt/,
    );
  });

  it('refuses an archive whose contents no longer match the manifest', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const raw = gunzipSync(readFileSync(out));
    const at = raw.indexOf(Buffer.from('provider: anthropic'));
    expect(at).toBeGreaterThan(0);
    raw.write('provider: malicious', at);
    writeFileSync(out, gzipSync(raw));

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/does not match its manifest checksum/);
  });

  it('refuses an archive written by a newer Ethos as IMPORT_NEWER_SCHEMA', async () => {
    const writer = createTarGzWriter(out);
    const records: TarFileRecord[] = [
      await writer.addFile('config.yaml', Buffer.from('provider: anthropic\n', 'utf8')),
    ];
    const manifest = {
      version: 99,
      createdAt: new Date().toISOString(),
      scopes: ['identity'],
      files: records,
    };
    await writer.addFile(MANIFEST_PATH, Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'));
    await writer.finish();

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_NEWER_SCHEMA');
    expect(err.action).toMatch(/Upgrade Ethos/);
  });

  it('refuses to write an archive entry the scope table excludes', async () => {
    const writer = createTarGzWriter(out);
    const records: TarFileRecord[] = [
      await writer.addFile('config.yaml', Buffer.from('provider: anthropic\n', 'utf8')),
      await writer.addFile('secrets/ANTHROPIC_API_KEY', Buffer.from('sk-attacker\n', 'utf8')),
      await writer.addFile('keys.json', Buffer.from('{}\n', 'utf8')),
    ];
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      scopes: ['identity'],
      files: records,
    };
    await writer.addFile(MANIFEST_PATH, Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'));
    await writer.finish();

    rmSync(dataDir, { recursive: true, force: true });
    const report = await restoreBackup({ dataDir, archivePath: out });
    expect(report.restored).toEqual(['config.yaml']);
    expect(report.skipped).toEqual(['keys.json', 'secrets/ANTHROPIC_API_KEY']);
    expect(existsSync(join(dataDir, 'secrets/ANTHROPIC_API_KEY'))).toBe(false);
    expect(existsSync(join(dataDir, 'keys.json'))).toBe(false);
    expect(report.warnings.map((w) => w.kind)).toEqual(['skipped_path', 'skipped_path']);
  });
});

// ---------------------------------------------------------------------------
// Destination containment
// ---------------------------------------------------------------------------

/** An archive entry's name is safe; where that name RESOLVES on this machine is not. */
describe('restore destination containment', () => {
  let outside: string;

  beforeEach(() => {
    outside = join(root, 'outside');
    mkdirSync(outside, { recursive: true });
  });

  it('refuses a symlinked PARENT directory and writes nothing outside the data dir', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    // The leaf (`SKILL.md`) is an ordinary name and does not exist yet; only
    // the parent is a link. A resolved-prefix test on the destination string
    // passes here — which is why the check has to walk every segment.
    rmSync(join(dataDir, 'skills'), { recursive: true, force: true });
    symlinkSync(outside, join(dataDir, 'skills'), 'dir');

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/skills\/pdf\/SKILL\.md/);
    expect(err.message).toMatch(/symbolic link/);

    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(outside, 'pdf', 'SKILL.md'))).toBe(false);
    // Refused before anything moved, like every other gate.
    expect(existsSync(join(dataDir, '.pre-restore'))).toBe(false);
  });

  it('refuses when the displacement directory itself points outside', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    symlinkSync(outside, join(dataDir, '.pre-restore'), 'dir');

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    // Nothing displaced out of the data directory, nothing overwritten in it.
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toContain('provider: anthropic');
  });

  it('refuses a symlinked leaf rather than silently replacing the link', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const outsideFile = join(outside, 'config.yaml');
    writeFileSync(outsideFile, 'provider: elsewhere\n');
    rmSync(join(dataDir, 'config.yaml'));
    symlinkSync(outsideFile, join(dataDir, 'config.yaml'));

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(readFileSync(outsideFile, 'utf8')).toBe('provider: elsewhere\n');
    expect(existsSync(join(dataDir, '.pre-restore'))).toBe(false);
  });

  // The one fail-open the walk used to have. `lstat` on a segment under an
  // unreadable directory raises EACCES, and a swallow turned that into "no
  // link here" — the check reporting a path contained when it never managed to
  // look at it. A real chmod rather than the `node:fs` mock
  // `scopes-unreadable.test.ts` uses: restore.ts pulls in a dozen `node:fs`
  // functions, and mocking the module for one of them is more machinery than
  // the mode bits are. Root ignores mode bits, so as root this would pass
  // without exercising the path at all — skipped there rather than lying.
  it.skipIf(process.getuid?.() === 0)(
    'refuses a destination it cannot check, rather than judging it contained',
    async () => {
      await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
      // `skills` itself still stats; `skills/pdf` below it does not.
      const unreadable = join(dataDir, 'skills');
      chmodSync(unreadable, 0o000);
      try {
        const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
        expect(err).toBeInstanceOf(EthosError);
        if (!(err instanceof EthosError)) return;
        expect(err.code).toBe('IMPORT_BLOCKED');
        expect(err.message).toMatch(/skills\/pdf\/SKILL\.md/);
        expect(err.message).toMatch(/EACCES/);
        // Refused at gate 3, before anything moved.
        expect(existsSync(join(dataDir, '.pre-restore'))).toBe(false);
      } finally {
        chmodSync(unreadable, 0o755);
      }
    },
  );
});

// ---------------------------------------------------------------------------
// Bounded buffering
// ---------------------------------------------------------------------------

/** Write an archive with hand-picked entries and a self-consistent manifest. */
async function craftArchive(entries: Array<[string, Buffer]>): Promise<void> {
  const writer = createTarGzWriter(out);
  const records: TarFileRecord[] = [];
  for (const [path, content] of entries) records.push(await writer.addFile(path, content));
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    scopes: ['identity'],
    files: records,
  };
  await writer.addFile(MANIFEST_PATH, Buffer.from(`${JSON.stringify(manifest)}\n`, 'utf8'));
  await writer.finish();
}

describe('restore buffering limits', () => {
  const oversized = Buffer.alloc(2 * 1024 * 1024, 0x61);

  it('refuses an oversized secrets manifest instead of buffering it', async () => {
    await craftArchive([
      ['config.yaml', Buffer.from('provider: anthropic\n')],
      [SECRETS_MANIFEST_PATH, oversized],
    ]);
    rmSync(dataDir, { recursive: true, force: true });

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/limit for a metadata entry/);
  });

  it('refuses an oversized personality config instead of buffering it', async () => {
    await craftArchive([['personalities/alice/config.yaml', oversized]]);
    rmSync(dataDir, { recursive: true, force: true });

    await expect(restoreBackup({ dataDir, archivePath: out })).rejects.toThrow(
      /limit for a metadata entry/,
    );
    expect(existsSync(join(dataDir, 'personalities/alice/config.yaml'))).toBe(false);
  });

  it('still streams an ordinary selected file well past that limit', async () => {
    await craftArchive([['skills/big/SKILL.md', oversized]]);
    rmSync(dataDir, { recursive: true, force: true });

    const report = await restoreBackup({ dataDir, archivePath: out });
    expect(report.restored).toEqual(['skills/big/SKILL.md']);
    expect(readFileSync(join(dataDir, 'skills/big/SKILL.md')).length).toBe(oversized.length);
  });
});

// A failed install — and the rollback that undoes it — moved to
// `restore-install-failure.test.ts`: its trigger (a FILE where a directory has
// to be) is now refused by gate 3's containment walk before the install phase
// runs, so provoking a mid-install failure needs a `node:fs` mock and the mock
// must not be in force for the rest of this file.

// ---------------------------------------------------------------------------
// A failed backup (the previous archive is the one thing it must not destroy)
// ---------------------------------------------------------------------------

describe('createBackup failure', () => {
  it('leaves the previous archive at outPath untouched and byte-identical', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const good = readFileSync(out);

    // A vault that cannot be enumerated fails the run after the archive has
    // been opened and every file entry written into it — the moment that used
    // to leave the previous backup truncated and the new one partial.
    const brokenSecrets: SecretsResolver = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => undefined,
      list: async () => {
        throw new Error('vault unreadable');
      },
    };

    await expect(
      createBackup({ dataDir, outPath: out, secrets: brokenSecrets, snapshot: 'vacuum' }),
    ).rejects.toThrow(/vault unreadable/);

    expect(readFileSync(out).equals(good)).toBe(true);
    // And nothing partial left beside it.
    expect(readdirSync(root).sort()).toEqual(['archive.tar.gz', 'home']);
  });
});

// ---------------------------------------------------------------------------
// Displacement directory uniqueness
// ---------------------------------------------------------------------------

describe('restore displacement directories', () => {
  it('keeps two restores in the same second apart instead of overwriting the first', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });

    // One frozen clock for both restores: a second-resolution name derived from
    // it is identical, so only an atomic create can tell the two apart.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      write('config.yaml', 'provider: first\n');
      const first = await restoreBackup({ dataDir, archivePath: out });
      write('config.yaml', 'provider: second\n');
      const second = await restoreBackup({ dataDir, archivePath: out });

      expect(first.displacedTo).toBeDefined();
      expect(second.displacedTo).toBeDefined();
      expect(first.displacedTo).not.toBe(second.displacedTo);

      // Both rollback copies survive: the second restore did not rename its
      // displaced files over the first restore's.
      expect(readFileSync(join(dataDir, first.displacedTo ?? '', 'config.yaml'), 'utf8')).toBe(
        'provider: first\n',
      );
      expect(readFileSync(join(dataDir, second.displacedTo ?? '', 'config.yaml'), 'utf8')).toBe(
        'provider: second\n',
      );
      // The human-readable timestamp is still there for an operator to read.
      expect(first.displacedTo).toMatch(/^\.pre-restore\/\d{4}-\d{2}-\d{2}T/);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// The restore-in-progress sentinel
// ---------------------------------------------------------------------------

describe('restore sentinel', () => {
  const sentinel = () => join(dataDir, '.restore-in-progress');

  it('refuses to start while another restore holds the data directory', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    write('config.yaml', 'provider: openai\n');
    // A LIVE pid: the sentinel is judged by the process it names, not by its
    // age, so a fixture that means "a restore is running" has to name a process
    // that is. `4321` was almost certainly gone, and would now be taken over
    // straight away — correctly.
    writeFileSync(sentinel(), `${process.pid} 2026-09-04T00:00:00.000Z\n`);

    const err = await restoreBackup({ dataDir, archivePath: out }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EthosError);
    if (!(err instanceof EthosError)) return;
    expect(err.code).toBe('IMPORT_BLOCKED');
    expect(err.message).toMatch(/Another restore is already running/);
    expect(err.action).toMatch(/\.restore-in-progress/);

    // Refused before anything moved, and the holder's sentinel left alone.
    expect(readFileSync(join(dataDir, 'config.yaml'), 'utf8')).toBe('provider: openai\n');
    expect(existsSync(join(dataDir, '.pre-restore'))).toBe(false);
    expect(existsSync(sentinel())).toBe(true);
  });

  it('takes over a sentinel left behind by a restore that died', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    writeFileSync(sentinel(), '4321 old\n');
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(sentinel(), twoHoursAgo, twoHoursAgo);

    const report = await restoreBackup({ dataDir, archivePath: out });
    expect(report.restored).toContain('config.yaml');
    // Claimed, then released: nothing is left holding the directory.
    expect(existsSync(sentinel())).toBe(false);
  });

  it('leaves no sentinel behind when a restore is refused', async () => {
    await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    const holder = new Database(join(dataDir, 'sessions.db'));
    holder.pragma('journal_mode = WAL');
    holder.prepare('SELECT count(*) FROM messages').get();
    try {
      await restoreBackup({ dataDir, archivePath: out }).catch(() => undefined);
    } finally {
      holder.close();
    }
    expect(existsSync(sentinel())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Unusual-but-legal filenames
// ---------------------------------------------------------------------------

describe('createBackup — filenames the write path must not choke on', () => {
  it('archives and restores a file whose name contains ".." inside a segment', async () => {
    // The reported defect: this is an ordinary date-range filename, and a
    // substring check on `..` used to throw "Malicious tar entry rejected" out
    // of createBackup, destroying the whole archive — every night, forever.
    const rel = 'skills/pdf/2026-01-01..2026-02-01.md';
    write(rel, 'january report\n');

    const result = await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });
    expect(result.skippedFiles).toEqual([]);

    rmSync(dataDir, { recursive: true, force: true });
    const report = await restoreBackup({ dataDir, archivePath: out });

    expect(report.restored).toContain(rel);
    expect(readFileSync(join(dataDir, rel), 'utf8')).toBe('january report\n');
  });

  it('skips an unarchivable file, reports it, and completes the rest', async () => {
    // A backslash is legal on POSIX but is a separator to a Windows extractor,
    // so `assertSafeEntryPath` refuses it on read and the file cannot
    // round-trip. It costs itself and nothing else.
    write('skills/pdf/back\\slash.md', 'cannot round-trip\n');

    const result = await createBackup({ dataDir, outPath: out, snapshot: 'vacuum' });

    expect(result.skippedFiles).toEqual([
      {
        path: 'skills/pdf/back\\slash.md',
        reason:
          'the name holds a backslash, which a restore must refuse as a Windows path separator',
      },
    ]);

    rmSync(dataDir, { recursive: true, force: true });
    const report = await restoreBackup({ dataDir, archivePath: out });

    // The backup exists, verifies, and carries everything else.
    expect(report.restored).toContain('skills/pdf/SKILL.md');
    expect(report.restored).not.toContain('skills/pdf/back\\slash.md');
    expect(count(join(dataDir, 'sessions.db'), 'messages')).toBe(120);
  });
});
