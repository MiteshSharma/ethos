// What goes into a backup, and which named scope carries it (plan D1).
//
// Three scopes:
//   identity   config.yaml, mcp.json, MEMORY.md, USER.md, cron/jobs.json,
//              personalities/ — who this agent is. Small, restorable live.
//   state      every database that is not telemetry or transient, plus
//              skills/, teams/, users/, digests/, cron/output/, a2a/ and the
//              plugin pins. Large, and holds conversation history — an archive
//              containing it is as sensitive as the machine it came from.
//   telemetry  observability.db. Opt-in; nothing depends on it.
//
// Classification is an ALLOWLIST. A path that matches no rule is not archived.
// That direction is deliberate: `~/.ethos/` accumulates directories faster
// than this table does, and the failure mode of forgetting one is a missing
// file, not a leaked secret.
//
// Databases are the exception to "silence is fine": every `journal_mode = WAL`
// call site in the repo is registered in `WAL_STORES` below, and
// `scopes.test.ts` fails if the repo grows one that is not. See that test for
// what to do when it fires.
//
// Raw `node:fs` here is the documented Storage carve-out (AGENTS.md): the walk
// needs `readdirSync` with dirents to refuse symlinks, and `statSync` for the
// byte size a ustar header must declare.

import { type Dirent, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EthosError } from '@ethosagent/types';

export type ScopeName = 'identity' | 'state' | 'telemetry';

/** What `ethos backup` archives when the operator names no scope (D1). */
export const DEFAULT_SCOPES: readonly ScopeName[] = ['identity', 'state'];

export const ALL_SCOPES: readonly ScopeName[] = ['identity', 'state', 'telemetry'];

// ---------------------------------------------------------------------------
// The WAL store registry — the drift gate's committed manifest
// ---------------------------------------------------------------------------

/**
 * One `journal_mode = WAL` site in the repo, and the decision made about the
 * database it opens. `scope: null` means "deliberately not backed up", and
 * `reason` has to say why — an unexplained exclusion is the thing this
 * registry exists to prevent.
 */
export interface WalStoreRecord {
  /** Repo-relative module holding the pragma. The drift gate's key. */
  source: string;
  /** How many WAL pragma sites this module has. */
  sites: number;
  /** The database file it opens, `<dataDir>`-relative. */
  database: string;
  /**
   * Further `<dataDir>`-relative locations the SAME database file is opened
   * at, when a deployment can have more than one. `*` matches exactly one path
   * segment. Only `board.db` has one today (per-team boards).
   */
  alsoAt?: readonly string[];
  /** Scope that carries it, or `null` when deliberately excluded. */
  scope: ScopeName | null;
  reason: string;
}

/**
 * Every WAL store in the repo. 20 pragma sites across 19 modules, resolving to
 * 15 distinct database files — `sessions.db` has FIVE tenants sharing one file
 * and `pairing.db` is opened from two commands.
 *
 * Five, not four, and the difference is that tenants are not modules:
 * `extensions/session-sqlite/src/index.ts` holds two of them, which is what its
 * `sites: 2` records — `SQLiteSessionStore` and the key/value store
 * `createKvStoreFactory` opens, both pointed at the same `sessions.db` path by
 * `session-sqlite/src/compose.ts`. Counting the four MODULES that name the file
 * is what makes it look like four.
 */
