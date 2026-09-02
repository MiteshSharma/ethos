// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach substitution
// tokens (`${ETHOS_HOME}` etc.) are literal markers resolved at runtime, not JS
// template strings.
import { basename, join, resolve } from 'node:path';
import type { PersonalityConfig } from '@ethosagent/types';

/**
 * A personality's `fs_reach` is enforced at TWO layers — the app layer
 * (`ScopedStorage` read/write prefixes) and the OS layer (docker bind mounts).
 * This module is the SINGLE derivation both consume. When the two derivations
 * drift the failure is silent data loss: ScopedStorage permits a write to a
 * path the container never mounted, the container writes into its own ephemeral
 * layer, and `docker run --rm` discards it. One function, no copies.
 *
 * The derivation also yields the personality's WORKING DIRECTORY — the third
 * thing `fs_reach` decides. It lives here rather than in a sibling function
 * because the workdir *is* the `${CWD}` the read/write entries substitute
 * against; splitting them would reintroduce exactly the drift this module
 * exists to prevent.
 */

export class EmptySubstitutionError extends Error {
  readonly code = 'EMPTY_SUBSTITUTION';
  constructor(
    public readonly variable: string,
    public readonly template: string,
  ) {
    super(`Substitution variable ${variable} is empty/unresolved in fs_reach path "${template}"`);
    this.name = 'EmptySubstitutionError';
  }
}

/** Values the `fs_reach` substitution tokens resolve to. */
export interface FsReachVars {
  ethosHome: string;
  self: string;
  cwd: string;
}

/**
 * Resolve `${ETHOS_HOME}` / `${self}` / `${CWD}` in a DECLARED `fs_reach` path.
 *
 * Throws `EmptySubstitutionError` when a token present in the template maps to
 * an empty value: an explicitly-declared path whose substitution variable is
 * empty is a configuration error — fail loudly rather than synthesize a bogus
 * path (e.g. `${ETHOS_HOME}/skills` with an empty ethosHome yields `/skills`,
 * a path at the FILESYSTEM ROOT). Silently substituting is a security-relevant
 * miss, so the throwing semantics are the deliberate unification of the two
 * former copies.
 */
export function substitute(template: string, vars: FsReachVars): string {
  const checks: Array<[token: string, re: RegExp, value: string]> = [
    ['${ETHOS_HOME}', /\$\{ETHOS_HOME\}/g, vars.ethosHome],
    ['${self}', /\$\{self\}/g, vars.self],
    ['${CWD}', /\$\{CWD\}/g, vars.cwd],
  ];
  let out = template;
  for (const [token, re, value] of checks) {
    if (template.includes(token)) {
      if (value === '') throw new EmptySubstitutionError(token, template);
      out = out.replace(re, value);
    }
  }
  return out;
}

/**
 * The RAW, unsubstituted `fs_reach.workdir` entries a personality declares, in
 * declaration order. `[]` means "declares none" — including the `workdir: []`
 * case, which is truthy as a bare value but declares nothing.
 *
 * Empty entries are dropped. `workdir: ''` is the established "clear this"
 * convention (see the registry's update patch), and an empty entry that
 * survived would `resolve('')` to the process's launch directory — reinstating,
 * one array slot at a time, exactly the `process.cwd()` fallback the Documents
 * surface exists without.
 *
 * Every consumer that reaches for `personality.fs_reach?.workdir` needs this
 * `string | string[] | undefined` normalization, and each hand-rolled copy is a
 * chance to silently read only the first entry where every entry matters (the
 * constitution's `allowedMountRoots` check, an export bundle's disclosed
 * reach). Callers that want the RESOLVED, substituted paths want
 * `deriveFsReachPaths` (first entry only, the agent's single `${CWD}`) or
 * `deriveDocumentsRoots` (every entry) instead.
 */
export function declaredWorkdirs(personality: PersonalityConfig): string[] {
  const declared = personality.fs_reach?.workdir;
  if (declared === undefined) return [];
  return (Array.isArray(declared) ? declared : [declared]).filter(Boolean);
}

/** Trailing slashes are a prefix-matching artifact, not part of the identity. */
const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path);

/**
 * Add `workdir` to a derived list unless the list already reaches exactly it.
 * Trailing slash matches the `ownDir` convention.
 */
function withWorkdir(paths: string[], workdir: string): string[] {
  const target = trimSlash(workdir);
  return paths.some((path) => trimSlash(path) === target) ? paths : [`${workdir}/`, ...paths];
}

