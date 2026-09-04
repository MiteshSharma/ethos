// The secrets manifest that ships inside every archive — names, never values.
//
// `secrets/` is always excluded from a backup (D1), so a restored machine has
// every file it needs and none of the credentials. This manifest is the list
// of what is missing, built from the REAL vault via `SecretsResolver.list()`.
//
// The manifest `apps/ethos/src/commands/backup.ts` writes today reads
// `keys.json` instead, which is only the LLM key-rotation pool: a machine
// whose credentials all live in `~/.ethos/secrets/` gets an empty list and no
// warning. Every vault ref is enumerated here, grouped the way it is namespaced
// (`<key>`, `personalities/<id>/<key>`, and anything else verbatim).
//
// The one thing that never appears: a value. `list()` returns refs; `get()` is
// never called.

import { PersonalityScopedSecrets } from '@ethosagent/storage-fs';
import type { SecretsResolver } from '@ethosagent/types';

/** Archive-relative path of the manifest entry. */
export const SECRETS_MANIFEST_PATH = 'secrets.manifest.yaml';

const PERSONALITY_PREFIX = 'personalities/';

/**
 * Wrap one argument in POSIX single quotes, ending and reopening the quote
 * around every embedded `'`. Inside single quotes a shell expands nothing, so
 * spaces, `;`, `&`, backticks and `$(…)` are all literal.
 *
 * Every `fill_with:` line below exists to be PASTED into a terminal, and the
 * ref it names is a FILENAME in the vault — `SecretsResolver.list()` returns
 * whatever is on disk, and nothing on the read path re-checks it. A ref with a
 * space produces a broken command; one with `$(…)` or `;` produces a line that
 * runs something else entirely. The `- key:` lines are NOT quoted: those are
 * data the importer parses back, not a command.
 *
 * The same four lines live in `apps/ethos/src/commands/backup.ts`,
 * `extensions/cron/src/index.ts` and `apps/web`'s AddMcpModal. Copied rather
 * than shared because `packages/wiring` may not import from `apps/*`.
 */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Characters that must never reach a manifest line.
 *
 * Shell-quoting stops a metacharacter breaking out WITHIN a line. It does
 * nothing about a newline, because a newline does not break out of the shell —
 * it breaks out of the FORMAT. This manifest is line-oriented and assembled by
 * concatenation, so a ref containing `\n` writes extra `fill_with:` lines the
 * operator is told to paste and extra `- key:` lines the importer parses back
 * as data, all of them indistinguishable from ones this function meant to
 * write. Unix permits a newline in a filename and `FileSecretsResolver` does
 * not reject one in a ref, so `list()` really can return it.
 *
 * The class is every C0 control and DEL, the C1 range, and U+2028/U+2029 —
 * which YAML 1.1 treats as line breaks, so a real YAML reader would split on
 * them even though `split('\n')` does not.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const UNSAFE_IN_MANIFEST = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

/**
 * Render a refused name for the `# ` notice, on ONE line — a notice that split
 * the manifest would be the bug it is reporting. Escapes exactly the class
 * above, plus `"` and `\` so the rendering is unambiguous.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching them is the point
const ESCAPE_IN_NOTICE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029"\\]/gu;

function describeRefused(name: string): string {
  const escaped = name.replaceAll(
    ESCAPE_IN_NOTICE,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
  return `"${escaped}"`;
}

export interface SecretsManifestInit {
  /** The vault to enumerate. Only `list()` is called. */
  secrets: SecretsResolver;
  /** personality id → MCP server dirs whose OAuth tokens were stripped. */
  strippedMcpTokens: Map<string, Set<string>>;
  /** Overridable for deterministic tests. */
  now?: Date;
}

interface PersonalityEntry {
  /** Vault keys, relative to the personality's namespace. */
  secrets: string[];
  /** MCP servers whose token files were left out of the archive. */
  mcpServers: string[];
}