export const WAL_STORES: readonly WalStoreRecord[] = [
  {
    source: 'packages/a2a/src/sqlite-task-store.ts',
    sites: 1,
    database: 'a2a/tasks.db',
    scope: 'state',
    reason:
      "An A2A task's terminal state and idempotency key must survive a move, not just a restart.",
  },
  {
    source: 'extensions/kanban-store/src/index.ts',
    sites: 1,
    database: 'board.db',
    alsoAt: ['teams/*/board.db'],
    scope: 'state',
    reason:
      'Kanban tickets are work in flight. Two real locations: the standalone board and the ' +
      'per-team board `packages/wiring/src/kanban-path.ts` picks when `teamName` is set.',
  },
  {
    source: 'extensions/dashboard/src/dashboards.service.ts',
    sites: 1,
    database: 'dashboards.db',
    scope: 'state',
    reason: 'Operator-authored dashboards; nothing else can reconstruct them.',
  },
  {
    source: 'extensions/goal-store/src/index.ts',
    sites: 1,
    database: 'goals.db',
    scope: 'state',
    reason: 'Long-running goals outlive any single session.',
  },
  {
    source: 'extensions/session-cards/src/index.ts',
    sites: 1,
    database: 'cards.db',
    scope: 'state',
    reason: 'Session cards are the rendered record of a conversation.',
  },
  {
    source: 'extensions/observability-sqlite/src/store.ts',
    sites: 1,
    database: 'observability.db',
    scope: 'telemetry',
    reason: 'Metrics and traces. Useful to carry, but nothing depends on it — hence opt-in.',
  },
  {
    source: 'extensions/session-sqlite/src/index.ts',
    sites: 2,
    database: 'sessions.db',
    scope: 'state',
    reason:
      'Conversation history. The reason a state archive is as sensitive as the machine. Two ' +
      'tenants in one module (hence `sites: 2`): the session store, and the key/value store ' +
      '`createKvStoreFactory` opens on the same path.',
  },
  {
    source: 'extensions/session-sqlite/src/api-key-store.ts',
    sites: 1,
    database: 'sessions.db',
    scope: 'state',
    reason: 'Third tenant of sessions.db — API key hashes, not values.',
  },
  {
    source: 'extensions/session-sqlite/src/context-log.ts',
    sites: 1,
    database: 'sessions.db',
    scope: 'state',
    reason: 'Fourth tenant of sessions.db — what context each turn was assembled from.',
  },
  {
    source: 'apps/web-api/src/stores/idempotency-store.ts',
    sites: 1,
    database: 'sessions.db',
    scope: 'state',
    reason:
      'Fifth tenant of sessions.db (boot.ts and serve.ts both pass that path). The cache ' +
      'itself is transient — 24h TTL — and would be excluded on its own merits, but it is a ' +
      'TABLE inside a state database, not a file, so excluding it would mean splitting the file.',
  },
  {
    source: 'extensions/memory-vector/src/index.ts',
    sites: 1,
    database: 'memory.db',
    scope: 'state',
    reason: 'Vector memory. Re-embedding it costs money and needs the source text, which is here.',
  },
  {
    source: 'extensions/job-store/src/index.ts',
    sites: 1,
    database: 'jobs.db',
    scope: 'state',
    reason: 'Background jobs, including ones still owed a wake notice.',
  },
  {
    source: 'extensions/call-log/src/index.ts',
    sites: 1,
    database: 'calls.db',
    scope: 'state',
    reason: 'Telephony call history — a durable record, not a working set.',
  },
  {
    source: 'extensions/channel-transcript-sqlite/src/index.ts',
    sites: 1,
    database: 'channel-transcript.db',
    scope: 'state',
    reason:
      'Conversation content from watched group chats, in the same category as sessions.db and ' +
      'as sensitive: verbatim third-party messages with sender ids. Nothing else can rebuild it ' +
      '— the platforms will not redeliver — and the digest reads it as history, so a restored ' +
      'machine that lost it silently loses up to a retention window of context. The short 30d ' +
      'TTL bounds its size; it does not change what kind of data it is.',
  },
  {
    source: 'apps/ethos/src/commands/gateway.ts',
    sites: 1,
    database: 'pairing.db',
    scope: 'state',
    reason: 'Channel pairings. Losing them means every user re-pairs by hand.',
  },
  {
    source: 'apps/ethos/src/commands/boot.ts',
    sites: 1,
    database: 'pairing.db',
    scope: 'state',
    reason: 'Same pairing.db as gateway.ts — one file, two composition roots.',
  },
  {
    source: 'extensions/delivery-ledger/src/index.ts',
    sites: 1,
    database: 'delivery-ledger.db',
    scope: null,
    reason:
      'Obligations to send a reply on THIS machine. Restoring them elsewhere redelivers old ' +
      'messages to real people (D1 always-excluded).',
  },
  {
    source: 'extensions/inbound-dedup/src/index.ts',
    sites: 1,
    database: 'inbound-dedup.db',
    scope: null,
    reason: 'A short de-duplication window over live traffic. Meaningless once moved.',
  },
  {
    source: 'extensions/notify-queue/src/index.ts',
    sites: 1,
    database: 'notify-queue.db',
    scope: null,
    reason: 'Pending notifications for a process that is no longer running.',
  },
];

