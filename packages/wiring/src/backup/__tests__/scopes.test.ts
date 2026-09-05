// Scopes, exclusions, and the drift gate (plan D1).
//
// The gate is the point of this file. It walks the repo for every
// `journal_mode = WAL` call site and diffs the result against `WAL_STORES`, so
// a store added next month cannot quietly land in — or quietly fall out of —
// a backup. It fails with the exact store and the exact fix, in the shape of
// `packages/types/src/__tests__/personality-field-count.test.ts`.

import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, relative } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  classifyPath,
  DATABASE_SCOPES,
  DEFAULT_SCOPES,
  enumerateBackupEntries,
  parseScopes,
  WAL_STORES,
} from '../scopes';

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..', '..', '..');

// ---------------------------------------------------------------------------
// Drift gate
// ---------------------------------------------------------------------------

/**
 * A WAL pragma CALL, not the words. Prose about this gate (this file, the
 * header of `scopes.ts`) says `journal_mode = WAL` too; only an actual
 * `db.pragma('journal_mode = WAL')` or `db.exec('PRAGMA journal_mode = WAL')`
 * opens a database.
 */
const WAL_PRAGMA = /(?:\.pragma\(\s*['"`]|exec\(\s*['"`]\s*PRAGMA\s+)\s*journal_mode\s*=\s*WAL/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage']);

/** Repo-relative module path → number of WAL pragma sites in it. */
function scanWalSites(dir: string, out: Map<string, number>): Map<string, number> {
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (dirent.isSymbolicLink()) continue;
    const full = join(dir, dirent.name);
    if (dirent.isDirectory()) {
      if (SKIP_DIRS.has(dirent.name)) continue;
      scanWalSites(full, out);
      continue;
    }
    if (!dirent.isFile() || extname(dirent.name) !== '.ts') continue;
    const rel = relative(REPO_ROOT, full).split('\\').join('/');
    // Tests and fixtures open throwaway databases; they carry no user state.
    if (rel.includes('/__tests__/') || rel.endsWith('.test.ts')) continue;
    let sites = 0;
    for (const line of readFileSync(full, 'utf8').split('\n')) {
      if (WAL_PRAGMA.test(line)) sites++;
    }
    if (sites > 0) out.set(rel, sites);
  }
  return out;
}

describe('backup scopes: WAL store drift gate', () => {
  const found = scanWalSites(join(REPO_ROOT, 'packages'), new Map());
  scanWalSites(join(REPO_ROOT, 'extensions'), found);
  scanWalSites(join(REPO_ROOT, 'apps'), found);

  it('classifies every production WAL store', () => {
    const registered = new Set(WAL_STORES.map((s) => s.source));
    const unclassified = [...found.keys()].filter((s) => !registered.has(s)).sort();

    expect(
      unclassified,
      `These modules open a WAL SQLite database that no backup scope accounts for:\n` +
        `${unclassified.map((s) => `  - ${s}`).join('\n')}\n\n` +
        `Add an entry to WAL_STORES in packages/wiring/src/backup/scopes.ts naming the\n` +
        `database file, the scope that carries it ('identity' | 'state' | 'telemetry'),\n` +
        `or scope: null with a reason it is deliberately excluded. No defaults: a store\n` +
        `that is not classified is not backed up, and nobody finds out until a restore.`,
    ).toEqual([]);
  });

  it('has no stale registry entries', () => {
    const stale = WAL_STORES.map((s) => s.source)
      .filter((s) => !found.has(s))
      .sort();
    expect(
      stale,
      `These WAL_STORES entries no longer match a WAL pragma in the repo:\n` +
        `${stale.map((s) => `  - ${s}`).join('\n')}\n\n` +
        `The store moved or was deleted. Update or remove the entry in\n` +
        `packages/wiring/src/backup/scopes.ts.`,
    ).toEqual([]);
  });

  it('counts the pragma sites in each registered module', () => {
    const drifted = WAL_STORES.filter((s) => found.get(s.source) !== s.sites).map(
      (s) => `${s.source}: registry says ${s.sites}, repo has ${found.get(s.source) ?? 0}`,
    );
    expect(
      drifted,
      `A registered module gained or lost a WAL pragma:\n${drifted.map((d) => `  - ${d}`).join('\n')}\n\n` +
        `If it opened a SECOND database, that database needs its own decision — add an\n` +
        `entry. If it is the same database, bump \`sites\` on the existing entry.`,
    ).toEqual([]);
  });

  it('gives every excluded store a stated reason', () => {
    for (const store of WAL_STORES) {
      expect(store.reason.length, `${store.source} has no reason`).toBeGreaterThan(20);
    }
  });

  it('resolves the 20 sites to 15 distinct database files', () => {
    const files = new Set(WAL_STORES.map((s) => s.database));
    expect(WAL_STORES.reduce((n, s) => n + s.sites, 0)).toBe(20);
    expect(files.size).toBe(15);
  });
});

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

describe('backup scopes: classification', () => {
  it('puts today’s backup set plus mcp.json in identity', () => {
    for (const path of [
      'config.yaml',
      'mcp.json',
      'MEMORY.md',
      'USER.md',
      'cron/jobs.json',
      'personalities/alice/SOUL.md',
      'personalities/alice/toolset.yaml',
    ]) {
      expect(classifyPath(path).scope, path).toBe('identity');
    }
  });

  it('puts databases, skills, teams, users, digests, a2a and plugin pins in state', () => {
    for (const path of [
      'sessions.db',
      'board.db',
      'teams/atlas/board.db',
      'goals.db',
      'cards.db',
      'dashboards.db',
      'memory.db',
      'jobs.db',
      'calls.db',
      'pairing.db',
      'a2a/tasks.db',
      'skills/pdf/SKILL.md',
      'teams/atlas/manifest.yaml',
      'users/u1.json',
      'digests/2026-09-04.md',
      'cron/output/job-1.txt',
      'plugins/package.json',
      'plugins/package-lock.json',
    ]) {
      expect(classifyPath(path).scope, path).toBe('state');
    }
  });

  it('puts observability.db in telemetry, which the default scopes leave out', () => {
    expect(classifyPath('observability.db').scope).toBe('telemetry');
    expect(DEFAULT_SCOPES).toEqual(['identity', 'state']);
  });

  it('always excludes the transient stores and the sensitive paths', () => {
    for (const path of [
      'delivery-ledger.db',
      'inbound-dedup.db',
      'notify-queue.db',
      'cache/thumb.png',
      'logs/ethos.log',
      'processes/registry.json',
      'plugins/node_modules/left-pad/index.js',
      'secrets/ANTHROPIC_API_KEY',
      'keys.json',
      'web-token',
      'cron/jobs.json.lock',
      'skills/.tmp/half-written',
      'blobs/ab/cd',
      'cas/ab/cd',
      'backups/ethos-backup-1.tar.gz',
      '.pre-restore/2026-01-01/config.yaml',
    ]) {
      expect(classifyPath(path).scope, path).toBeNull();
    }
  });

  it('never archives a WAL sidecar — the snapshot already folds it in', () => {
    for (const path of ['sessions.db-wal', 'sessions.db-shm', 'sessions.db-journal']) {
      expect(classifyPath(path).scope, path).toBeNull();
    }
  });

  it('carves plugins.lock out of the *.lock exclusion — a pin is not a lock', () => {
    expect(classifyPath('personalities/alice/plugins.lock').scope).toBe('identity');
    expect(classifyPath('personalities/alice/anything.lock').scope).toBeNull();
  });

  it('strips MCP OAuth token files wherever they sit', () => {
    for (const name of ['access_token', 'refresh_token', 'expires_at']) {
      expect(classifyPath(`personalities/alice/mcp/github/${name}`).scope, name).toBeNull();
    }
  });

  it('refuses a traversal path from an archive it did not write', () => {
    expect(classifyPath('../outside/config.yaml').scope).toBeNull();
    expect(classifyPath('personalities/../../etc/passwd').scope).toBeNull();
  });

  it('classifies a database by its path, not by its basename', () => {
    // Both real board.db locations are named deliberately.
    expect(classifyPath('board.db').scope).toBe('state');
    expect(classifyPath('teams/atlas/board.db').scope).toBe('state');
    // A file that merely shares a registered NAME, somewhere the registry does
    // not name, does not inherit that store's scope — it is reported, which is
    // the whole point of the registry.
    for (const path of [
      'skills/pdf/sessions.db',
      'teams/atlas/sessions.db',
      'teams/atlas/nested/board.db',
      'digests/observability.db',
    ]) {
      expect(classifyPath(path), path).toEqual({ scope: null, unclassifiedDatabase: true });
    }
  });

  it('flags a database no registry entry knows about', () => {
    expect(classifyPath('mystery.db')).toEqual({ scope: null, unclassifiedDatabase: true });
    expect(DATABASE_SCOPES.has('mystery.db')).toBe(false);
  });

  it('parses a --scope list and rejects an unknown name', () => {
    expect(parseScopes('identity,state')).toEqual(['identity', 'state']);
    expect(parseScopes(' telemetry , telemetry ')).toEqual(['telemetry']);
    expect(() => parseScopes('identity,everything')).toThrow(/Unknown backup scope "everything"/);
  });
});

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

describe('backup scopes: enumeration', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ethos-scopes-'));
    const write = (rel: string, body = 'x') => {
      const full = join(dir, rel);
      mkdirSync(join(full, '..'), { recursive: true });
      writeFileSync(full, body);
    };
    write('config.yaml', 'provider: anthropic\n');
    write('mcp.json', '{}');
    write('MEMORY.md');
    write('personalities/alice/SOUL.md');
    write('personalities/alice/mcp/github/access_token', 'ghs_secret');
    write('personalities/alice/mcp/github/expires_at', '123');
    write('personalities/bob/mcp/linear/refresh_token', 'lin_secret');
    write('sessions.db');
    write('sessions.db-wal');
    write('observability.db');
    write('delivery-ledger.db');
    write('secrets/ANTHROPIC_API_KEY', 'sk-real');
    write('keys.json', '{"a":"b"}');
    write('web-token', 'tok');
    write('logs/ethos.log');
    write('cache/blob');
    write('plugins/package.json', '{}');
    write('plugins/node_modules/left-pad/index.js');
    write('skills/pdf/SKILL.md');
    write('mystery.db');
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns only what the requested scopes carry', () => {
    const { entries } = enumerateBackupEntries(dir, ['identity', 'state']);
    expect(entries.map((e) => e.path)).toEqual([
      'MEMORY.md',
      'config.yaml',
      'mcp.json',
      'personalities/alice/SOUL.md',
      'plugins/package.json',
      'sessions.db',
      'skills/pdf/SKILL.md',
    ]);
  });

  it('adds observability.db only when telemetry is asked for', () => {
    const { entries } = enumerateBackupEntries(dir, ['telemetry']);
    expect(entries.map((e) => e.path)).toEqual(['observability.db']);
  });

  it('marks databases so the caller snapshots them instead of copying', () => {
    const { entries } = enumerateBackupEntries(dir, ['state']);
    const sessions = entries.find((e) => e.path === 'sessions.db');
    expect(sessions?.database).toBe(true);
    expect(entries.find((e) => e.path === 'skills/pdf/SKILL.md')?.database).toBe(false);
  });

  it('records which personality/server had MCP tokens without archiving them', () => {
    const { entries, strippedMcpTokens } = enumerateBackupEntries(dir, ['identity']);
    expect(entries.some((e) => e.path.includes('access_token'))).toBe(false);
    expect([...(strippedMcpTokens.get('alice') ?? [])]).toEqual(['github']);
    expect([...(strippedMcpTokens.get('bob') ?? [])]).toEqual(['linear']);
  });

  it('reports a database it cannot classify rather than guessing', () => {
    const { entries, unclassifiedDatabases } = enumerateBackupEntries(dir, ['state']);
    expect(unclassifiedDatabases).toEqual(['mystery.db']);
    expect(entries.some((e) => e.path === 'mystery.db')).toBe(false);
  });

  it('returns nothing for a data dir that does not exist', () => {
    expect(enumerateBackupEntries(join(dir, 'nope')).entries).toEqual([]);
  });
});