/**
 * Derive a personality's effective working directory and read/write reach.
 *
 * `workdir` is the declared `fs_reach.workdir`, substituted and resolved to an
 * absolute path; when undeclared it is `vars.cwd`. It then serves as the `cwd`
 * for the rest of the derivation — the workdir IS the personality's cwd, so
 * `${CWD}` in a read/write entry and the `cwd` entry in the defaults both mean
 * the workdir.
 *
 * `fs_reach.workdir` may declare MULTIPLE roots (`string[]`) for the Documents
 * surface (see `deriveDocumentsRoots` below) — but this function keeps its
 * existing single-root contract for the agent's own `${CWD}`/cwd purposes, so
 * only the FIRST declared entry is used here. Callers that need every declared
 * root (the Documents service) must call `deriveDocumentsRoots` instead.
 *
 * Declared `fs_reach.read` / `fs_reach.write` win when non-empty; each entry is
 * substituted. When a list is absent or empty the defaults apply:
 *
 *   read  = [ownDir, `${ethosHome}/skills/`, workdir]
 *   write = [ownDir, workdir]
 *
 * where `ownDir = ${ethosHome}/personalities/<self>/`. The defaults use the raw
 * variable values and never call `substitute`, so a personality that declares
 * nothing can never hit `EmptySubstitutionError`.
 *
 * A DECLARED workdir is additionally injected (deduped) into both lists: a
 * declared `write` REPLACES the defaults, so declaring both a workdir and a
 * write list would otherwise leave the workdir unwritable. The injection is
 * conditional on the workdir being declared — with no declaration the returned
 * lists are byte-for-byte what they were before `workdir` existed, so an
 * existing personality's reach is never silently widened to include the cwd.
 */
export function deriveFsReachPaths(
  personality: PersonalityConfig,
  vars: FsReachVars,
): { read: string[]; write: string[]; workdir: string } {
  const reach = personality.fs_reach;
  const declaredWorkdir = declaredWorkdirs(personality)[0];
  const workdir = declaredWorkdir ? resolve(substitute(declaredWorkdir, vars)) : vars.cwd;
  const effective: FsReachVars = { ...vars, cwd: workdir };

  const ownDir = `${join(effective.ethosHome, 'personalities', effective.self)}/`;
  const read =
    reach?.read && reach.read.length > 0
      ? reach.read.map((path) => substitute(path, effective))
      : [ownDir, `${join(effective.ethosHome, 'skills')}/`, effective.cwd];
  const write =
    reach?.write && reach.write.length > 0
      ? reach.write.map((path) => substitute(path, effective))
      : [ownDir, effective.cwd];

  if (!declaredWorkdir) return { read, write, workdir };
  return { read: withWorkdir(read, workdir), write: withWorkdir(write, workdir), workdir };
}

/**
 * The personality's ASSET FOLDER — the directory a `files://` URI addresses and
 * the one the asset-folder prompt injector advertises.
 *
 * A DECLARED `fs_reach.workdir` makes the asset folder BE the workdir, so the
 * personality has ONE output home: render-tool assets land where its bare
 * relative writes land, and the Documents tab (rooted at the same workdir)
 * lists them. With no declaration the historical location stands —
 * `<ethosHome>/personalities/<self>/files` — because the workdir would then be
 * `process.cwd()`, whatever directory the process happened to start in.
 *
 * The workdir comes from `deriveFsReachPaths`, never from a second copy of the
 * substitution rules: the asset folder must sit inside the personality's write
 * reach, and that is the only place the reach is decided. Throws
 * `EmptySubstitutionError` for the same reason `deriveFsReachPaths` does.
 */
export function personalityAssetDir(personality: PersonalityConfig, vars: FsReachVars): string {
  const { workdir } = deriveFsReachPaths(personality, vars);
  // First entry only, the same normalization `deriveFsReachPaths` applies.
  const declaredWorkdir = declaredWorkdirs(personality)[0];
  return declaredWorkdir ? workdir : join(vars.ethosHome, 'personalities', vars.self, 'files');
}

/**
 * Every Documents root a personality declares, each substituted and resolved
 * independently. Unlike `deriveFsReachPaths` (single `${CWD}`, first entry
 * only), this is the derivation the Documents service needs: every declared
 * `fs_reach.workdir` entry becomes its own browsable/writable root.
 *
 * Each entry substitutes against `vars` UNCHANGED — never against another
 * entry's resolved path. A workdir entry referencing `${CWD}` would be
 * self-referential (there is no "the" workdir once there can be several), so
 * this deliberately does NOT do what `deriveFsReachPaths` does for its
 * read/write lists (substituting against the *computed* workdir); every root
 * is resolved the same way the single entry always was, independently of its
 * siblings. In practice a workdir entry declaring `${CWD}` is unusual.
 *
 * Returns `[]` when `fs_reach.workdir` is unset — this is the "Documents
 * unconfigured" case. Unlike `deriveFsReachPaths`, there is NO fallback to
 * `vars.cwd` here: falling back would silently root Documents at the server
 * process's launch directory, which is exactly what the Documents surface
 * must not do (see `DocumentsService.resolve`).
 */
export function deriveDocumentsRoots(
  personality: PersonalityConfig,
  vars: FsReachVars,
): Array<{ label: string; workdir: string }> {
  return declaredWorkdirs(personality).map((template) => {
    const workdir = resolve(substitute(template, vars));
    return { label: basename(workdir), workdir };
  });
}