/**
 * `<dataDir>`-relative database PATH → scope, derived from `WAL_STORES`
 * (`database` plus every `alsoAt`). `*` in a key matches exactly one segment.
 *
 * Keyed by path, not by basename: a basename key says "any file called
 * `sessions.db`, anywhere in the tree, is conversation history" — which is a
 * guess, and the guess is what this registry exists to replace. A database
 * that turns up somewhere the registry does not name is reported as
 * unclassified, exactly like one with an unknown name.
 */
export const DATABASE_SCOPES: ReadonlyMap<string, ScopeName | null> = (() => {
  const map = new Map<string, ScopeName | null>();
  for (const store of WAL_STORES) {
    for (const path of [store.database, ...(store.alsoAt ?? [])]) {
      const existing = map.get(path);
      if (existing !== undefined && existing !== store.scope) {
        throw new Error(
          `WAL_STORES disagrees about "${path}": ${existing ?? 'excluded'} vs ${store.scope ?? 'excluded'}`,
        );
      }
      map.set(path, store.scope);
    }
  }
  return map;
})();

/** `teams/*​/board.db` against `teams/atlas/board.db`. Segment count must match. */
function matchesPattern(pattern: string, rel: string): boolean {
  const patternSegments = pattern.split('/');
  const relSegments = rel.split('/');
  if (patternSegments.length !== relSegments.length) return false;
  return patternSegments.every((seg, i) => seg === '*' || seg === relSegments[i]);
}

