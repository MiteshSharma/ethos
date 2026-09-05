// `ethos backup` / `ethos import` — thin shims over the backup core.
//
// Everything that decides WHAT goes into an archive, how a live database is
// copied consistently, and whether a restore is safe lives in
// `packages/wiring/src/backup/`. That core is library code: it returns reports
// and never prints. This file is the other half — flags, prompts and the words
// an operator reads.
//
// The ustar helpers further down are NOT the backup format. They belong to the
// personality-bundle path (`ethos personality export` / `ethos personality
// import`), which is a different archive with a different manifest, and they
// stay until that lane is moved onto the streaming writer too.

import { execFileSync } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createGzip } from 'node:zlib';
import { type EthosConfig, ethosDir, readRawConfig } from '@ethosagent/config';
import { isExactVersion, isValidNpmPackageName, isValidPluginId } from '@ethosagent/plugin-loader';
import { type BundleManifest, EthosError } from '@ethosagent/types';
import {
  ALL_SCOPES,
  acquireBackupLock,
  type BackupResult,
  backupDirectory,
  createBackup,
  DEFAULT_SCOPES,
  type InjectSecretsResult,
  injectSecrets,
  type PreparedSecrets,
  parseScopes,
  prepareSecretEntries,
  prepareSecrets,
  type RestoreReport,
  restoreBackup,
  type ScopeName,
  type SecretEntryInput,
} from '@ethosagent/wiring';
import { writeJson } from '../json-output';
import { getSecretsResolver, getStorage } from '../wiring';
import { hasFlag, parseFlagValue } from './serve-helpers';

const USAGE_BACKUP =
  'Usage: ethos backup [--out <path>] [--scope identity,state,telemetry] [--bootstrap] [--json]';
const USAGE_IMPORT =
  'Usage: ethos import <archive> [--scope <names>] [--dry-run] [--force] [--secrets <file | - | prompt>] [--json]';

/**
 * Where `ethos backup` writes when no path is given (plan D5, `backup.dir`).
 *
 * One resolver for the whole system: the scheduled job, `ethos status` and this
 * command all go through `backupDirectory`, so an operator who sets
 * `backup.dir` does not get `status` reading one directory while `ethos backup`
 * writes into another. Config is optional — a deployment that has none still
 * gets `<ethosDir>/backups`.
 */
export function defaultBackupDir(config?: EthosConfig | null): string {
  return backupDirectory(config ?? undefined);
}

// ---------------------------------------------------------------------------
// ethos backup
// ---------------------------------------------------------------------------

export async function runBackup(argv: string[]): Promise<void> {
  const jsonMode = argv.includes('--json');
  const bootstrap = hasFlag(argv, ['--bootstrap']);

  const requested = readScopes(argv);
  if (requested.error !== undefined) {
    return fail(jsonMode, 'scope_invalid', requested.error, [USAGE_BACKUP]);
  }
  const scopes = requested.scopes ?? [...DEFAULT_SCOPES];

  const outFlag = parseFlagValue(argv, ['--out']);
  if (outFlag === '') {
    return fail(jsonMode, 'input_invalid', '--out requires a path.', [USAGE_BACKUP]);
  }
  // Config is consulted here for exactly one thing: which directory to write
  // into. `serve`/`gateway`/`status` are right to refuse to start on a broken
  // config; this is the get-my-data-out command, and a broken config is
  // precisely when someone needs it to work. So a config that will not parse
  // degrades to the default directory and says so.
  //
  // Deliberately narrow, and narrower than the intent above: only THIS read is
  // caught. The command still refuses on a config that will not parse, because
  // `getSecretsResolver()` below reaches `readRawConfig` a SECOND time —
  // `initSecrets` in `apps/ethos/src/wiring.ts`, uncaught — and `readRawConfig`
  // is not memoised, so the same parse error throws again there. Making
  // degrade-and-continue actually hold means catching that call too; that is a
  // behaviour change and is not made here.
  let config: EthosConfig | null = null;
  let configFallback: string | undefined;
  try {
    config = await readRawConfig(getStorage());
  } catch (err) {
    // `describeError` on a config parse error names the field and the rule
    // (`Invalid backup.keep "0"` …), never a credential — `readRawConfig` does
    // not resolve `${secrets:…}` refs, and the plaintext-secret check reports
    // the field, not the value.
    configFallback =
      `${join(ethosDir(), 'config.yaml')} could not be read (${describeError(err)}) — ` +
      `backup.dir was ignored; the default backup directory ${defaultBackupDir()} was used.`;
  }
  const backupDir = defaultBackupDir(config);
  const positional = positionalArgs(argv, ['--out', '--scope']);
  const outPath = resolve(outFlag ?? positional[0] ?? join(backupDir, defaultArchiveName()));

  const dataDir = ethosDir();

  // The other half of the `backups/.lock` sentinel the scheduled job takes
  // (plan §3). Without it the lock is one-directional: the 04:00 job waits for
  // a manual run that never holds anything, and the two stream the same
  // databases into two archives at once.
  //
  // The race is over the SOURCE, not the destination, so the lock is taken even
  // when `--out` points somewhere else entirely.
  //
  // No wait (`timeoutMs: 0`): the scheduled job can afford to block for five
  // seconds because it has nowhere to report to. A person at a terminal is
  // better served by an immediate refusal naming what holds the lock than by a
  // stall that ends in the same refusal. Stale locks are still reclaimed —
  // that is the helper's job, not this one's.
  let release: () => void;
  try {
    release = await acquireBackupLock(backupDir, { timeoutMs: 0 });
  } catch (err) {
    return fail(jsonMode, 'backup_locked', describeError(err));
  }

  let result: BackupResult;
  try {
    // The CLI is a command-line process, so it may block on `VACUUM INTO` (D2).
    // Only a serving process is required to use the async `backup()` copy.
    result = await createBackup({
      dataDir,
      outPath,
      scopes,
      snapshot: 'vacuum',
      secrets: await getSecretsResolver(),
    });
  } finally {
    // A failed backup must not leave the directory locked — the next run, and
    // the next scheduled one, would be refused by a holder that is long gone.
    release();
  }

  const command = bootstrapCommand(result.path, result.scopes);
  const restore = restoreCommand(result.path);

  if (jsonMode) {
    writeJson({
      ok: true,
      path: result.path,
      scopes: result.scopes,
      fileCount: result.fileCount,
      bytes: result.bytes,
      createdAt: result.manifest.createdAt,
      unclassifiedDatabases: result.unclassifiedDatabases,
      skippedFiles: result.skippedFiles,
      sensitive: result.scopes.includes('state'),
      ...(configFallback ? { configFallback } : {}),
      // Both printed lines that embed the archive path, so a caller reading the
      // JSON never has to re-quote it. The two constant lines (the bare
      // installer and `ethos doctor`) carry no path and stay printed-only.
      ...(bootstrap ? { bootstrapRestore: restore, bootstrap: command } : {}),
    });
    return;
  }

  console.log(`✓ Backup written to: ${result.path}`);
  console.log(
    `  ${result.fileCount} file(s), ${formatBytes(result.bytes)} · scopes: ${result.scopes.join(', ')}`,
  );
  if (configFallback) console.log(`  ⚠ ${configFallback}`);
  if (result.scopes.includes('state')) {
    console.log('');
    console.log('  The state scope carries conversation history (sessions, cards, memory).');
    console.log('  Treat it as sensitive as the machine it came from.');
  }
  console.log('');
  console.log('  API keys and MCP tokens were NOT archived. The archive lists what is');
  console.log('  missing in secrets.manifest.yaml — refill with `ethos import --secrets prompt`.');
  for (const db of result.unclassifiedDatabases) {
    console.log(`  ⚠ ${db} is a database no scope owns — it was NOT archived.`);
  }
  // A file the writer could not encode is dropped rather than fatal (one bad
  // name must not cost the whole archive), so this loop is the only thing
  // standing between that drop and a silent one. `fileCount` above already
  // excludes them, so the two lines cannot disagree about what is in there.
  for (const skip of result.skippedFiles) {
    console.log(`  ⚠ ${skip.path} was NOT archived — ${skip.reason}.`);
  }
  if (bootstrap) {
    console.log('');
    console.log('  To restore this backup on a new machine, copy the archive there, then:');
    console.log('');
    console.log(`    ${restore}`);
    console.log('    ethos doctor');
    console.log('');
    console.log('  That installs Ethos, verifies the archive, and imports it in one step.');
    console.log('  A piped install cannot prompt for secrets — stdin is the installer itself —');
    console.log('  so it prints the `ethos secrets set` lines to run afterwards. When you want');
    console.log('  those prompts, or only some of the scopes, install and import separately:');
    console.log('');
    console.log('    curl -fsSL https://ethosagent.ai/install.sh | bash');
    console.log(`    ${command}`);
    console.log('    ethos doctor');
  }
}