/**
 * Render the manifest. Refs are sorted so two backups of an unchanged vault
 * produce a byte-identical manifest apart from `backed_up_at`.
 *
 * A name carrying a control character is LEFT OUT and listed in a refusal
 * notice at the end, rather than failing the backup. A backup is the disaster
 * recovery artifact: refusing to produce one because a single vault filename is
 * hostile leaves the operator with nothing, which is strictly worse than an
 * archive with a loud gap. Nothing is lost by the omission either — `secrets/`
 * is excluded from the archive whatever this function does, so what is dropped
 * is the reminder, and the notice is that reminder in a form that cannot lie
 * about which lines are real.
 */
export async function buildSecretsManifest(init: SecretsManifestInit): Promise<string> {
  const refs = (await init.secrets.list()).slice().sort();

  const global: string[] = [];
  const other: string[] = [];
  const refused: string[] = [];
  const personalities = new Map<string, PersonalityEntry>();

  const entryFor = (id: string): PersonalityEntry => {
    let entry = personalities.get(id);
    if (!entry) {
      entry = { secrets: [], mcpServers: [] };
      personalities.set(id, entry);
    }
    return entry;
  };

  for (const ref of refs) {
    // One check covers all three identifiers a ref becomes: the ref itself, the
    // personality id sliced out of it, and the key after that.
    if (UNSAFE_IN_MANIFEST.test(ref)) {
      refused.push(ref);
      continue;
    }
    if (!ref.includes('/')) {
      global.push(ref);
      continue;
    }
    if (ref.startsWith(PERSONALITY_PREFIX)) {
      const rest = ref.slice(PERSONALITY_PREFIX.length);
      const slash = rest.indexOf('/');
      if (slash > 0) {
        entryFor(rest.slice(0, slash)).secrets.push(rest.slice(slash + 1));
        continue;
      }
    }
    other.push(ref);
  }

  for (const [id, servers] of init.strippedMcpTokens) {
    // A hostile id would split the `  <id>:` header AND every ref composed
    // under it, so the whole group goes rather than the servers one by one.
    if (UNSAFE_IN_MANIFEST.test(id)) {
      refused.push(`${PERSONALITY_PREFIX}${id}`);
      continue;
    }
    const entry = entryFor(id);
    for (const server of servers) {
      if (UNSAFE_IN_MANIFEST.test(server)) refused.push(server);
      else entry.mcpServers.push(server);
    }
  }

  const lines: string[] = [
    '# Generated by ethos backup — re-enter these secrets after restoring.',
    '# Names only: no secret value is ever written to an archive.',
    `backed_up_at: ${(init.now ?? new Date()).toISOString()}`,
  ];

  if (global.length > 0) {
    lines.push('', 'global:');
    for (const key of global) {
      lines.push(`  - key: ${key}`, `    fill_with: ethos secrets set ${shellQuote(key)} <value>`);
    }
  }

  const ids = [...personalities.keys()].sort();
  if (ids.length > 0) {
    lines.push('', 'personalities:');
    for (const id of ids) {
      const entry = personalities.get(id);
      if (!entry) continue;
      lines.push(`  ${id}:`);
      if (entry.secrets.length > 0) {
        lines.push('    secrets:');
        for (const key of entry.secrets.slice().sort()) {
          const ref = `${PERSONALITY_PREFIX}${id}/${key}`;
          lines.push(
            `      - key: ${key}`,
            `        fill_with: ethos secrets set ${shellQuote(ref)} <value>`,
          );
        }
      }
      if (entry.mcpServers.length > 0) {
        lines.push('    mcp_auth:');
        for (const server of [...new Set(entry.mcpServers)].sort()) {
          lines.push(
            `      - server: ${server}`,
            `        fill_with: ethos mcp auth ${shellQuote(server)}`,
          );
        }
      }
    }
  }

  if (other.length > 0) {
    lines.push('', 'other:');
    for (const ref of other) {
      lines.push(`  - key: ${ref}`, `    fill_with: ethos secrets set ${shellQuote(ref)} <value>`);
    }
  }

  if (refused.length > 0) {
    // Comment lines: both this package's `parseSecretsManifest` and the CLI's
    // `parseVaultManifest` skip `#`, so the notice is read by the operator and
    // by nothing else.
    lines.push(
      '',
      `# ⚠ ${refused.length} name(s) LEFT OUT of this manifest — each contains a control`,
      '#   character, which would have split it into lines that are not what they',
      '#   look like. Rename them in the vault and back up again; until then they',
      '#   are not listed above and will not be refilled:',
    );
    for (const name of refused.slice().sort()) lines.push(`#     ${describeRefused(name)}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Injection — the operator-written manifest that carries values
// ---------------------------------------------------------------------------
//
// A separate, simpler format from the one above, unchanged from the CLI's
// implementation so existing manifests keep working:
//
//   global:
//     KEY: value
//   personalities:
//     <id>:
//       KEY: value
//
// Values are trimmed; a matching pair of quotes is stripped. `#` comments and
// blank lines are ignored. An EMPTY value is skipped rather than written — a
// half-filled template must not overwrite a good secret with ''.

interface ParsedSecrets {
  global: Map<string, string>;
  personalities: Map<string, Map<string, string>>;
}

function stripQuotes(s: string): string {
  if (s.length >= 2 && ((s[0] === '"' && s.at(-1) === '"') || (s[0] === "'" && s.at(-1) === "'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseSecretsManifest(raw: string): ParsedSecrets {
  const global = new Map<string, string>();
  const personalities = new Map<string, Map<string, string>>();

  let section: 'none' | 'global' | 'personalities' = 'none';
  let currentPersonality: string | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.trimStart().startsWith('#')) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0 && trimmed.endsWith(':')) {
      const header = trimmed.slice(0, -1);
      if (header === 'global') {
        section = 'global';
        currentPersonality = undefined;
      } else if (header === 'personalities') {
        section = 'personalities';
        currentPersonality = undefined;
      } else {
        section = 'none';
        currentPersonality = undefined;
      }
      continue;
    }

    if (section === 'personalities' && indent === 2 && trimmed.endsWith(':')) {
      currentPersonality = trimmed.slice(0, -1).trim();
      if (!personalities.has(currentPersonality)) personalities.set(currentPersonality, new Map());
      continue;
    }

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx < 0) continue;
    const key = trimmed.slice(0, colonIdx).trim();
    const value = stripQuotes(trimmed.slice(colonIdx + 1).trim());
    if (!key || !value) continue;

    if (section === 'global' && indent >= 2) {
      global.set(key, value);
    } else if (section === 'personalities' && indent >= 4 && currentPersonality) {
      const pMap = personalities.get(currentPersonality);
      if (pMap) pMap.set(key, value);
    }
  }

  return { global, personalities };
}

/**
 * One validated write: the full vault ref, the namespace it lands in, and the
 * value bound for it.
 *
 * `value` is a SECRET. Nothing may print, log, serialize or interpolate a
 * `PreparedWrite` — only its `ref`. Unexported for exactly that reason: no
 * caller outside this module has a name for the shape that carries values.
 */
interface PreparedWrite {
  /** Full vault ref, already checked by `refError`. What the writer reports. */
  ref: string;
  /** Personality namespace. Absent for a global key. */
  personality?: string;
  /** Key relative to its namespace — what `SecretsResolver.set` is called with. */
  key: string;
  /** The secret value. Never leaves this array except into the vault. */
  value: string;
}

/**
 * The brand that makes a `PreparedSecrets` unforgeable. It is `declare`d, so it
 * has no runtime existence, and it is not exported, so no module outside this
 * one can name it — which is what stops `injectSecrets` from accepting an array
 * that never went through `prepareSecrets`.
 */
declare const preparedSecretsBrand: unique symbol;

/**
 * A parsed, fully validated manifest, in write order. Empty means the manifest
 * carries nothing injectable — no `global:`/`personalities:` section, or only
 * entries the parser skips.
 *
 * The brand below is the enforcement, not a convention: an array assembled
 * anywhere else is missing `[preparedSecretsBrand]` and is rejected by the
 * compiler at `injectSecrets`, down to and including a direct `as` cast. Only
 * `prepareSecrets` — which validates every ref first — can produce one.
 */
export interface PreparedSecrets extends ReadonlyArray<PreparedWrite> {
  readonly [preparedSecretsBrand]: never;
}

/** Either a ready-to-write manifest or the first ref that is not writable. */
export type PrepareSecretsResult =
  | { ok: true; prepared: PreparedSecrets }
  | { ok: false; failedRef: string; error: string };

/**
 * What `injectSecrets` did. There is no transaction across a `SecretsResolver`,
 * so a write that fails after earlier ones succeeded leaves the vault half
 * filled — and this result says so rather than pretending otherwise.
 *
 * Refs only. No field carries a secret VALUE, including `error` — which comes
 * from a possibly third-party resolver and is therefore run through
 * `redactValue` rather than trusted.
 */
export interface InjectSecretsResult {
  /** Refs that ARE in the vault, in write order. Empty when nothing was written. */
  writtenRefs: string[];
  /** The ref whose write was refused or failed. Absent when everything landed. */
  failedRef?: string;
  /** Why it failed. Absent when everything landed. */
  error?: string;
}

/**
 * Mirror of the ref rules `FileSecretsResolver.set` enforces — its `validateRef`
 * is module-private, and `packages/wiring` cannot reach into it.
 *
 * A mirror can drift, and a resolver other than the file one may refuse for
 * reasons this cannot know. That is exactly why a write failure is still
 * reported as partial below rather than assumed impossible.
 *
 * The control-character rule is deliberately STRICTER than the resolver's, not
 * drift: the resolver would happily create a vault file whose NAME contains a
 * newline, and the next backup's manifest would then have to leave it out. A
 * ref is refused at the door instead.
 */
function refError(ref: string): string | undefined {
  if (ref === '') return 'Secret ref must not be empty';
  if (ref.includes('\0')) return 'Secret ref must not contain NUL bytes';
  if (UNSAFE_IN_MANIFEST.test(ref)) {
    // The ref itself is NOT interpolated: it is what carries the control
    // characters, and this message is printed to a terminal.
    return `Secret ref must not contain control characters: ${describeRefused(ref)}`;
  }
  if (ref.includes('\\')) return `Secret ref must not contain backslashes: ${ref}`;
  if (ref.startsWith('/') || /^[A-Za-z]:/.test(ref)) {
    return `Secret ref must not be an absolute path: ${ref}`;
  }
  const segments = ref.split('/');
  if (segments.some((seg) => seg === '..')) return `Secret ref must not contain "..": ${ref}`;
  if (segments.some((seg) => seg === ''))
    return `Secret ref must not contain empty segments: ${ref}`;
  return undefined;
}

/**
 * Parse an operator-written manifest and validate EVERY destination ref, with
 * no vault and no writes. Personality-scoped keys are composed into the
 * `personalities/<id>/<key>` ref the wrapper below will actually write, so what
 * is validated here is what reaches the vault.
 *
 * This is the only place manifest TEXT becomes writable: `injectSecrets` takes
 * the result and cannot re-parse or re-validate, so a caller that checks a
 * manifest ahead of a destructive step and a caller that writes one are
 * checking the same value by the same rule. A caller that already holds
 * structured pairs enters at `prepareSecretEntries` below, which this delegates
 * to — same composition, same validation, same brand.
 */
export function prepareSecrets(raw: string): PrepareSecretsResult {
  const parsed = parseSecretsManifest(raw);

  const entries: SecretEntryInput[] = [];
  for (const [key, value] of parsed.global) {
    entries.push({ key, value });
  }
  for (const [id, kvs] of parsed.personalities) {
    for (const [key, value] of kvs) {
      entries.push({ personality: id, key, value });
    }
  }

  return prepareSecretEntries(entries);
}

/**
 * One destination and the value bound for it, as a caller that already HAS the
 * pair holds it — a prompt walk that read the archive's manifest, say.
 *
 * `value` is a SECRET. Nothing may print, log, serialize or interpolate one of
 * these; only `key` and `personality` are names.
 */
export interface SecretEntryInput {
  /** Personality namespace. Absent for a global key. */
  personality?: string;
  /** Key relative to its namespace. */
  key: string;
  /** The secret value, exactly as it should land in the vault. */
  value: string;
}

/**
 * The same preparation as `prepareSecrets`, entered from structured pairs
 * instead of manifest text.
 *
 * This exists so a caller holding parsed key/value pairs does not have to
 * serialise them into manifest text purely so `prepareSecrets` can take them
 * apart again — a round trip through a line-oriented, colon-delimited format
 * that silently mis-splits any key containing a `:` and manufactures entries
 * from any key containing a newline. There is no text intermediate here, so
 * there is no delimiter to misread.
 *
 * Every ref is composed and validated by exactly the code `prepareSecrets`
 * uses, and this is the one construction site of the brand for both.
 */
export function prepareSecretEntries(entries: readonly SecretEntryInput[]): PrepareSecretsResult {
  const prepared: PreparedWrite[] = entries.map((entry) =>
    entry.personality === undefined
      ? { ref: entry.key, key: entry.key, value: entry.value }
      : {
          ref: `${PERSONALITY_PREFIX}${entry.personality}/${entry.key}`,
          personality: entry.personality,
          key: entry.key,
          value: entry.value,
        },
  );

  for (const entry of prepared) {
    const error = refError(entry.ref);
    if (error !== undefined) return { ok: false, failedRef: entry.ref, error };
  }
  // The one construction site of the brand, and the only place the cast is
  // allowed. `preparedSecretsBrand` is `declare`d, so there is no property to
  // add at runtime — the value stays a plain array and the brand exists only in
  // the type system, which is where the "went through `prepareSecrets`" fact
  // needs to be carried.
  return { ok: true, prepared: prepared as unknown as PreparedSecrets };
}

/**
 * Strip every occurrence of the value being written out of a message before it
 * is stored on the result.
 *
 * `SecretsResolver` is an interface with third-party implementations, and a
 * foreign `set()` is free to put the rejected value in its exception text.
 * That message is printed by the CLI and serialised into `--json`, so it is the
 * one place a value can cross a boundary that promises names only.
 *
 * Redaction rather than a fixed generic string: `EACCES` and `ENOSPC` are
 * different problems with different fixes, and an operator staring at a
 * half-filled vault needs to tell them apart. Substring removal keeps that
 * detail and still makes a verbatim leak impossible.
 *
 * It cannot catch a value a resolver ENCODES (base64, a truncated prefix). The
 * defence against that is the resolver not doing it; this is the defence
 * against the case that actually happens.
 */
function redactValue(message: string, value: string): string {
  if (value.length === 0) return message;
  return message.split(value).join('[value redacted]');
}

/**
 * Write a prepared manifest into `secrets`. Personality-scoped keys land under
 * `personalities/<id>/` via the same wrapper the rest of the system writes them
 * with — which only prefixes, so the ref `prepareSecrets` validated is the one
 * that reaches the vault.
 *
 * Never throws for a failed write: the caller reports what landed.
 */
export async function injectSecrets(
  prepared: PreparedSecrets,
  secrets: SecretsResolver,
): Promise<InjectSecretsResult> {
  const writtenRefs: string[] = [];
  for (const entry of prepared) {
    try {
      const target =
        entry.personality === undefined
          ? secrets
          : new PersonalityScopedSecrets(secrets, entry.personality);
      await target.set(entry.key, entry.value);
    } catch (err) {
      return {
        writtenRefs,
        failedRef: entry.ref,
        error: redactValue(err instanceof Error ? err.message : String(err), entry.value),
      };
    }
    writtenRefs.push(entry.ref);
  }
  return { writtenRefs };
}