/** The scope carrying this database path, or `undefined` when none names it. */
function databaseScope(rel: string): ScopeName | null | undefined {
  const exact = DATABASE_SCOPES.get(rel);
  if (exact !== undefined) return exact;
  for (const [pattern, scope] of DATABASE_SCOPES) {
    if (pattern.includes('*') && matchesPattern(pattern, rel)) return scope;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Non-database rules
// ---------------------------------------------------------------------------

interface ScopeRule {
  /** `<dataDir>`-relative path. */
  path: string;
  kind: 'file' | 'dir';
  scope: ScopeName;
}

const RULES: readonly ScopeRule[] = [
  // identity — today's `ethos backup` set plus mcp.json (D1).
  { path: 'config.yaml', kind: 'file', scope: 'identity' },
  { path: 'mcp.json', kind: 'file', scope: 'identity' },
  { path: 'MEMORY.md', kind: 'file', scope: 'identity' },
  { path: 'USER.md', kind: 'file', scope: 'identity' },
  { path: 'cron/jobs.json', kind: 'file', scope: 'identity' },
  { path: 'personalities', kind: 'dir', scope: 'identity' },
  // state
  { path: 'skills', kind: 'dir', scope: 'state' },
  { path: 'teams', kind: 'dir', scope: 'state' },
  { path: 'users', kind: 'dir', scope: 'state' },
  { path: 'digests', kind: 'dir', scope: 'state' },
  { path: 'cron/output', kind: 'dir', scope: 'state' },
  { path: 'a2a', kind: 'dir', scope: 'state' },
  // Plugin pins: what npm installed under the `plugins/` prefix, not the tree.
  { path: 'plugins/package.json', kind: 'file', scope: 'state' },
  { path: 'plugins/package-lock.json', kind: 'file', scope: 'state' },
];

/**
 * Paths that never enter an archive whatever else matches (D1). Directory
 * entries also cover everything beneath them.
 */
const ALWAYS_EXCLUDED: readonly string[] = [
  'cache',
  'logs',
  'processes',
  'secrets',
  'keys.json',
  'web-token',
  'blobs',
  'cas',
  'plugins/node_modules',
  'skills/.tmp',
  // Not in D1's list, added for the same reason the others are there: both are
  // this feature's own output. `.pre-restore/` holds what a restore displaced,
  // and `backups/` is where the scheduled job writes archives — archiving
  // either one makes every backup carry the previous ones.
  '.pre-restore',
  'backups',
];

/**
 * OAuth token files an MCP server wrote next to its personality. Stripped from
 * every archive; `secrets-manifest.ts` records which server had them.
 */
export const MCP_TOKEN_FILENAMES: ReadonlySet<string> = new Set([
  'access_token',
  'refresh_token',
  'expires_at',
]);

/** SQLite sidecars. Never archived — a snapshot already folds them in. */
const DB_SIDECAR = /\.db-(wal|shm|journal)$/;

/**
 * `*.lock` is D1's always-excluded glob and it is right about lock sentinels
 * (`cron/jobs.json.lock`, `processes/registry.lock`, `backups/.lock`). It is
 * wrong about ONE file: `plugins.lock` is a dependency PIN, not a lock, and D1
 * elsewhere requires plugin pins to travel. The glob wins everywhere except
 * that name.
 *
 * Carved out by BASENAME, not by location. `plugin-loader` only ever writes one
 * inside `personalities/<id>/`, but the check below does not say so: a
 * `plugins.lock` anywhere in the tree survives the glob. Surviving it is not
 * the same as being archived — the file still has to match a rule in `RULES`,
 * and the scope it lands in is whichever rule that is.
 */
const PLUGIN_PIN_FILENAME = 'plugins.lock';

export interface PathClassification {
  /** Owning scope, or `null` when the path is not archived. */
  scope: ScopeName | null;
  /** A `*.db` file whose basename is in no `WAL_STORES` entry. */
  unclassifiedDatabase: boolean;
}

const NOT_ARCHIVED: PathClassification = { scope: null, unclassifiedDatabase: false };

function underPath(rel: string, prefix: string): boolean {
  return rel === prefix || rel.startsWith(`${prefix}/`);
}

/**
 * Decide what carries one `<dataDir>`-relative path. Used both when building
 * an archive and when reading one back, so an archive that smuggles in
 * `secrets/` is refused on the way in as well as kept out on the way out.
 */
export function classifyPath(rel: string): PathClassification {
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return NOT_ARCHIVED;

  const name = basename(rel);
  if (DB_SIDECAR.test(name)) return NOT_ARCHIVED;
  if (name.endsWith('.lock') && name !== PLUGIN_PIN_FILENAME) return NOT_ARCHIVED;
  if (MCP_TOKEN_FILENAMES.has(name)) return NOT_ARCHIVED;
  if (ALWAYS_EXCLUDED.some((p) => underPath(rel, p))) return NOT_ARCHIVED;

  if (name.endsWith('.db')) {
    const scope = databaseScope(rel);
    if (scope === undefined) return { scope: null, unclassifiedDatabase: true };
    return { scope, unclassifiedDatabase: false };
  }

  for (const rule of RULES) {
    if (rule.kind === 'file' ? rel === rule.path : underPath(rel, rule.path)) {
      return { scope: rule.scope, unclassifiedDatabase: false };
    }
  }
  return NOT_ARCHIVED;
}

/** True when this path must be snapshotted rather than copied byte-for-byte. */
export function isDatabasePath(rel: string): boolean {
  return rel.endsWith('.db');
}

// ---------------------------------------------------------------------------
// Enumeration
// ---------------------------------------------------------------------------

export interface BackupEntry {
  /** `<dataDir>`-relative path. Also the archive entry name. */
  path: string;
  /** Absolute source path on this machine. */
  sourcePath: string;
  scope: ScopeName;
  /** Snapshot it (D2) instead of streaming the live file. */
  database: boolean;
  /** Bytes on disk now. Advisory for databases — a snapshot differs. */
  size: number;
}

export interface EnumerationResult {
  entries: BackupEntry[];
  /** `*.db` files under `dataDir` that no `WAL_STORES` entry accounts for. */
  unclassifiedDatabases: string[];
  /** personality id → MCP server directories whose OAuth tokens were stripped. */
  strippedMcpTokens: Map<string, Set<string>>;
}

function recordStrippedToken(rel: string, strippedMcpTokens: Map<string, Set<string>>): void {
  const parts = rel.split('/');
  // personalities/<id>/…/<server>/<token-file>
  if (parts[0] !== 'personalities' || parts.length < 4) return;
  const id = parts[1];
  const server = parts[parts.length - 2];
  if (id === undefined || server === undefined) return;
  let servers = strippedMcpTokens.get(id);
  if (!servers) {
    servers = new Set();
    strippedMcpTokens.set(id, servers);
  }
  servers.add(server);
}

/**
 * Walk `dataDir` and return what belongs in an archive built for `scopes`.
 *
 * Symlinks are skipped, not followed: a link inside `~/.ethos/` would let an
 * archive carry a file from anywhere on the machine under an innocent name.
 *
 * A directory that cannot be READ is a failure, not an empty directory — see
 * the `readdirSync` catch below. There is deliberately no "partial" flag on
 * `EnumerationResult`: a caller that can ignore the flag is a backup that
 * completes while missing files, which is the failure this refuses.
 */
export function enumerateBackupEntries(
  dataDir: string,
  scopes: readonly ScopeName[] = DEFAULT_SCOPES,
): EnumerationResult {
  const wanted = new Set(scopes);
  const entries: BackupEntry[] = [];
  const unclassifiedDatabases: string[] = [];
  const strippedMcpTokens = new Map<string, Set<string>>();

  const walk = (dir: string, relBase: string): void => {
    let dirents: Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      // ENOENT is the ordinary case and the only one: `~/.ethos/` never has
      // every directory this table names, and one that is absent holds nothing
      // to archive.
      //
      // Everything else — EACCES, EIO, EMFILE, ENOTDIR, a corrupt filesystem —
      // means this directory HAS contents that could not be read. Returning
      // empty there produces an archive that completes successfully while
      // silently missing whatever was under it, and nobody finds out until a
      // restore. Refuse instead. `createBackup` enumerates before it opens the
      // archive, so a throw here leaves any existing backup untouched.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown error';
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Cannot read "${dir}" while enumerating the backup (${code})`,
        action:
          'Fix the permission or filesystem error on that directory and retry. Refusing rather than writing an archive that would be silently missing what is under it.',
        details: { path: dir, code },
      });
    }
    for (const dirent of dirents) {
      if (dirent.isSymbolicLink()) continue;
      const rel = relBase ? `${relBase}/${dirent.name}` : dirent.name;
      const full = join(dir, dirent.name);
      if (dirent.isDirectory()) {
        // Prune whole subtrees that can never contribute — `plugins/node_modules`
        // alone is tens of thousands of files.
        if (ALWAYS_EXCLUDED.some((p) => underPath(rel, p))) continue;
        walk(full, rel);
        continue;
      }
      if (!dirent.isFile()) continue;

      if (MCP_TOKEN_FILENAMES.has(dirent.name)) {
        recordStrippedToken(rel, strippedMcpTokens);
        continue;
      }
      const { scope, unclassifiedDatabase } = classifyPath(rel);
      if (unclassifiedDatabase) unclassifiedDatabases.push(rel);
      if (scope === null || !wanted.has(scope)) continue;
      entries.push({
        path: rel,
        sourcePath: full,
        scope,
        database: isDatabasePath(rel),
        size: statSync(full).size,
      });
    }
  };

  walk(dataDir, '');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  unclassifiedDatabases.sort();
  return { entries, unclassifiedDatabases, strippedMcpTokens };
}

/** Parse a `--scope identity,state` value. Throws on an unknown name. */
export function parseScopes(raw: string): ScopeName[] {
  const out: ScopeName[] = [];
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (!name) continue;
    const match = ALL_SCOPES.find((s) => s === name);
    if (match === undefined) {
      throw new Error(`Unknown backup scope "${name}" — expected one of ${ALL_SCOPES.join(', ')}`);
    }
    if (!out.includes(match)) out.push(match);
  }
  return out;
}