/** Default archive name. The random suffix keeps two runs in one second apart. */
function defaultArchiveName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `ethos-backup-${stamp}-${randomBytes(4).toString('hex')}.tar.gz`;
}

/**
 * Wrap one argument in POSIX single quotes, ending and reopening the quote
 * around every embedded `'`. Inside single quotes a shell expands nothing, so
 * spaces, `;`, `&`, backticks and `$(…)` are all literal.
 *
 * The same four lines live in five other places —
 * `packages/wiring/src/backup/secrets-manifest.ts`,
 * `apps/ethos/src/commands/personality-export.ts`,
 * `apps/ethos/src/lib/tui-capabilities.ts`, `extensions/cron/src/index.ts` and
 * `apps/web`'s AddMcpModal — six copies in all. Copied rather than shared: each
 * surface keeps its own module-private copy. The index is spelled out in full
 * deliberately: an incomplete one is what makes the consolidation follow-up
 * impossible to scope.
 */
function shellQuote(arg: string): string {
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * The one command that restores this archive somewhere else (plan §4).
 *
 * The path is operator-supplied (`--out`) and this line exists specifically to
 * be PASTED into a shell on a new machine, so it is quoted: unquoted, a path
 * with a space produces a broken command and a path with `$(…)` or `;` in it
 * produces a line that runs something else entirely.
 *
 * The scopes are not quoted. They are `ScopeName`s that `parseScopes` already
 * checked against a closed list, so there is nothing in them a shell could read.
 */
function bootstrapCommand(archivePath: string, scopes: readonly ScopeName[]): string {
  return `ethos import ${shellQuote(archivePath)} --scope ${scopes.join(',')} --secrets prompt`;
}

/**
 * The same restore in one step, via `--restore` in `docs/static/install.sh`:
 * install, `ethos import --dry-run` to verify the archive, then the real
 * import. It is the normal case, but it cannot replace `bootstrapCommand` —
 * the installer refuses `--restore` alongside `--setup`, takes a local path
 * and not a URL, and under `curl … | bash` stdin is the script, so it never
 * reaches `--secrets prompt`. It also imports the whole archive, with no
 * `--scope`. The two-step form is what an operator falls back to for any of
 * those, so both are printed.
 *
 * Quoted for the same reason `bootstrapCommand` is: the path is the operator's
 * (`--out`) and this line is written to be pasted into a shell.
 */
function restoreCommand(archivePath: string): string {
  return `curl -fsSL https://ethosagent.ai/install.sh | bash -s -- --restore ${shellQuote(archivePath)}`;
}

/**
 * The line an operator is told to paste after a personality import (G5+G6).
 *
 * `personalityId` comes off the imported archive — `manifest.personalityId` on
 * the bundle path, a `personalities/<id>/` path SEGMENT on the legacy one — so
 * whoever authored the archive chose it. `VALID_ID_RE` rejects anything but
 * alphanumerics, hyphens and underscores in both branches before control
 * reaches here, and that check is the lock that matters; this quoting is the
 * second one on the same door, so the paste line stays a single safe word even
 * if a later caller prints it without having gone through that gate.
 */
export function doctorCommand(personalityId: string): string {
  return `ethos personality doctor ${shellQuote(personalityId)}`;
}

// ---------------------------------------------------------------------------
// ethos import
// ---------------------------------------------------------------------------

export async function runImport(argv: string[]): Promise<void> {
  const jsonMode = argv.includes('--json');
  const dryRun = hasFlag(argv, ['--dry-run']);
  const force = hasFlag(argv, ['--force']);

  const secretsArg = parseFlagValue(argv, ['--secrets']);
  if (secretsArg === '' || secretsArg?.startsWith('--')) {
    return fail(
      jsonMode,
      'input_invalid',
      '--secrets requires a manifest file, "-" for stdin, or "prompt".',
      [USAGE_IMPORT],
    );
  }

  // `--secrets prompt` is a walk on the TTY — questions, notices and OAuth
  // command hints. `--json` promises one machine-readable document on stdout.
  // The two cannot both be honoured, so refuse the combination outright rather
  // than interleave prompts with the payload. Everything else this command
  // prints under `--json` is the JSON document and nothing else.
  if (jsonMode && secretsArg === 'prompt') {
    return fail(
      jsonMode,
      'input_invalid',
      '--secrets prompt is interactive and cannot be combined with --json.',
      ['Pass --secrets <file> or --secrets - instead, or drop --json.', USAGE_IMPORT],
    );
  }

  const requested = readScopes(argv);
  if (requested.error !== undefined) {
    return fail(jsonMode, 'scope_invalid', requested.error, [USAGE_IMPORT]);
  }
  const scopes = requested.scopes;

  const archivePath = positionalArgs(argv, ['--scope', '--secrets'])[0];
  if (!archivePath) return fail(jsonMode, 'input_invalid', 'No archive given.', [USAGE_IMPORT]);
  if (!existsSync(archivePath)) {
    return fail(jsonMode, 'file_not_found', `File not found: ${archivePath}`);
  }

  // Read, parse and VALIDATE the whole secrets payload before the restore
  // commits. A typo'd path, an unreadable file, a stdin that never arrives, a
  // ref the vault would refuse, or a manifest with nothing injectable in it
  // must fail with the tree untouched — after the restore, the same failure can
  // only be reported, not undone.
  //
  // `prepareSecrets` is the same step `injectSecrets` is fed below, so the
  // check made here and the write made later cannot disagree about what is
  // writable.
  //
  // `prompt` is the one source that cannot move earlier: its questions are
  // built from `report.secretsManifest`, which does not exist until the archive
  // has been read. It stays below, and the split outcome is what keeps its
  // failure from reading as a failed restore.
  let payload: PreparedSecrets | null = null;
  if (!dryRun && secretsArg !== undefined && secretsArg !== 'prompt') {
    let raw: string;
    try {
      raw = await readSecretsSource(secretsArg);
    } catch (err) {
      // The path and the reason. Never any part of the file's contents.
      return fail(jsonMode, 'secrets_unreadable', describeError(err), [USAGE_IMPORT]);
    }
    const source =
      secretsArg === '-' ? 'The secrets manifest on stdin' : `Secrets manifest ${secretsArg}`;
    // `error` and `failedRef` name a ref and a rule. Never a value — and the
    // prepared writes, which DO carry values, are never interpolated anywhere.
    const preflight = prepareSecrets(raw);
    if (!preflight.ok) {
      return fail(jsonMode, 'secrets_invalid', `${source} cannot be injected: ${preflight.error}`, [
        USAGE_IMPORT,
      ]);
    }
    if (preflight.prepared.length === 0) {
      return fail(
        jsonMode,
        'secrets_invalid',
        `${source} has no values under a \`global:\` or \`personalities:\` section — nothing would be injected.`,
        [USAGE_IMPORT],
      );
    }
    payload = preflight.prepared;
  }

  const report = await restoreBackup({
    dataDir: ethosDir(),
    archivePath,
    ...(scopes ? { scopes } : {}),
    dryRun,
    force,
  });

  // The restore has committed. From here, injecting secrets is a SECOND
  // outcome: it can fail over a tree that is fully restored, and saying "the
  // import failed" about that would be false where it matters most.
  const secrets = await applySecrets(secretsArg, payload, report, dryRun);

  if (jsonMode) {
    writeJson({
      // `ok` is the whole command; `restoreOk` is the destructive half alone.
      // They differ exactly when the files landed and the vault write did not.
      ok: secrets.error === undefined,
      restoreOk: true,
      dryRun: report.dryRun,
      scopes: report.scopes,
      createdAt: report.createdAt,
      restored: report.restored,
      skipped: report.skipped,
      displaced: report.displaced,
      ...(report.displacedTo ? { displacedTo: report.displacedTo } : {}),
      inUseCheck: report.inUseCheck,
      lockedDatabases: report.lockedDatabases,
      restartRequired: report.restartRequired,
      warnings: report.warnings,
      ...(secrets.injected === null ? {} : { secretsInjected: secrets.injected }),
      // The three outcomes, tellable apart without reading prose: `ok` alone
      // means everything landed; `ok: false` with `secretsInjected: 0` means
      // nothing did; `ok: false` with a non-zero count means the vault is
      // half filled, and `secretsWrittenRefs` is exactly which half.
      ...(secrets.error === undefined
        ? {}
        : {
            secretsWrittenRefs: secrets.writtenRefs ?? [],
            ...(secrets.failedRef === undefined ? {} : { secretsFailedRef: secrets.failedRef }),
            secretsError: secrets.error,
          }),
    });
    if (secrets.error !== undefined) process.exitCode = 1;
    return;
  }

  printRestoreReport(report, secrets);
  if (secrets.error !== undefined) process.exitCode = 1;
}

function printRestoreReport(report: RestoreReport, secrets: SecretsOutcome): void {
  const verb = report.dryRun ? 'Would restore' : 'Restored';
  console.log(
    `${report.dryRun ? '·' : '✓'} ${verb} ${report.restored.length} file(s) into ${ethosDir()}`,
  );
  console.log(
    `  scopes: ${report.scopes.join(', ') || 'none'} · archive created ${report.createdAt}`,
  );
  if (report.dryRun) {
    console.log('  Dry run — nothing on disk was changed.');
  }

  if (report.displaced.length > 0) {
    const where = report.displacedTo ?? '.pre-restore/<timestamp>';
    console.log(
      `  ${report.displaced.length} existing file(s) ${report.dryRun ? 'would be moved' : 'moved'} to ${where}/`,
    );
  }
  if (report.skipped.length > 0) {
    console.log(`  ${report.skipped.length} archive entry/entries were not restored.`);
  }

  // `lockedDatabases: []` is not "nothing was running" — it is only that when
  // the check actually ran. Say which of the two this is, every time.
  console.log('');
  if (report.inUseCheck === 'held') {
    console.log(
      report.lockedDatabases.length > 0
        ? `  in-use check: ran — ${report.lockedDatabases.length} database(s) were idle and held for the restore.`
        : '  in-use check: ran — there was no existing database to displace.',
    );
  } else if (report.inUseCheck === 'skipped_dry_run') {
    console.log('  in-use check: NOT made — a dry run cannot take the locks that answer it.');
    console.log('    A real restore may still be refused because something is running.');
  } else {
    console.log('  in-use check: SKIPPED — you passed --force.');
    console.log('    Nothing verified that another process did not have these databases open.');
  }

  for (const warning of report.warnings) {
    console.log(`  ⚠ ${warning.message}`);
  }

  if (secrets.error !== undefined) {
    // The destructive half is done. Say that first, then say what failed, then
    // give a remedy that is not "run the destructive half again".
    //
    // There is no rollback across a vault, so "the write did not happen" is a
    // claim only the nothing-written case may make. When some refs landed, the
    // operator is told which — the alternative is a machine holding a mix of
    // new and old credentials with a report describing neither.
    const written = secrets.writtenRefs ?? [];
    const hints = report.secretsManifest ? parseVaultManifest(report.secretsManifest) : [];
    const remaining = hints.filter((hint) => !written.includes(vaultRef(hint)));
    console.log('');
    if (written.length === 0) {
      console.log(`✗ The restore is complete. Injecting secrets FAILED: ${secrets.error}`);
      console.log('  Every file listed above is on disk — only the vault write did not happen.');
    } else {
      console.log(`✗ The restore is complete. Injecting secrets FAILED PARTWAY: ${secrets.error}`);
      console.log(
        `  Every file listed above is on disk, and ${written.length} secret(s) reached the vault:`,
      );
      for (const ref of written) console.log(`    ${ref}`);
      console.log('  Everything below is NOT in the vault.');
    }
    console.log('  Re-running `ethos import --secrets` would restore the archive a second');
    console.log('  time, which is not the fix. Set the missing values straight into the vault:');
    const missing = remaining.map((hint) => hint.fillWith);
    if (
      secrets.failedRef !== undefined &&
      !remaining.some((hint) => vaultRef(hint) === secrets.failedRef)
    ) {
      // Quoted for the same reason the manifest's own `fill_with:` lines are:
      // this is a line to paste, and the ref is a vault filename.
      missing.unshift(`ethos secrets set ${shellQuote(secrets.failedRef)} <value>`);
    }
    if (missing.length === 0) missing.push('ethos secrets set <ref> <value>');
    for (const line of missing) console.log(`    ${line}`);
  } else if (secrets.injected !== null) {
    console.log('');
    console.log(`✓ Injected ${secrets.injected} secret(s).`);
  } else if (report.secretsManifest) {
    const hints = parseVaultManifest(report.secretsManifest);
    if (hints.length > 0) {
      console.log('');
      console.log(`  ${hints.length} secret(s) are missing — the archive carries none:`);
      for (const hint of hints) console.log(`    ${hint.fillWith}`);
      console.log('');
      console.log('  Or refill them one at a time: ethos import <archive> --secrets prompt');
    }
  }

  if (report.restartRequired && !report.dryRun) {
    console.log('');
    console.log('  Restart Ethos — config.yaml and mcp.json are read at boot, so a running');
    console.log('  serve/gateway/chat is still using the previous ones.');
  }
  console.log('');
  console.log('  Run: ethos doctor  to verify.');
}

// ---------------------------------------------------------------------------
// --secrets
// ---------------------------------------------------------------------------

/**
 * What happened to `--secrets` after the restore committed. Three outcomes:
 * everything landed (`error` absent), nothing landed (`error` set,
 * `injected: 0`), or the vault is half filled (`error` set, `injected > 0`).
 */
interface SecretsOutcome {
  /** Values written into the vault. `null` when injection was not attempted. */
  injected: number | null;
  /** Refs that ARE in the vault. Set whenever injection was attempted. */
  writtenRefs?: string[];
  /** The ref whose write was refused or failed. */
  failedRef?: string;
  /** Why injection failed. Refs and paths only — a value is never in here. */
  error?: string;
}

/**
 * Write the secrets, over a tree that is already restored.
 *
 * `payload` is the pre-read `file`/`-` source, already prepared and validated
 * before the restore; `prompt` walks the archive's manifest here, because that
 * is the earliest it exists — and goes through `prepareSecretEntries`, which
 * composes and validates a ref with exactly the code `prepareSecrets` uses, so
 * a prompted ref is held to the rules a file's ref is. A throw is captured rather
 * than propagated: the caller reports the restore and this as the two separate
 * facts they are.
 */
async function applySecrets(
  arg: string | undefined,
  payload: PreparedSecrets | null,
  report: RestoreReport,
  dryRun: boolean,
): Promise<SecretsOutcome> {
  // A dry run promised to change nothing, and writing secrets is a change.
  if (dryRun || arg === undefined) return { injected: null };
  try {
    const secrets = await getSecretsResolver();
    let prepared = payload;
    if (prepared === null) {
      const entries = await promptForSecrets(report.secretsManifest);
      if (entries === null) return { injected: 0, writtenRefs: [] };
      const result = prepareSecretEntries(entries);
      if (!result.ok) {
        return {
          injected: 0,
          writtenRefs: [],
          failedRef: result.failedRef,
          error: result.error,
        };
      }
      prepared = result.prepared;
    }
    return toOutcome(await injectSecrets(prepared, secrets));
  } catch (err) {
    // Reaching here means injection never started — `injectSecrets` reports a
    // failed write instead of throwing, so the only throws left are resolving
    // the vault and the prompt walk itself. Nothing was written.
    return { injected: 0, writtenRefs: [], error: describeError(err) };
  }
}

/**
 * Vault failures name the ref and the path they could not write; the value is
 * never part of the message (`FileSecretsResolver.set`), and no field of
 * `InjectSecretsResult` carries one either.
 */
function toOutcome(result: InjectSecretsResult): SecretsOutcome {
  return {
    injected: result.writtenRefs.length,
    writtenRefs: result.writtenRefs,
    ...(result.failedRef === undefined ? {} : { failedRef: result.failedRef }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

/** The full vault ref a manifest hint names — how `injectSecrets` reports it. */
function vaultRef(hint: VaultHint): string {
  if (hint.key === undefined) return '';
  return hint.personality ? `personalities/${hint.personality}/${hint.key}` : hint.key;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function readSecretsSource(path: string): Promise<string> {
  if (path === '-') {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }
  if (!existsSync(path)) {
    throw new EthosError({
      code: 'FILE_NOT_FOUND',
      cause: `Secrets manifest not found: ${path}`,
      action: 'Provide a valid path to a secrets manifest file.',
    });
  }
  return readFileSync(path, 'utf8');
}

/** One line the archive's `secrets.manifest.yaml` asked to be refilled. */
interface VaultHint {
  /** `undefined` for a global key. */
  personality?: string;
  /** Vault key, relative to its namespace. Absent for an MCP OAuth flow. */
  key?: string;
  /** MCP server whose OAuth tokens were stripped. */
  server?: string;
  fillWith: string;
}

/**
 * Read the manifest the CORE writes (`secrets-manifest.ts`) — names only. The
 * `global:` / `personalities:` / `other:` sections each carry `key` (or
 * `server`) plus the command that refills it.
 */
export function parseVaultManifest(raw: string): VaultHint[] {
  const hints: VaultHint[] = [];
  let section: 'none' | 'global' | 'personalities' | 'other' = 'none';
  let personality: string | undefined;
  let sub: 'secrets' | 'mcp_auth' | undefined;
  let pendingKey: string | undefined;
  let pendingServer: string | undefined;

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = line.length - line.trimStart().length;

    if (indent === 0 && trimmed.endsWith(':')) {
      const header = trimmed.slice(0, -1);
      section =
        header === 'global' || header === 'personalities' || header === 'other' ? header : 'none';
      personality = undefined;
      sub = undefined;
      continue;
    }
    if (section === 'personalities' && indent === 2 && trimmed.endsWith(':')) {
      personality = trimmed.slice(0, -1);
      sub = undefined;
      continue;
    }
    if (section === 'personalities' && indent === 4 && trimmed.endsWith(':')) {
      const header = trimmed.slice(0, -1);
      sub = header === 'secrets' || header === 'mcp_auth' ? header : undefined;
      continue;
    }

    const key = trimmed.match(/^-\s*key:\s*(.+)$/);
    if (key) {
      pendingKey = key[1];
      pendingServer = undefined;
      continue;
    }
    const server = trimmed.match(/^-\s*server:\s*(.+)$/);
    if (server) {
      pendingServer = server[1];
      pendingKey = undefined;
      continue;
    }
    const fill = trimmed.match(/^fill_with:\s*(.+)$/);
    if (!fill?.[1]) continue;
    const fillWith = fill[1];
    if (pendingKey !== undefined) {
      hints.push({
        ...(section === 'personalities' && personality ? { personality } : {}),
        key: pendingKey,
        fillWith,
      });
      pendingKey = undefined;
    } else if (pendingServer !== undefined && sub === 'mcp_auth') {
      hints.push({
        ...(personality ? { personality } : {}),
        server: pendingServer,
        fillWith,
      });
      pendingServer = undefined;
    }
  }
  return hints;
}

/**
 * Walk the archive's manifest and ask for each missing value, one at a time.
 * Returns the structured pairs, or `null` when there is nothing to fill.
 *
 * The destination is carried STRUCTURALLY — the `personality`/`key` this walk
 * already parsed out of the manifest, handed to `prepareSecretEntries` as they
 * are. It used to serialise each pair back into `key: "value"` manifest text so
 * that `prepareSecrets` could split it apart again, which meant a key holding a
 * `:` (a legal vault ref) was cut at its first colon and the value landed under
 * the wrong ref, mangled, while the command reported success — and a key
 * holding a newline manufactured whole extra entries. There is no text
 * intermediate now, so there is no delimiter left to misread, and a value's
 * leading and trailing whitespace survives because nothing re-reads it.
 *
 * Nothing typed here is echoed, and no value is ever printed back — not in the
 * confirmation, not in an error. Blank input skips a key rather than writing
 * an empty string over a good secret.
 */
async function promptForSecrets(manifest: string | undefined): Promise<SecretEntryInput[] | null> {
  if (!manifest) {
    console.log('  This archive carries no secrets manifest — nothing to fill.');
    return null;
  }
  const hints = parseVaultManifest(manifest);
  const fillable = hints.filter((h) => h.key !== undefined);
  const oauth = hints.filter((h) => h.server !== undefined);
  if (fillable.length === 0 && oauth.length === 0) {
    console.log('  This archive lists no secrets — nothing to fill.');
    return null;
  }

  const entries: SecretEntryInput[] = [];

  if (fillable.length > 0) {
    console.log('');
    console.log(`  ${fillable.length} secret(s) to re-enter. Press Enter to skip one.`);
    console.log('');
  }
  for (const hint of fillable) {
    const key = hint.key;
    if (key === undefined) continue;
    const label = hint.personality ? `${hint.personality} / ${key}` : key;
    const value = await promptHidden(`    ${label}: `);
    // Emptiness, separately from trimming: a blank line skips this key, but a
    // value that is deliberately whitespace is written exactly as typed.
    if (value === '') continue;
    // A readline answer cannot hold one, so this is the belt to the braces —
    // the value now goes straight into the vault with no format in between.
    if (value.includes('\n') || value.includes('\r')) {
      console.log(`    ⚠ ${label} skipped — a secret value cannot contain a newline.`);
      continue;
    }
    entries.push({
      ...(hint.personality ? { personality: hint.personality } : {}),
      key,
      value,
    });
  }

  if (oauth.length > 0) {
    console.log('');
    console.log('  These are OAuth flows, not values — run them when you are ready:');
    for (const hint of oauth) console.log(`    ${hint.fillWith}`);
  }

  return entries.length === 0 ? null : entries;
}

/** Ask on the TTY without echoing what is typed. */
function promptHidden(question: string): Promise<string> {
  return new Promise((res, rej) => {
    let muted = false;
    const out = new Writable({
      write(chunk, _enc, cb) {
        if (!muted) process.stdout.write(chunk);
        cb();
      },
    });
    import('node:readline')
      .then(({ createInterface }) => {
        const rl = createInterface({ input: process.stdin, output: out, terminal: true });
        rl.question(question, (answer) => {
          rl.close();
          process.stdout.write('\n');
          // NOT trimmed: the answer is carried structurally to the vault with
          // no format in between, so leading and trailing whitespace survives,
          // and trimming here would silently alter the secret it is preserving.
          // An empty line is still a skip — the caller tests for that.
          res(answer);
        });
        muted = true;
      })
      .catch(rej);
  });
}

// ---------------------------------------------------------------------------
// Shared flag handling
// ---------------------------------------------------------------------------

/**
 * `--scope identity,state`. `scopes: undefined` when the flag is absent.
 *
 * A bad flag is a returned message rather than a throw: it is the operator
 * mistyping, not an exceptional condition, and the caller turns it into the
 * same `--json`-aware refusal every other flag error gets.
 */
function readScopes(argv: string[]): { scopes?: ScopeName[]; error?: string } {
  const raw = parseFlagValue(argv, ['--scope']);
  if (raw === undefined) return {};
  const empty = { error: `--scope requires one of: ${ALL_SCOPES.join(', ')}` };
  if (raw === '') return empty;
  try {
    const scopes = parseScopes(raw);
    return scopes.length === 0 ? empty : { scopes };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Everything that is not a flag or a flag's separated value. */
function positionalArgs(argv: string[], valueFlags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (valueFlags.includes(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    out.push(arg);
  }
  return out;
}

function fail(jsonMode: boolean, code: string, message: string, extra: string[] = []): void {
  if (jsonMode) {
    writeJson({ ok: false, error: { code, message } });
  } else {
    console.error(message);
    for (const line of extra) console.error(line);
  }
  process.exitCode = 1;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// ---------------------------------------------------------------------------
// Personality-bundle tar (POSIX ustar, in memory)
//
// NOT the backup format — see the file header. `ethos personality export`
// writes it and `runPersonalityImport` below reads it back.
// ---------------------------------------------------------------------------

export interface Entry {
  relPath: string;
  content: Buffer;
}

// Minimal tar format (POSIX ustar) — no external deps
export function buildTar(entries: Entry[]): Buffer {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.relPath.slice(0, 100).padEnd(100, '\0'));
    const header = Buffer.alloc(512, 0);
    nameBytes.copy(header, 0);
    Buffer.from('0000644\0').copy(header, 100); // mode
    Buffer.from('0000000\0').copy(header, 108); // uid
    Buffer.from('0000000\0').copy(header, 116); // gid
    const sizeOctal = entry.content.length.toString(8).padStart(11, '0');
    Buffer.from(`${sizeOctal}\0`).copy(header, 124); // size
    Buffer.from(
      `${Math.floor(Date.now() / 1000)
        .toString(8)
        .padStart(11, '0')}\0`,
    ).copy(header, 136); // mtime
    header[156] = 0x30; // type '0' = regular file
    Buffer.from('ustar\0').copy(header, 257);
    Buffer.from('00').copy(header, 263);

    // POSIX: checksum field (148–155) is treated as 8 ASCII spaces during calculation
    header.fill(0x20, 148, 156);
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i] ?? 0;
    Buffer.from(`${sum.toString(8).padStart(6, '0')}\0 `).copy(header, 148);

    blocks.push(header);

    const dataBlocks = Math.ceil(entry.content.length / 512);
    const padded = Buffer.alloc(dataBlocks * 512, 0);
    entry.content.copy(padded);
    blocks.push(padded);
  }

  // Two 512-byte zero blocks to mark end of archive
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

export async function writeTarGz(entries: Entry[], outPath: string): Promise<void> {
  const tar = buildTar(entries);
  const gzip = createGzip();
  const out = createWriteStream(outPath);
  const { Readable } = await import('node:stream');
  const src = Readable.from([tar]);
  gzip.pipe(out);
  src.pipe(gzip);
  await new Promise<void>((resolve, reject) => {
    out.on('finish', resolve);
    out.on('error', reject);
    gzip.on('error', reject);
  });
}

async function readTarGz(srcPath: string): Promise<Array<[string, Buffer]>> {
  const { Writable } = await import('node:stream');
  const chunks: Buffer[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  const src = createReadStream(srcPath);
  const gunzip = createGunzip();
  await pipeline(src, gunzip, sink);
  const raw = Buffer.concat(chunks);
  return parseTar(raw);
}

export function parseTar(buf: Buffer): Array<[string, Buffer]> {
  const results: Array<[string, Buffer]> = [];
  let offset = 0;

  while (offset + 512 <= buf.length) {
    const header = buf.slice(offset, offset + 512);
    const name = header.slice(0, 100).toString('utf8').replace(/\0.*/, '');
    if (!name) break;

    // Reject path traversal and absolute paths at parse time
    if (name.includes('..') || name.startsWith('/')) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Malicious tar entry rejected: "${name}"`,
        action: 'Check the archive contents — it may be corrupted or malicious.',
      });
    }

    // Only allow regular files (type '0' or null byte)
    const typeFlag = header[156];
    if (typeFlag !== 0x30 && typeFlag !== 0x00) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Unsupported tar entry type ${typeFlag} for "${name}"`,
        action: 'Check the archive contents — it may be corrupted or malicious.',
      });
    }

    const sizeStr = header.slice(124, 135).toString('utf8').trim().replace(/\0.*/, '');
    const size = Number.parseInt(sizeStr, 8);
    offset += 512;

    const content = buf.slice(offset, offset + size);
    results.push([name, content]);

    offset += Math.ceil(size / 512) * 512;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Secrets manifest hint parser (backup manifest → import display)
// ---------------------------------------------------------------------------

interface ManifestHintGlobal {
  type: 'global';
  label: string;
  fillWith: string;
}

interface ManifestHintMcp {
  type: 'mcp';
  personality: string;
  label: string;
  fillWith: string;
}

type ManifestHint = ManifestHintGlobal | ManifestHintMcp;

function parseManifestHints(raw: string): ManifestHint[] {
  const hints: ManifestHint[] = [];
  let section: 'none' | 'global' | 'personalities' = 'none';
  let currentPersonality = '';
  let inMcpAuth = false;
  let pendingServer = '';

  for (const line of raw.split('\n')) {
    const trimmed = line.trimEnd();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('backed_up_at:')) continue;

    const indent = line.length - line.trimStart().length;

    if (indent === 0 && trimmed === 'global:') {
      section = 'global';
      inMcpAuth = false;
      continue;
    }
    if (indent === 0 && trimmed === 'personalities:') {
      section = 'personalities';
      inMcpAuth = false;
      continue;
    }

    if (section === 'global') {
      const keyMatch = trimmed.match(/^-\s*key:\s*(.+)$/);
      if (keyMatch) {
        pendingServer = keyMatch[1] ?? '';
        continue;
      }
      const fillMatch = trimmed.match(/^fill_with:\s*(.+)$/);
      if (fillMatch && pendingServer) {
        hints.push({ type: 'global', label: pendingServer, fillWith: fillMatch[1] ?? '' });
        pendingServer = '';
        continue;
      }
    }

    if (section === 'personalities') {
      // Personality id line: "  alice:" (indent 2)
      if (indent === 2 && trimmed.endsWith(':')) {
        currentPersonality = trimmed.slice(0, -1);
        inMcpAuth = false;
        continue;
      }
      // mcp_auth: line
      if (indent === 4 && trimmed === 'mcp_auth:') {
        inMcpAuth = true;
        continue;
      }
      if (inMcpAuth && currentPersonality) {
        const serverMatch = trimmed.match(/^-\s*server:\s*(.+)$/);
        if (serverMatch) {
          pendingServer = serverMatch[1] ?? '';
          continue;
        }
        const fillMatch = trimmed.match(/^fill_with:\s*(.+)$/);
        if (fillMatch && pendingServer) {
          hints.push({
            type: 'mcp',
            personality: currentPersonality,
            label: pendingServer,
            fillWith: fillMatch[1] ?? '',
          });
          pendingServer = '';
        }
      }
    }
  }
  return hints;
}

// ---------------------------------------------------------------------------
// Secrets injection from a file or stdin (personality import + `ethos import`)
// ---------------------------------------------------------------------------

/**
 * Read an operator-written manifest and write every value into the vault.
 *
 * The personality-import lane treats a failed injection as fatal, as it always
 * has — but the throw now names what already landed, because `injectSecrets`
 * cannot roll those back.
 */
async function injectSecretsFromPath(secretsPath: string): Promise<number> {
  const preflight = prepareSecrets(await readSecretsSource(secretsPath));
  const result = preflight.ok
    ? await injectSecrets(preflight.prepared, await getSecretsResolver())
    : { writtenRefs: [], failedRef: preflight.failedRef, error: preflight.error };
  if (result.error !== undefined) {
    const written = result.writtenRefs;
    throw new EthosError({
      code: 'SECRETS_UNAVAILABLE',
      cause:
        written.length === 0
          ? `Injecting secrets failed, none were written: ${result.error}`
          : `Injecting secrets failed after ${written.length} were written (${written.join(', ')}): ${result.error}`,
      action:
        written.length === 0
          ? 'Fix the manifest and re-run with --secrets.'
          : 'Those refs are already in the vault. Set the remaining ones with `ethos secrets set <ref> <value>`.',
    });
  }
  return result.writtenRefs.length;
}

/** A personality id is a path segment; anything else is traversal. */
const VALID_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// ---------------------------------------------------------------------------
// Helpers for manifest-aware personality import
// ---------------------------------------------------------------------------

function semverGte(a: string, b: string): boolean {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  if (pa.some(Number.isNaN) || pb.some(Number.isNaN)) return false;
  for (let i = 0; i < 3; i++) {
    const va = pa[i] ?? 0;
    const vb = pb[i] ?? 0;
    if (va > vb) return true;
    if (va < vb) return false;
  }
  return true;
}

function updateConfigLine(configPath: string, key: string, newValues: string[]): void {
  if (newValues.length === 0) return;
  let lines: string[] = [];
  if (existsSync(configPath)) {
    lines = readFileSync(configPath, 'utf8').split('\n');
  }
  const idx = lines.findIndex((l) => l.startsWith(`${key}:`));
  if (idx >= 0) {
    const existing = lines[idx]?.split(':').slice(1).join(':').trim() ?? '';
    const existingNames = existing ? existing.split(/\s+/) : [];
    const toAdd = newValues.filter((n) => !existingNames.includes(n));
    if (toAdd.length > 0) {
      lines[idx] = `${key}: ${[...existingNames, ...toAdd].join(' ')}`;
    }
  } else {
    lines.push(`${key}: ${newValues.join(' ')}`);
  }
  writeFileSync(configPath, lines.join('\n'));
}

// ---------------------------------------------------------------------------
// Personality import (G5+G6) — ethos personality import <file> [--force] [--secrets <manifest>]
// ---------------------------------------------------------------------------

const USAGE_PERSONALITY_IMPORT =
  'Usage: ethos personality import <file-or-dir> [--force] [--secrets <manifest>] [--no-memory]';

function isValidManifest(m: unknown): m is BundleManifest {
  if (!m || typeof m !== 'object') return false;
  const obj = m as Record<string, unknown>;
  if (obj.schema !== 'ethos.personality-bundle/v1') return false;
  if (typeof obj.personalityId !== 'string') return false;
  if (typeof obj.version !== 'string') return false;
  if (typeof obj.bundleSha256 !== 'string') return false;
  if (!obj.declared || typeof obj.declared !== 'object') return false;
  const declared = obj.declared as Record<string, unknown>;
  if (!declared.fsReach || typeof declared.fsReach !== 'object') return false;
  if (!Array.isArray(declared.toolset)) return false;
  if (!Array.isArray(obj.mcpServers)) return false;
  if (!Array.isArray(obj.plugins)) return false;
  if (!Array.isArray(obj.files)) return false;
  return true;
}

export async function runPersonalityImport(argv: string[]): Promise<void> {
  const force = argv.includes('--force');
  const noMemory = argv.includes('--no-memory');
  const secretsIdx = argv.indexOf('--secrets');
  const secretsPath = secretsIdx >= 0 ? argv[secretsIdx + 1] : undefined;

  if (secretsIdx >= 0 && (!secretsPath || secretsPath.startsWith('--'))) {
    console.error('--secrets requires a manifest file path or "-" for stdin.');
    console.error(USAGE_PERSONALITY_IMPORT);
    process.exitCode = 1;
    return;
  }

  const positional = argv.filter(
    (a, i) =>
      a !== '--force' &&
      a !== '--no-memory' &&
      a !== '--secrets' &&
      !(i > 0 && argv[i - 1] === '--secrets'),
  );

  const srcPath = positional[0];
  if (!srcPath) {
    console.error(USAGE_PERSONALITY_IMPORT);
    process.exitCode = 1;
    return;
  }

  if (!existsSync(srcPath)) {
    console.error(`File not found: ${srcPath}`);
    process.exitCode = 1;
    return;
  }

  let entries: Array<[string, Buffer]>;
  const srcStat = statSync(srcPath);
  if (srcStat.isDirectory()) {
    const dirName = basename(srcPath);
    entries = [];
    for (const f of readdirSync(srcPath)) {
      const fp = join(srcPath, f);
      if (statSync(fp).isFile()) {
        entries.push([`personalities/${dirName}/${f}`, readFileSync(fp)]);
      }
    }
  } else {
    entries = await readTarGz(srcPath);
  }

  if (entries.length === 0) {
    console.error('Archive is empty — nothing to import.');
    process.exitCode = 1;
    return;
  }

  // Check for ETHOS.md manifest (manifest-aware vs legacy)
  const ethosEntry = entries.find(([name]) => name === 'ETHOS.md');

  if (ethosEntry) {
    // -----------------------------------------------------------------------
    // Manifest-aware import path
    // -----------------------------------------------------------------------
    let manifest: BundleManifest;
    try {
      manifest = JSON.parse(ethosEntry[1].toString('utf8')) as BundleManifest;
    } catch {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: 'ETHOS.md is not valid JSON — cannot parse bundle manifest.',
        action: 'Ensure the archive contains a valid ETHOS.md bundle manifest.',
      });
    }

    if (!isValidManifest(manifest)) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: 'ETHOS.md does not match expected BundleManifest shape.',
        action: 'Ensure the archive contains a valid ETHOS.md bundle manifest.',
      });
    }

    const personalityId = manifest.personalityId;

    // Validate personality ID
    if (!VALID_ID_RE.test(personalityId)) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Invalid personality ID "${personalityId}" — must be alphanumeric with hyphens/underscores.`,
        action: 'Ensure the bundle manifest uses a valid personality ID.',
      });
    }

    // Verify bundle integrity
    const computedHash = createHash('sha256').update(JSON.stringify(manifest.files)).digest('hex');
    if (computedHash !== manifest.bundleSha256) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: 'Bundle integrity check failed — file hashes do not match bundleSha256.',
        action: 'The archive may have been tampered with. Re-export from the source.',
      });
    }

    // Verify individual file contents against manifest hashes
    for (const fileEntry of manifest.files) {
      const archiveEntry = entries.find(([p]) => p === fileEntry.relPath);
      if (!archiveEntry) {
        throw new EthosError({
          code: 'IMPORT_BLOCKED',
          cause: `Manifest declares file "${fileEntry.relPath}" but it is missing from the archive.`,
          action: 'The archive may be corrupted. Re-export the personality.',
        });
      }
      const actualHash = createHash('sha256').update(archiveEntry[1]).digest('hex');
      if (actualHash !== fileEntry.sha256) {
        throw new EthosError({
          code: 'IMPORT_BLOCKED',
          cause: `File "${fileEntry.relPath}" content does not match manifest hash.`,
          action: 'The archive may be corrupted or tampered with. Re-export the personality.',
        });
      }
    }

    // Verify export stamp (flag only, do not block)
    const expectedStamp = createHmac('sha256', 'ethos-personality-export-v1')
      .update(manifest.bundleSha256)
      .digest('hex');
    const unstamped = !manifest.export.stamp || manifest.export.stamp !== expectedStamp;

    // Check for existing personality
    const dataDir = ethosDir();
    const existingDir = join(dataDir, 'personalities', personalityId);
    if (existsSync(existingDir) && !force && process.env.ETHOS_MANAGED !== '1') {
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const overwrite = await new Promise<boolean>((res) => {
        rl.question(
          `Personality "${personalityId}" already exists. Overwrite? [y/N] `,
          (answer) => {
            rl.close();
            res(answer.toLowerCase() === 'y');
          },
        );
      });
      if (!overwrite) {
        console.log('Cancelled.');
        return;
      }
    }

    // Trust prompt (unless --force or ETHOS_MANAGED=1)
    if (!force && process.env.ETHOS_MANAGED !== '1') {
      console.log('');
      console.log('  Personality import summary:');
      console.log(`    ID:          ${personalityId}`);
      console.log(`    Version:     ${manifest.version}`);
      console.log(
        `    fs_reach:    read ${manifest.declared.fsReach.read.length} path(s), write ${manifest.declared.fsReach.write.length} path(s)`,
      );
      // A declared workdir is read AND write reachable, so it belongs in the
      // reach the operator is being asked to trust — the counts above do not
      // include it.
      // A bundle may disclose several workdirs; print each on its own line so
      // an operator reads the full grant rather than a squashed join.
      const declaredWorkdir = manifest.declared.fsReach.workdir;
      const workdirs = declaredWorkdir === undefined ? [] : [declaredWorkdir].flat();
      for (const workdir of workdirs) {
        console.log(`    Workdir:     ${workdir} (read + write)`);
      }
      console.log(`    Toolset:     ${manifest.declared.toolset.length} tool(s)`);
      if (manifest.mcpServers.length > 0) {
        const mcpNames = manifest.mcpServers.map((s) => s.name).join(', ');
        console.log(`    MCP servers: ${mcpNames}`);
      }
      if (manifest.plugins.length > 0) {
        const pluginNames = manifest.plugins.map((p) => p.id).join(', ');
        console.log(`    Plugins:     ${pluginNames}`);
      }
      if (manifest.memory) {
        console.log(`    Memory:      ${manifest.memory.included.join(', ')}`);
      } else {
        console.log('    Memory:      none');
      }
      if (unstamped) {
        console.log('    WARNING:     Bundle is NOT stamped by an official ethos export.');
      }
      console.log('');

      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const proceed = await new Promise<boolean>((res) => {
        rl.question('  Continue? [y/N] ', (answer) => {
          rl.close();
          res(answer.toLowerCase() === 'y');
        });
      });
      if (!proceed) {
        console.log('Cancelled.');
        return;
      }
    }

    // Write personality files
    const personalityBase = resolve(join(dataDir, 'personalities', personalityId)) + sep;
    // Build verified file allowlist from manifest
    const verifiedFiles = new Map<string, string>();
    for (const f of manifest.files) {
      verifiedFiles.set(f.relPath, f.sha256);
    }

    // Check for duplicate archive entries
    const seenPaths = new Set<string>();
    for (const [relPath] of entries) {
      if (seenPaths.has(relPath)) {
        throw new EthosError({
          code: 'IMPORT_BLOCKED',
          cause: `Duplicate archive entry "${relPath}" — possible tampering.`,
          action: 'Re-export the personality from the source.',
        });
      }
      seenPaths.add(relPath);
    }

    const skipFiles = new Set(['ETHOS.md', 'secrets.manifest.yaml', 'plugins.manifest.yaml']);
    let writtenCount = 0;
    let skippedCount = 0;

    for (const [relPath, content] of entries) {
      const fileName = relPath.split('/').pop() ?? '';

      // Skip special files
      if (skipFiles.has(relPath) || skipFiles.has(fileName)) continue;
      // Never write USER.md
      if (fileName === 'USER.md') continue;
      // Skip MEMORY.md if --no-memory
      if (fileName === 'MEMORY.md' && noMemory) continue;

      // Only write files that are in the manifest and verified
      if (!verifiedFiles.has(relPath)) {
        skippedCount++;
        continue;
      }

      const dest = join(dataDir, relPath);
      const resolvedDest = resolve(dest);
      if (!resolvedDest.startsWith(personalityBase)) {
        skippedCount++;
        continue;
      }
      mkdirSync(join(resolvedDest, '..'), { recursive: true });
      writeFileSync(dest, content);
      writtenCount++;
    }

    if (skippedCount > 0) {
      console.warn(
        `  Warning: ${skippedCount} archive entry/entries outside personalities/${personalityId}/ were skipped.`,
      );
    }

    // MCP server handling
    const mcpJsonPath = join(homedir(), '.ethos', 'mcp.json');
    const configYamlPath = join(dataDir, 'personalities', personalityId, 'config.yaml');
    const mcpToEnable: string[] = [];
    const credentialWarnings: string[] = [];

    if (manifest.mcpServers.length > 0) {
      let mcpArr: Array<Record<string, unknown>> = [];
      if (existsSync(mcpJsonPath)) {
        try {
          const parsed = JSON.parse(readFileSync(mcpJsonPath, 'utf8'));
          if (!Array.isArray(parsed)) {
            throw new EthosError({
              code: 'IMPORT_BLOCKED',
              cause:
                'Global MCP config (~/.ethos/mcp.json) is malformed — cannot safely modify it.',
              action: 'Fix or remove ~/.ethos/mcp.json before importing.',
            });
          }
          mcpArr = parsed as Array<Record<string, unknown>>;
        } catch (err) {
          if (err instanceof EthosError) throw err;
          throw new EthosError({
            code: 'IMPORT_BLOCKED',
            cause: 'Global MCP config (~/.ethos/mcp.json) is malformed — cannot safely modify it.',
            action: 'Fix or remove ~/.ethos/mcp.json before importing.',
          });
        }
      }

      for (const server of manifest.mcpServers) {
        const existingServer = mcpArr.find(
          (s) =>
            typeof s === 'object' &&
            s !== null &&
            (s as Record<string, unknown>).name === server.name,
        );
        if (existingServer) {
          // Clash — reuse existing, skip global install
          console.log(`  MCP "${server.name}": already installed, using existing.`);
        } else {
          // New server — append to mcp.json
          mcpArr.push({
            name: server.name,
            url: server.url,
            transport: server.transport,
          });
          console.log(`  MCP "${server.name}": added to mcp.json.`);
        }
        mcpToEnable.push(server.name);

        // Flag credential-requiring servers
        if (server.authType === 'bearer' || server.authType === 'oauth2') {
          credentialWarnings.push(`MCP "${server.name}" requires ${server.authType} credentials.`);
        }
      }

      mkdirSync(join(homedir(), '.ethos'), { recursive: true });
      writeFileSync(mcpJsonPath, JSON.stringify(mcpArr, null, 2));

      // Enable MCP servers at personality level
      updateConfigLine(configYamlPath, 'mcp_servers', mcpToEnable);
    }

    // Plugin handling.
    //
    // `manifest.plugins` comes out of the bundle, which is a shared artefact —
    // the same attacker-controlled input as `plugins.lock`. The three fields
    // used below are validated with the SAME predicates the lockfile path uses
    // (`@ethosagent/plugin-loader`), so the two install surfaces cannot drift
    // apart. The rule they replace, `/^[@a-zA-Z0-9._/-]+$/`, did reject
    // `--registry=http://evil` (no `=` or `:` in the class) but admitted every
    // local path spec and every bare option-shaped token: `../../evil`, `./x`,
    // `..`, `-g`, `--registry`, `--foo` all passed it and would have been
    // handed to npm as the package to install.
    const pluginsToAttach: string[] = [];

    if (manifest.plugins.length > 0) {
      const pluginsDir = join(homedir(), '.ethos', 'plugins');
      mkdirSync(pluginsDir, { recursive: true });
      const nodeModulesDir = join(pluginsDir, 'node_modules');

      for (const plugin of manifest.plugins) {
        // The id becomes a path segment (`node_modules/<id>`) and a token in
        // config.yaml's space-separated `plugins:` list. Check it before either.
        if (!isValidPluginId(plugin.id)) {
          console.warn(`  ⚠ Plugin id "${plugin.id}" is not a plain identifier — skipping.`);
          continue;
        }
        pluginsToAttach.push(plugin.id);

        // Validate plugin source/version before any install attempt. `version`
        // is held to exact semver for the same reason the lockfile is: the
        // bundle records what the exporter HAD, so a range, a dist-tag, or a
        // `file:`/`git+ssh:` spec here is not a weaker pin, it is a different
        // package from a different place. A bundle exported on a machine where
        // the plugin was not installed carries `version: "unknown"`; that now
        // warns here instead of failing inside npm.
        if (!isValidNpmPackageName(plugin.source) || !isExactVersion(plugin.version)) {
          console.warn(
            `  ⚠ Plugin "${plugin.id}" has an unusable source/version (${plugin.source}@${plugin.version}) — skipping install.`,
          );
          continue;
        }

        const pluginDir = join(nodeModulesDir, plugin.id);
        const isInstalled = existsSync(pluginDir);

        if (!isInstalled) {
          // Always prompt before installing plugins (even with --force)
          if (process.env.ETHOS_MANAGED !== '1') {
            const readline = await import('node:readline');
            const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
            const answer = await new Promise<string>((res) => {
              rl.question(
                `Install plugin "${plugin.id}" (${plugin.source}@${plugin.version})? [Y/n] `,
                (a) => {
                  rl.close();
                  res(a);
                },
              );
            });
            if (answer.toLowerCase() === 'n') {
              console.log(`  Skipped plugin "${plugin.id}".`);
              continue;
            }
          }
          // Not installed — install it
          try {
            execFileSync(
              'npm',
              [
                'install',
                '--prefix',
                pluginsDir,
                '--ignore-scripts',
                '--no-audit',
                `${plugin.source}@${plugin.version}`,
              ],
              { stdio: 'pipe', timeout: 60000 },
            );
            console.log(`  Plugin "${plugin.id}": installed ${plugin.version}.`);
          } catch {
            console.warn(`  Plugin "${plugin.id}": install failed — install manually.`);
          }
        } else {
          // Installed — check version
          let installedVersion = '0.0.0';
          const pkgJsonPath = join(pluginDir, 'package.json');
          if (existsSync(pkgJsonPath)) {
            try {
              const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8')) as Record<
                string,
                unknown
              >;
              if (typeof pkgJson.version === 'string') {
                installedVersion = pkgJson.version;
              }
            } catch {
              // ignore parse errors
            }
          }

          if (semverGte(installedVersion, plugin.version)) {
            console.log(
              `  Plugin "${plugin.id}": installed ${installedVersion} >= bundle ${plugin.version}, reusing.`,
            );
          } else {
            // Installed but older — prompt unless force
            if (force) {
              try {
                execFileSync(
                  'npm',
                  [
                    'install',
                    '--prefix',
                    pluginsDir,
                    '--ignore-scripts',
                    '--no-audit',
                    `${plugin.source}@${plugin.version}`,
                  ],
                  { stdio: 'pipe', timeout: 60000 },
                );
                console.log(
                  `  Plugin "${plugin.id}": updated ${installedVersion} → ${plugin.version}.`,
                );
              } catch {
                console.warn(`  Plugin "${plugin.id}": update failed — update manually.`);
              }
            } else {
              console.log(
                `  Plugin "${plugin.id}": installed ${installedVersion} < bundle ${plugin.version}. Keeping existing.`,
              );
            }
          }
        }

        // Flag credential-declaring plugins
        const creds = plugin.credentials;
        if (creds && creds.length > 0) {
          credentialWarnings.push(
            `Plugin "${plugin.id}" declares credentials: ${creds.join(', ')}.`,
          );
        }
      }

      // Attach plugins at personality level
      updateConfigLine(configYamlPath, 'plugins', pluginsToAttach);
    }

    // Handle --secrets
    if (secretsPath) {
      const count = await injectSecretsFromPath(secretsPath);
      console.log(`  Injected ${count} secret(s).`);
    }

    // Final summary
    console.log(`✓ Personality "${personalityId}" imported (${writtenCount} file(s) written).`);
    if (credentialWarnings.length > 0) {
      console.log('');
      console.log('  Credentials needed:');
      for (const warn of credentialWarnings) {
        console.log(`    - ${warn}`);
      }
    }
    console.log(`  Run: ${doctorCommand(personalityId)}  to verify.`);
  } else {
    // -----------------------------------------------------------------------
    // Legacy fallback — no ETHOS.md manifest
    // -----------------------------------------------------------------------
    const first = entries[0];
    if (!first) {
      console.error('Archive is empty — nothing to import.');
      process.exitCode = 1;
      return;
    }
    const segments = first[0].split('/');
    const personalitiesIdx = segments.indexOf('personalities');
    if (personalitiesIdx < 0 || !segments[personalitiesIdx + 1]) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: 'Cannot determine personality ID — expected paths under personalities/<id>/',
        action: 'Ensure the archive contains files under a personalities/<id>/ directory.',
      });
    }
    const personalityId = segments[personalitiesIdx + 1];

    // Validate personality ID — reject traversal characters
    if (!VALID_ID_RE.test(personalityId)) {
      throw new EthosError({
        code: 'IMPORT_BLOCKED',
        cause: `Invalid personality ID "${personalityId}" — must be alphanumeric with hyphens/underscores.`,
        action: 'Ensure the archive paths use a valid personality ID.',
      });
    }

    const { createPersonalityRegistry } = await import('@ethosagent/personalities');
    const dataDir = ethosDir();
    const storage = new (await import('@ethosagent/storage-fs')).FsStorage();
    const reg = await createPersonalityRegistry(storage);
    await reg.loadFromDirectory(join(dataDir, 'personalities'));
    const existing = reg.get(personalityId);

    if (existing && !force && process.env.ETHOS_MANAGED !== '1') {
      const readline = await import('node:readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const overwrite = await new Promise<boolean>((res) => {
        rl.question(
          `Personality "${personalityId}" already exists. Overwrite? [y/N] `,
          (answer) => {
            rl.close();
            res(answer.toLowerCase() === 'y');
          },
        );
      });
      if (!overwrite) {
        console.log('Cancelled.');
        return;
      }
    }

    // Write files — restrict to personalities/<id>/ only
    const personalityBase = resolve(join(dataDir, 'personalities', personalityId)) + sep;
    let skippedCount = 0;
    for (const [relPath, content] of entries) {
      // Skip top-level manifest files and USER.md
      if (relPath === 'secrets.manifest.yaml') continue;
      if (relPath.endsWith('/USER.md') || relPath === 'USER.md') continue;
      // Skip MEMORY.md when --no-memory
      if (noMemory && (relPath.endsWith('/MEMORY.md') || relPath === 'MEMORY.md')) continue;

      const dest = join(dataDir, relPath);
      const resolvedDest = resolve(dest);
      if (!resolvedDest.startsWith(personalityBase)) {
        skippedCount++;
        continue;
      }
      mkdirSync(join(dataDir, relPath, '..'), { recursive: true });
      writeFileSync(dest, content);
    }

    if (skippedCount > 0) {
      console.warn(
        `  Warning: ${skippedCount} archive entry/entries outside personalities/${personalityId}/ were skipped.`,
      );
    }

    if (secretsPath) {
      const count = await injectSecretsFromPath(secretsPath);
      console.log(`✓ Injected ${count} secret(s)`);
    }

    // Display secrets manifest from the archive (if present)
    const manifestEntry = entries.find(([name]) => name === 'secrets.manifest.yaml');
    if (manifestEntry) {
      const manifestContent = manifestEntry[1].toString('utf8');
      const hints = parseManifestHints(manifestContent);
      console.log(`✓ Personality "${personalityId}" imported.`);
      if (hints.length > 0) {
        console.log('');
        console.log(`  ${hints.length} secret(s) required before use:`);
        for (let i = 0; i < hints.length; i++) {
          const hint = hints[i];
          if (!hint) continue;
          const num = i + 1;
          if (hint.type === 'global') {
            console.log(`     ${num}. ${hint.label.padEnd(24)}→  ${hint.fillWith}`);
          } else {
            console.log(`     ${num}. MCP: ${hint.label.padEnd(20)}→  ${hint.fillWith}`);
          }
        }
        console.log('');
        console.log(`  Run: ${doctorCommand(personalityId)}  to verify when ready.`);
      }
    } else {
      console.log(`✓ Personality "${personalityId}" imported.`);
      console.log(`  Run: ${doctorCommand(personalityId)}  to verify.`);
    }
  }
}
