// ---------------------------------------------------------------------------
// plugins.lock — a pin, read from an artefact the operator did not write
// ---------------------------------------------------------------------------
//
// `plugins.lock` travels inside `ethos personality export` / `import` bundles,
// so every field in it is attacker-controlled the moment a personality is
// shared. The loader's auto-install path feeds `package`, `version` and
// `registry` to npm. Both halves of that are hardened here and at the sink:
//
//   1. This file validates every field before an entry is handed to any caller
//      (`validateLockEntry`), and
//   2. `installFromLockEntry` invokes npm through `execFileSync` with an argv
//      array — no shell, so there is nothing to quote or escape.
//
// Validation lives HERE rather than at the use site because `readLockfile` is
// exported and has callers outside this package (`ethos plugin install` does a
// read-modify-write of the same file). Validating at the single read point
// means no consumer can obtain an unvalidated entry; validating at the sink
// would leave the other consumers reading raw attacker data.
//
// Rejection, not repair: an entry that fails any check is dropped from the
// returned map and reported through `onReject`. The file on disk is never
// rewritten from here.
// ---------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Storage } from '@ethosagent/types';

export interface PluginLockEntry {
  package: string;
  version: string;
  registry: string;
  integrity: string;
}

export type PluginLockfile = Record<string, PluginLockEntry>;

const LOCKFILE_NAME = 'plugins.lock';

/** The registry npm uses when none is passed; entries naming it get no flag. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * npm package name: optional lowercase scope, then a lowercase name. Every
 * segment must START with `[a-z0-9]`, which is what makes this safe as an npm
 * argv element — it cannot be a `-flag` npm would interpret as its own option,
 * and it cannot be a `./` or `../` filesystem spec.
 *
 * Deliberately stricter than `SAFE_PKG_RE` in `apps/ethos/src/commands/backup.ts`
 * (`/^[@a-zA-Z0-9._/-]+$/`), which admits both of those: `--registry` and
 * `../../evil` both pass it.
 */
const NPM_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const NPM_NAME_MAX = 214;

/**
 * Exact semver only. A lockfile entry is a pin: a range is already wrong there,
 * and refusing anything but an exact version also refuses every npm spec form
 * that fetches code from somewhere other than the pinned registry release —
 * `file:../x`, `git+ssh://…`, `>=1 || 2`, `*`, `latest`.
 */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** `sha512-<base64>`, as produced by `computeIntegrity`. */
const INTEGRITY_RE = /^sha(?:256|384|512)-[A-Za-z0-9+/]+={0,2}$/;

/** Plugin id — the lockfile's key, and the key grants are looked up under. */
const PLUGIN_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

// The three predicates below are the single derivation of these rules. They are
// exported so the OTHER surface that installs an attacker-supplied package —
// `ethos personality import`, which reads `plugins[]` out of a bundle manifest
// rather than out of `plugins.lock` — applies the identical test instead of
// carrying a second, weaker copy of it. `isValidPluginId` is likewise the one
// definition the credential path guard in `index.ts` consults.

/** True when `value` is safe to hand to npm as a package-name argv element. */
export function isValidNpmPackageName(value: string): boolean {
  return value.length <= NPM_NAME_MAX && NPM_NAME_RE.test(value);
}

/** True when `value` is an exact semver version — no ranges, no npm specs. */
export function isExactVersion(value: string): boolean {
  return EXACT_VERSION_RE.test(value);
}

/** True when `value` is a plain plugin identifier, safe as one path segment. */
export function isValidPluginId(value: string): boolean {
  return value.length <= NPM_NAME_MAX && PLUGIN_ID_RE.test(value);
}

function checkRegistry(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'registry is not an absolute URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return `registry scheme "${url.protocol}" is not http(s)`;
  }
  if (url.username !== '' || url.password !== '') {
    return 'registry URL embeds credentials';
  }
  if (url.hostname === '') return 'registry URL has no host';
  return null;
}

export type LockEntryValidation =
  | { ok: true; entry: PluginLockEntry }
  | { ok: false; reason: string };

/**
 * Validate one `plugins.lock` entry. Returns the reason on failure so the
 * caller can say what it refused and why, rather than dropping it silently.
 */
export function validateLockEntry(id: unknown, raw: unknown): LockEntryValidation {
  if (typeof id !== 'string' || !isValidPluginId(id)) {
    return { ok: false, reason: 'plugin id is not a plain identifier' };
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, reason: 'entry is not an object' };
  }

  const { package: pkg, version, registry, integrity } = raw as Record<string, unknown>;

  if (typeof pkg !== 'string' || !isValidNpmPackageName(pkg)) {
    return { ok: false, reason: 'package is not a valid npm package name' };
  }
  if (typeof version !== 'string' || !isExactVersion(version)) {
    return { ok: false, reason: 'version is not an exact semver version' };
  }
  if (typeof registry !== 'string') {
    return { ok: false, reason: 'registry is not a string' };
  }
  const registryProblem = checkRegistry(registry);
  if (registryProblem !== null) return { ok: false, reason: registryProblem };

  if (typeof integrity !== 'string' || !INTEGRITY_RE.test(integrity)) {
    return { ok: false, reason: 'integrity is not a sha256/384/512 digest' };
  }

  return { ok: true, entry: { package: pkg, version, registry, integrity } };
}

export interface ReadLockfileOptions {
  /** Called once per entry that failed validation and was dropped. */
  onReject?: (id: string, reason: string) => void;
}

/**
 * Read and validate the lockfile. Missing file → no pins recorded.
 *
 * A malformed file THROWS rather than degrading to `{}` — an unreadable or
 * tampered lockfile must not be indistinguishable from a personality that pins
 * nothing, and `ethos plugin install` read-modify-writes this same file, so a
 * silent `{}` there would erase every surviving pin. Callers on the load path
 * treat a throw as "install nothing", matching `readGrants` in `grants.ts`.
 *
 * A well-formed file containing an individually invalid entry does NOT throw:
 * that entry is dropped and reported via `onReject`, so one bad pin cannot
 * deny service to the others.
 */
export async function readLockfile(
  storage: Storage,
  personalityDir: string,
  opts: ReadLockfileOptions = {},
): Promise<PluginLockfile> {
  const path = join(personalityDir, LOCKFILE_NAME);
  const content = await storage.read(path);
  if (content === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Malformed ${LOCKFILE_NAME} at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Malformed ${LOCKFILE_NAME} at ${path}: expected a JSON object`);
  }

  const out: PluginLockfile = {};
  for (const [id, raw] of Object.entries(parsed)) {
    const result = validateLockEntry(id, raw);
    if (!result.ok) {
      opts.onReject?.(id, result.reason);
      continue;
    }
    out[id] = result.entry;
  }
  return out;
}

export async function writeLockfile(
  storage: Storage,
  personalityDir: string,
  lockfile: PluginLockfile,
): Promise<void> {
  await storage.write(
    join(personalityDir, LOCKFILE_NAME),
    `${JSON.stringify(lockfile, null, 2)}\n`,
  );
}

export async function computeIntegrity(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  const hash = createHash('sha512').update(content).digest('base64');
  return `sha512-${hash}`;
}

export async function verifyIntegrity(
  filePath: string,
  expectedIntegrity: string,
): Promise<boolean> {
  try {
    const actual = await computeIntegrity(filePath);
    return actual === expectedIntegrity;
  } catch {
    return false;
  }
}
