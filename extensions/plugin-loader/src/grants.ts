// ---------------------------------------------------------------------------
// Plugin capability grants — a consent record, NOT a containment boundary
// ---------------------------------------------------------------------------
//
// A grant records that an operator was shown what a plugin declares it will do
// and agreed to install it anyway. That is all it is.
//
// It does not confine the plugin. `PluginLoader` `import()`s a plugin's entry
// module directly into this process: the plugin shares the process, the
// environment, the filesystem, and the API keys. Nothing here — and nothing
// anywhere else in the loader — restricts a plugin to the capabilities it
// declared. `capabilities` below is what the plugin SAID, shown to the operator
// so their consent means something; it is not a permission set that is enforced
// at runtime.
//
// The one thing a grant changes at load time is revocation: `PluginLoader`
// refuses to import a plugin whose grant is revoked. That stops the NEXT load.
// It cannot claw back anything an already-loaded plugin did — that code has
// already run as the user.
//
// Storage: one JSON map keyed by plugin id at `<pluginsDir>/grants.json`,
// following `lockfile.ts` (the closest precedent — a Storage-backed JSON record
// keyed by plugin id, with read/write helpers and no ambient fs access).
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import type { ScanFinding, TrustTier } from '@ethosagent/safety-scanner';
import type { Storage } from '@ethosagent/types';

const GRANTS_FILE = 'grants.json';

/**
 * The scan result exactly as it stood when the operator consented. Stored
 * verbatim rather than re-derived later: a reviewer needs to see what the
 * operator was shown, not what a scanner says about code that may have
 * changed since.
 */
export interface PluginGrantScan {
  tier: TrustTier;
  findings: ScanFinding[];
  hasRed: boolean;
  hasYellow: boolean;
}

/**
 * What the plugin DECLARED in `ethos.permissions`, as displayed at install.
 * Declarations are advisory: an undeclared capability is not blocked.
 */
export interface PluginGrantCapabilities {
  /** `ethos.permissions.shell` — declared intent to shell out. */
  shell: boolean;
  /**
   * `ethos.permissions.network`. `null` when nothing was declared, `[]` when
   * network was declared with no host restriction, otherwise the host list.
   */
  network: string[] | null;
}

export interface PluginGrant {
  /** Plugin id as the loader resolves it (`ethos.id`, else the unscoped name). */
  id: string;
  /** npm package name the grant was recorded for. */
  package: string;
  version: string;
  /** Where the code came from, e.g. `npm:@ethos-plugins/foo@1.2.3`. */
  source: string;
  /** Capabilities the operator was shown. Declared, not enforced. */
  capabilities: PluginGrantCapabilities;
  /** Scan findings as they were at install. */
  scan: PluginGrantScan;
  grantedAt: string;
  /** How consent was taken: an interactive answer, or the `--yes` flag. */
  consent: 'interactive' | 'flag';
  /** Set when the operator withdrew the grant. Blocks future loads only. */
  revokedAt?: string;
}

export type PluginGrants = Record<string, PluginGrant>;

export function grantsPath(pluginsDir: string): string {
  return join(pluginsDir, GRANTS_FILE);
}

/**
 * Shape check for one grant record.
 *
 * Dropping an entry is always the LESS restrictive outcome — the loader refuses
 * a load only when it finds a revoked grant (`isGrantRevoked`), so a dropped
 * revocation is an un-revocation. Validation here must therefore never be able
 * to turn a refusal into an allow: a record carrying `revokedAt` in any form is
 * kept, with the timestamp coerced to a string for display.
 *
 * Everything else is display material — a grant missing its `scan` block is a
 * poorer audit record, not a security decision. Only the lookup key is checked:
 * a record filed under one id while claiming another is not a record of
 * anything, and the auto-install gate reads `grants[id]` by key.
 */
function validateGrant(id: string, raw: unknown): { ok: true; grant: PluginGrant } | { ok: false } {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  const rec = raw as Record<string, unknown>;
  if (rec.revokedAt !== undefined) {
    return {
      ok: true,
      grant: { ...rec, id, revokedAt: String(rec.revokedAt) } as unknown as PluginGrant,
    };
  }
  if (typeof rec.id !== 'string' || rec.id !== id) return { ok: false };
  return { ok: true, grant: rec as unknown as PluginGrant };
}

export interface ReadGrantsOptions {
  /** Called once per entry that failed validation and was dropped. */
  onReject?: (id: string, reason: string) => void;
}

/**
 * Read the grant file. Missing file → no grants recorded yet.
 *
 * A malformed file throws rather than degrading to `{}` — an unreadable grant
 * file must not silently un-revoke every revocation in it. Callers on the load
 * path already treat a throw as "skip this plugin".
 *
 * An individually invalid entry inside a well-formed file is dropped and
 * reported through `onReject` instead, matching `readLockfile`: one unusable
 * record must not deny service to its siblings.
 */
export async function readGrants(
  storage: Storage,
  pluginsDir: string,
  opts: ReadGrantsOptions = {},
): Promise<PluginGrants> {
  const path = grantsPath(pluginsDir);
  const content = await storage.read(path);
  if (content === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Malformed ${GRANTS_FILE} at ${path}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Malformed ${GRANTS_FILE} at ${path}: expected a JSON object`);
  }

  const out: PluginGrants = {};
  for (const [id, raw] of Object.entries(parsed)) {
    const result = validateGrant(id, raw);
    if (!result.ok) {
      opts.onReject?.(id, 'grant record is not a well-formed grant for this id');
      continue;
    }
    out[id] = result.grant;
  }
  return out;
}

/**
 * Write the grant file atomically — a half-written consent record is worse than
 * none. The plugins dir may not exist yet on a first install, so create it.
 */
export async function writeGrants(
  storage: Storage,
  pluginsDir: string,
  grants: PluginGrants,
): Promise<void> {
  await storage.mkdir(pluginsDir);
  await storage.writeAtomic(grantsPath(pluginsDir), `${JSON.stringify(grants, null, 2)}\n`);
}

/**
 * Record consent for one plugin. A fresh grant replaces any earlier record for
 * the same id, including a revoked one — the operator installed it again and
 * was shown the consequence again.
 */
export async function recordGrant(
  storage: Storage,
  pluginsDir: string,
  grant: PluginGrant,
): Promise<void> {
  const grants = await readGrants(storage, pluginsDir);
  grants[grant.id] = grant;
  await writeGrants(storage, pluginsDir, grants);
}

/**
 * Withdraw a grant. The record is kept (with `revokedAt`) rather than deleted,
 * so the withdrawal is inspectable and so the loader has something to refuse
 * on. Returns false when there is nothing to revoke.
 */
export async function revokeGrant(
  storage: Storage,
  pluginsDir: string,
  id: string,
  at: string = new Date().toISOString(),
): Promise<boolean> {
  const grants = await readGrants(storage, pluginsDir);
  const existing = grants[id];
  if (!existing || existing.revokedAt) return false;
  grants[id] = { ...existing, revokedAt: at };
  await writeGrants(storage, pluginsDir, grants);
  return true;
}

/** True when a grant exists for `id` and has been withdrawn. */
export function isGrantRevoked(grants: PluginGrants, id: string): boolean {
  return grants[id]?.revokedAt !== undefined;
}

/**
 * The id the loader will use for a package: `ethos.id` when declared, else the
 * package name with any `@scope/` prefix stripped. Grants are keyed by this so
 * a revocation recorded by the CLI matches what the loader looks up.
 */
export function derivePluginId(pkgJson: unknown, fallbackName?: string): string {
  const raw = (pkgJson ?? {}) as { name?: unknown; ethos?: { id?: unknown } };
  const declared = raw.ethos?.id;
  if (typeof declared === 'string' && declared) return declared;
  const name = typeof raw.name === 'string' && raw.name ? raw.name : (fallbackName ?? '');
  return name.replace(/^@[^/]+\//, '');
}
