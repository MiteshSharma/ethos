// `ethos doctor` — runtime health check.
//
// Verifies that:
//   1. Each optional channel SDK is actually loadable (grammy, discord.js,
//      @slack/bolt, imapflow, mailparser, nodemailer). With package channel
//      SDKs in optionalDependencies, npm install can silently skip one — this
//      command surfaces that gap before the user discovers it at runtime.
//   2. The required core SDKs (@anthropic-ai/sdk, openai) are present.
//   3. ~/.ethos/config.yaml exists and names a provider/model.
//   4. The personality data directory is reachable.
//   5. External CLIs declared by bundled skills (gh, git, claude, …) are on PATH.
//
// Configured-but-missing channels exit non-zero so this command can be used
// in CI / health checks. Everything else is informational (skill-prereq gaps
// are warn-only — the user opted into the skill, not the doctor).

import { spawnSync } from 'node:child_process';
// Raw `node:fs` for the same reasons `runDoctorFix` already reaches for
// `chmod`: Storage has no permissions API, and the integrity check hands a raw
// path to SQLite (the documented store carve-out in AGENTS.md).
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  configParseNotices,
  type EthosConfig,
  ethosDir,
  readConfig,
  readRawConfig,
} from '@ethosagent/config';
import { resolveSttProvider, resolveTtsProvider } from '@ethosagent/core';
import {
  CodexTokenStore,
  discoverModels,
  type ModelDiscovery,
  unsupportedModelMessage,
} from '@ethosagent/llm-codex';
import {
  type CallCaptureDependencyCheckResult,
  callCaptureHealthPath,
} from '@ethosagent/platform-callcapture';
import { bundledSkillsSource, UniversalScanner } from '@ethosagent/skills';
import type { SecretsResolver, Skill } from '@ethosagent/types';
import { errorLogExists, errorLogPath, readRecentErrors } from '../error-log';
import { type LiveKitMediaResolution, resolveLiveKitMedia } from '../livekit-media';
import { buildVersionInfo } from '../version-info';
import { createLLM, getFunnelTracker, getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

declare const __ETHOS_VERSION__: string;
const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

interface SdkRow {
  label: string;
  module: string;
  required: boolean;
  /** Config keys that, if set, mean this SDK is "in use" — missing is a hard error. */
  configuredWhen?: (cfg: EthosConfig) => boolean;
}

const CORE_SDKS: SdkRow[] = [
  { label: 'Anthropic provider', module: '@anthropic-ai/sdk', required: true },
  { label: 'OpenAI-compat provider', module: 'openai', required: true },
];

const CHANNEL_SDKS: SdkRow[] = [
  {
    label: 'Telegram',
    module: 'grammy',
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.telegramToken),
  },
  {
    label: 'Discord',
    module: 'discord.js',
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.discordToken),
  },
  {
    label: 'Slack',
    module: '@slack/bolt',
    required: false,
    configuredWhen: (cfg) =>
      Boolean(cfg.slackBotToken && cfg.slackAppToken && cfg.slackSigningSecret),
  },
  {
    label: 'Email (IMAP)',
    module: 'imapflow',
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.emailImapHost && cfg.emailUser && cfg.emailPassword),
  },
  {
    label: 'Email (parser)',
    module: 'mailparser',
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.emailImapHost && cfg.emailUser && cfg.emailPassword),
  },
  {
    label: 'Email (SMTP)',
    module: 'nodemailer',
    required: false,
    configuredWhen: (cfg) => Boolean(cfg.emailSmtpHost && cfg.emailUser && cfg.emailPassword),
  },
];

interface SecretCheckRow {
  key: string;
  secretRef: string;
  required: boolean;
  fillWith: string;
  configuredWhen?: (cfg: EthosConfig) => boolean;
}

const SECRET_CHECKS: SecretCheckRow[] = [
  {
    key: 'ANTHROPIC_API_KEY',
    secretRef: 'anthropic-api-key',
    required: false,
    fillWith: 'ethos keys set anthropic-api-key <value>',
    configuredWhen: (cfg) => cfg.provider === 'anthropic',
  },
  {
    key: 'OPENAI_API_KEY',
    secretRef: 'openai-api-key',
    required: false,
    fillWith: 'ethos keys set openai-api-key <value>',
    configuredWhen: (cfg) => cfg.provider === 'openai-compat',
  },
  {
    key: 'TELEGRAM_BOT_TOKEN',
    secretRef: 'telegram-bot-token',
    required: false,
    fillWith: 'ethos keys set telegram-bot-token <value>',
    configuredWhen: (cfg) => Boolean(cfg.telegramToken),
  },
  {
    key: 'SLACK_BOT_TOKEN',
    secretRef: 'slack-bot-token',
    required: false,
    fillWith: 'ethos keys set slack-bot-token <value>',
    configuredWhen: (cfg) => Boolean(cfg.slackBotToken),
  },
  {
    key: 'DISCORD_BOT_TOKEN',
    secretRef: 'discord-bot-token',
    required: false,
    fillWith: 'ethos keys set discord-bot-token <value>',
    configuredWhen: (cfg) => Boolean(cfg.discordToken),
  },
];

interface SecretCheckResult {
  key: string;
  present: boolean;
  required: boolean;
  applicable: boolean;
  fillWith: string;
}

async function checkSecrets(config: EthosConfig | null): Promise<SecretCheckResult[]> {
  const secrets = await getSecretsResolver();
  const results: SecretCheckResult[] = [];
  for (const row of SECRET_CHECKS) {
    const hasCondition = Boolean(row.configuredWhen);
    const conditionMet = hasCondition && config ? row.configuredWhen?.(config) : false;
    const applicable = row.required || Boolean(conditionMet);
    if (!applicable) continue;
    const val = await secrets.get(row.secretRef);
    const present = val !== null && val.trim().length > 0;
    results.push({
      key: row.key,
      present,
      required: row.required,
      applicable: true,
      fillWith: row.fillWith,
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Codex model check — is the configured model on this ChatGPT account's roster?
// ---------------------------------------------------------------------------

export type CodexModelCheck =
  | { status: 'skipped' }
  | { status: 'unauthorized' }
  | { status: 'unverified'; model: string }
  | { status: 'ok'; model: string }
  | { status: 'unsupported'; model: string; supported: string[] };

/** `discover` is injectable so tests never reach the real models endpoint. */
export async function checkCodexModel(
  config: EthosConfig | null,
  secrets: SecretsResolver,
  deps: { discover?: (accessToken: string) => Promise<ModelDiscovery> } = {},
): Promise<CodexModelCheck> {
  if (config?.provider !== 'codex' || !config.model) return { status: 'skipped' };
  const model = config.model;
  const tokens = await new CodexTokenStore(secrets).load();
  if (!tokens) return { status: 'unauthorized' };
  const discovery = await (deps.discover ?? discoverModels)(tokens.accessToken);
  // The fallback roster is a guess, not proof — only a live list can say no.
  if (discovery.source !== 'live') return { status: 'unverified', model };
  if (discovery.models.includes(model)) return { status: 'ok', model };
  return { status: 'unsupported', model, supported: discovery.models };
}

function codexModelLine(check: CodexModelCheck): string | null {
  switch (check.status) {
    case 'skipped':
      return null;
    case 'unauthorized':
      return `  ${c.yellow}⚠${c.reset}  Codex tokens missing — run ${c.cyan}ethos setup auth${c.reset}`;
    case 'unverified':
      return `  ${c.dim}–  Could not verify model '${check.model}' against the Codex models endpoint (offline?).${c.reset}`;
    case 'ok':
      return `  ${c.green}✓${c.reset}  Model '${check.model}' is available to this ChatGPT account`;
    case 'unsupported':
      return `  ${c.yellow}⚠${c.reset}  ${unsupportedModelMessage(check.model, check.supported)}`;
  }
}

async function checkSdk(modulePath: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await import(modulePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

interface RowResult {
  row: SdkRow;
  ok: boolean;
  inUse: boolean;
}

function printRow(r: RowResult): void {
  const tag = r.ok
    ? `${c.green}✓${c.reset}`
    : r.row.required || r.inUse
      ? `${c.red}✗${c.reset}`
      : `${c.dim}–${c.reset}`;
  const label = r.row.label.padEnd(24);
  const module = `${c.dim}${r.row.module}${c.reset}`;
  const note = r.ok
    ? ''
    : r.row.required
      ? `  ${c.red}(required — ethos will not work)${c.reset}`
      : r.inUse
        ? `  ${c.red}(configured but SDK missing — install with ${c.cyan}npm install -g ${r.row.module}${c.reset}${c.red})${c.reset}`
        : `  ${c.dim}(not installed; not in use)${c.reset}`;
  console.log(`  ${tag}  ${label} ${module}${note}`);
}

async function checkAwsSecrets(
  config: EthosConfig | null,
): Promise<{ enabled: boolean; reachable?: boolean; secretCount?: number; error?: string }> {
  if (!config?.aws?.secrets?.enabled) return { enabled: false };
  let resolver: { list(): Promise<string[]>; dispose(): void } | undefined;
  try {
    const { AwsSecretsManagerResolver } = await import('@ethosagent/secrets-aws');
    resolver = new AwsSecretsManagerResolver({
      region: config.aws.secrets.region ?? 'us-east-1',
      prefix: config.aws.secrets.prefix ?? 'ethos',
      endpoint: config.aws.secrets.endpoint,
    });
    const refs = await resolver.list();
    return { enabled: true, reachable: true, secretCount: refs.length };
  } catch (err) {
    return {
      enabled: true,
      reachable: false,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    resolver?.dispose();
  }
}

// ---------------------------------------------------------------------------
// W2.3 — DB / gateway-heartbeat / channel-token liveness checks.
//
// Exit-code contract: a HARD failure (rejected credential, stale heartbeat,
// unopenable sessions.db) exits 1; an UNREACHABLE-but-not-rejected channel
// probe exits with a DISTINCT warn code (2) so CI can tell "bad token" from
// "the platform is down" (W1.2 liveness).
// ---------------------------------------------------------------------------

const WARN_EXIT = 2;

export interface DoctorFailFlags {
  coreFailure: boolean;
  configuredMissing: boolean;
  awsFailed: boolean;
  requiredSecretMissing: boolean;
  dbUnopenable: boolean;
  /** `PRAGMA integrity_check` failed on at least one store — corruption is a
   *  hard failure, the same weight as `dbUnopenable`. Optional so existing
   *  call sites/tests need no change; absent behaves as `false`. */
  dbIntegrityFailed?: boolean;
  /** `~/.ethos/secrets/` is reachable by group or other. Optional; absent
   *  behaves as `false`. */
  secretsDirTooOpen?: boolean;
  gatewayStale: boolean;
  channelRejected: boolean;
  /** Unreachable-but-not-rejected — warn only, never a hard fail. */
  channelUnreachable: boolean;
  /** Call capture is configured (`callCapture.personalityId` set) but a
   *  dependency preflight check failed — "configured but broken", the same
   *  weight as `configuredMissing`. Optional so existing call sites/tests
   *  need no change; absent behaves as `false`. */
  callCaptureDepsMissing?: boolean;
  /** Call capture is configured but its daemon's heartbeat has gone stale
   *  (started, then went quiet — likely crashed) — the same weight as
   *  `gatewayStale`. A `down` daemon (never started / no heartbeat file) is
   *  NOT a failure here, mirroring `gatewayStale`'s own stale-only gate:
   *  a configured deployment between runs of `ethos serve`/`ethos gateway`
   *  is a normal state. Optional so existing call sites/tests need no
   *  change; absent behaves as `false`. */
  callCaptureDaemonStale?: boolean;
}

/** Exit-code matrix: any hard failure → 1; else an unreachable channel probe →
 *  the DISTINCT warn code (2), so CI tells "bad token" from "platform down";
 *  else 0. Hard failures always outrank the warn. */
export function computeDoctorExit(f: DoctorFailFlags): number {
  const hardFail =
    f.coreFailure ||
    f.configuredMissing ||
    f.awsFailed ||
    f.requiredSecretMissing ||
    f.dbUnopenable ||
    f.dbIntegrityFailed === true ||
    f.secretsDirTooOpen === true ||
    f.gatewayStale ||
    f.channelRejected ||
    f.callCaptureDepsMissing === true ||
    f.callCaptureDaemonStale === true;
  if (hardFail) return 1;
  if (f.channelUnreachable) return WARN_EXIT;
  return 0;
}

type Storage = ReturnType<typeof getStorage>;

interface DbCheckResult {
  /** false only when the DB exists but cannot be opened/queried. */
  ok: boolean;
  /** true when the file has not been created yet — a healthy fresh-install state. */
  absent: boolean;
  error?: string;
}

async function checkSessionsDb(storage: Storage): Promise<DbCheckResult> {
  const dbPath = join(ethosDir(), 'sessions.db');
  if (!(await storage.exists(dbPath))) {
    return { ok: true, absent: true };
  }
  try {
    const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
    const store = new SQLiteSessionStore(dbPath);
    try {
      // Trivial query — exercises open + read path; surfaces WAL/corruption.
      await store.getMessages('__doctor_probe__', { limit: 1 });
      return { ok: true, absent: false };
    } finally {
      store.close();
    }
  } catch (err) {
    return { ok: false, absent: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Store integrity, vault permissions, skills/teams sanity (plan
// agent-state-backup §4)
// ---------------------------------------------------------------------------

export interface IntegrityResult {
  /** `dataDir`-relative database path. */
  database: string;
  status: 'ok' | 'absent' | 'failed';
  /** What `PRAGMA integrity_check` said, or why it could not be run. */
  detail?: string;
}

/** What one `WAL_STORES` pattern names on THIS machine. */
interface StoreExpansion {
  paths: string[];
  /** Set when the directory is there but could not be listed. Carries the errno. */
  error?: string;
}

/**
 * Expand one `WAL_STORES` location into the paths it names on THIS machine.
 * `*` matches one directory segment (`teams/*​/board.db`).
 *
 * A directory that is ABSENT expands to nothing — those stores do not exist
 * here, which is the truth. Any other failure is "I could not look", and
 * returning nothing for it would delete registered databases from the
 * integrity report and let `doctor` pass without having checked them. That
 * becomes a failed result instead, so it is printed and counts toward the exit.
 */
function expandStorePath(dataDir: string, pattern: string): StoreExpansion {
  const star = pattern.indexOf('*');
  if (star < 0) return { paths: [pattern] };
  const before = pattern.slice(0, star).replace(/\/$/, '');
  const after = pattern.slice(star + 1).replace(/^\//, '');
  const dir = join(dataDir, before);
  try {
    return {
      paths: readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => `${before}/${e.name}/${after}`)
        .sort(),
    };
  } catch (err) {
    const code = err instanceof Error && 'code' in err ? String(err.code) : 'unknown';
    if (code === 'ENOENT') return { paths: [] };
    return { paths: [], error: `cannot list ${before}/ (${code})` };
  }
}

/**
 * Run `PRAGMA integrity_check` over every database the repo declares.
 *
 * The list is `WAL_STORES` — the same registry the backup scope table is built
 * from and the drift gate holds to the repo — rather than a hardcoded name, so
 * a store added anywhere is covered here the moment it is classified. Excluded
 * stores (delivery-ledger, inbound-dedup, notify-queue) are checked too:
 * whether a database is worth backing up and whether it is corrupt are
 * different questions.
 */
export async function checkDatabaseIntegrity(dataDir: string): Promise<IntegrityResult[]> {
  const { WAL_STORES } = await import('@ethosagent/wiring');
  const { default: Database } = await import('@ethosagent/sqlite');

  const paths = new Set<string>();
  const unreadable: IntegrityResult[] = [];
  for (const store of WAL_STORES) {
    for (const pattern of [store.database, ...(store.alsoAt ?? [])]) {
      const expansion = expandStorePath(dataDir, pattern);
      for (const path of expansion.paths) paths.add(path);
      if (expansion.error !== undefined) {
        unreadable.push({ database: pattern, status: 'failed', detail: expansion.error });
      }
    }
  }

  const out: IntegrityResult[] = [...unreadable];
  for (const rel of [...paths].sort()) {
    const full = join(dataDir, rel);
    if (!existsSync(full)) {
      out.push({ database: rel, status: 'absent' });
      continue;
    }
    let db: InstanceType<typeof Database> | undefined;
    try {
      // Opened read-WRITE on purpose. A read-only open of a WAL database whose
      // `-shm` index is absent cannot create one and fails outright, which
      // would report a healthy store as corrupt. `integrity_check` itself
      // writes nothing.
      db = new Database(full);
      const rows: unknown[] = db.prepare('PRAGMA integrity_check').all();
      const first = rows[0];
      const verdict =
        first && typeof first === 'object' && 'integrity_check' in first
          ? String(first.integrity_check)
          : 'no result';
      out.push(
        verdict === 'ok'
          ? { database: rel, status: 'ok' }
          : { database: rel, status: 'failed', detail: verdict },
      );
    } catch (err) {
      out.push({
        database: rel,
        status: 'failed',
        detail: err instanceof Error ? err.message : String(err),
      });
    } finally {
      db?.close();
    }
  }
  return out;
}

export interface VaultModeResult {
  path: string;
  present: boolean;
  /** Octal permission bits, e.g. `'700'`. Absent when the directory is not there. */
  mode?: string;
  /** True when group or other hold ANY bit on the vault directory. */
  tooOpen: boolean;
}

/**
 * `~/.ethos/secrets/` holds credential files; nothing but the owner may reach
 * it. `FileSecretsResolver` already chmods the directory to 0700 on every
 * `set`, so anything else here was done to it from outside.
 *
 * The test is "group or other hold any bit", not "the mode is exactly 0700" —
 * 0500 is tighter, not looser, and calling it a failure would be wrong.
 */
/**
 * The one sentence `doctor` says about the vault's mode. Exported for the same
 * reason `computeDoctorExit` is: the claim is the thing under test.
 *
 * It prints the mode that was READ. The line this replaces printed a constant
 * `0700` for every mode that passed, which is a false statement about the
 * tighter ones the check deliberately accepts.
 */
export function describeSecretsDirMode(result: VaultModeResult): string {
  if (!result.present) return 'secrets/ not created yet.';
  return result.tooOpen
    ? `secrets/ is mode ${result.mode}, not owner-only`
    : `secrets/ is mode ${result.mode} (owner only)`;
}

export function checkSecretsDirMode(dataDir: string): VaultModeResult {
  const path = join(dataDir, 'secrets');
  if (!existsSync(path)) return { path, present: false, tooOpen: false };
  const mode = statSync(path).mode & 0o777;
  return {
    path,
    present: true,
    mode: mode.toString(8).padStart(3, '0'),
    tooOpen: (mode & 0o077) !== 0,
  };
}

export interface DirSanityIssue {
  /** `dataDir`-relative path the issue is about. */
  path: string;
  message: string;
}

/**
 * `skills/<id>/SKILL.md`, or `skills/<scope>/<slug>/SKILL.md` — the two layouts
 * `UniversalScanner` reads. A directory matching neither is a skill that will
 * never load, which is worth saying before the user wonders why.
 */
export function checkSkillsDir(dataDir: string): DirSanityIssue[] {
  const root = join(dataDir, 'skills');
  if (!existsSync(root)) return [];
  const issues: DirSanityIssue[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const dir = join(root, entry.name);
    if (existsSync(join(dir, 'SKILL.md'))) continue;
    const nested = readdirSync(dir, { withFileTypes: true }).some(
      (sub) => sub.isDirectory() && existsSync(join(dir, sub.name, 'SKILL.md')),
    );
    if (!nested) {
      issues.push({
        path: `skills/${entry.name}`,
        message: `no SKILL.md in skills/${entry.name}/ or any subdirectory — this skill will not load`,
      });
    }
  }
  return issues;
}

/**
 * A team's data lives at `teams/<name>/`, its manifest at `teams/<name>.yaml`.
 * A data directory with no manifest is a team nothing can start.
 */
export function checkTeamsDir(dataDir: string): DirSanityIssue[] {
  const root = join(dataDir, 'teams');
  if (!existsSync(root)) return [];
  const issues: DirSanityIssue[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (existsSync(join(root, `${entry.name}.yaml`))) continue;
    issues.push({
      path: `teams/${entry.name}`,
      message: `teams/${entry.name}/ has no teams/${entry.name}.yaml manifest — this team cannot start`,
    });
  }
  return issues;
}

interface GatewayHealthResult {
  status: 'ok' | 'stale' | 'down';
  adapters: Array<{ name: string; ok: boolean }>;
  lastHeartbeatAgeSec: number | null;
}

/** Mirrors the web-api `/healthz` heartbeat semantics (30s staleness). */
async function checkGatewayHealth(storage: Storage): Promise<GatewayHealthResult> {
  const healthPath = join(homedir(), '.ethos', 'gateway-health.json');
  try {
    const raw = await storage.read(healthPath);
    if (!raw) return { status: 'down', adapters: [], lastHeartbeatAgeSec: null };
    const hb = JSON.parse(raw) as {
      updatedAt: string;
      adapters?: Array<{ name: string; ok: boolean }>;
    };
    const ageSec = (Date.now() - new Date(hb.updatedAt).getTime()) / 1000;
    const stale = !Number.isFinite(ageSec) || ageSec > 30;
    return {
      status: stale ? 'stale' : 'ok',
      // Guard against a malformed heartbeat file where `adapters` is present
      // but not an array — iterating a non-array below would throw.
      adapters: Array.isArray(hb.adapters) ? hb.adapters : [],
      lastHeartbeatAgeSec: Number.isFinite(ageSec) ? Math.round(ageSec) : null,
    };
  } catch {
    return { status: 'down', adapters: [], lastHeartbeatAgeSec: null };
  }
}

export interface CallCaptureDaemonHealthResult {
  status: 'ok' | 'stale' | 'down';
  lastHeartbeatAgeSec: number | null;
}

/** Mirrors `checkGatewayHealth`'s exact shape/semantics (30s staleness), for
 *  the call-capture daemon's own heartbeat file (`ethos serve`/`ethos
 *  gateway` both write it every 10s while their `CallCaptureDaemon` is
 *  running — see `extensions/platform-callcapture/src/health.ts`'s
 *  `callCaptureHealthPath()`). Says whether the daemon is alive RIGHT NOW,
 *  which `checkCallCapture`'s binary-presence check cannot answer on its
 *  own — a crashed or never-started daemon would otherwise report healthy. */
export async function checkCallCaptureDaemonHealth(
  storage: Storage,
): Promise<CallCaptureDaemonHealthResult> {
  try {
    const raw = await storage.read(callCaptureHealthPath());
    if (!raw) return { status: 'down', lastHeartbeatAgeSec: null };
    const hb = JSON.parse(raw) as { updatedAt: string };
    const ageSec = (Date.now() - new Date(hb.updatedAt).getTime()) / 1000;
    const stale = !Number.isFinite(ageSec) || ageSec > 30;
    return {
      status: stale ? 'stale' : 'ok',
      lastHeartbeatAgeSec: Number.isFinite(ageSec) ? Math.round(ageSec) : null,
    };
  } catch {
    return { status: 'down', lastHeartbeatAgeSec: null };
  }
}

interface ChannelProbeResult {
  platform: 'telegram' | 'slack' | 'discord';
  ok: boolean;
  reason?: 'rejected' | 'unreachable' | 'unverified';
  label?: string;
  error?: string;
}

/** Live-probe every configured channel token. `config` must be RESOLVED
 *  (actual tokens, not `${secrets:…}` refs). */
async function probeConfiguredChannels(config: EthosConfig | null): Promise<ChannelProbeResult[]> {
  if (!config) return [];
  const out: ChannelProbeResult[] = [];
  if (config.telegramToken) {
    const { validateTelegramToken } = await import('@ethosagent/platform-telegram/validate');
    const v = await validateTelegramToken(config.telegramToken);
    out.push({ platform: 'telegram', ok: v.ok, reason: v.reason, label: v.label, error: v.error });
  }
  if (config.slackBotToken) {
    const { validateSlackToken } = await import('@ethosagent/platform-slack/validate');
    const v = await validateSlackToken(config.slackBotToken);
    out.push({ platform: 'slack', ok: v.ok, reason: v.reason, label: v.label, error: v.error });
  }
  if (config.discordToken) {
    const { validateDiscordToken } = await import('@ethosagent/platform-discord/validate');
    const v = await validateDiscordToken(config.discordToken);
    out.push({ platform: 'discord', ok: v.ok, reason: v.reason, label: v.label, error: v.error });
  }
  return out;
}

/** Load-bearing doctor line for a channel probe (W2.3 / Z-T15). Telegram
 *  strings are verbatim; other platforms follow the same grammar. */
function channelProbeLine(p: ChannelProbeResult): string {
  if (p.ok) return `${p.platform}: ok${p.label ? ` (${p.label})` : ''}`;
  if (p.reason === 'rejected') {
    if (p.platform === 'telegram') {
      return 'telegram: token rejected (401) — regenerate with @BotFather.';
    }
    return `${p.platform}: token rejected — regenerate the token in the platform settings.`;
  }
  if (p.reason === 'unverified') {
    return `${p.platform}: rate-limited (429) — token unverified, retry later (not a settled verdict).`;
  }
  if (p.platform === 'telegram') {
    return 'telegram: unreachable (timeout) — token unverified, not necessarily invalid.';
  }
  return `${p.platform}: unreachable — token unverified, not necessarily invalid.`;
}

export interface DoctorOptions {
  /** v2.2 — Optional plugin loader for running plugin health checks.
   *  When provided (e.g. from a running gateway), doctor displays plugin
   *  health alongside the standard checks. */
  pluginLoader?: {
    runHealthChecks(): Promise<
      Array<{
        pluginId: string;
        checkName: string;
        description: string;
        result: { status: 'ok' | 'warn' | 'error'; message: string; durationMs?: number };
      }>
    >;
  };
}

export async function runDoctor(args: string[] = [], options?: DoctorOptions): Promise<void> {
  if (args.includes('--recent-errors')) {
    runRecentErrorsReport();
    return;
  }

  if (args.includes('--fix')) {
    await runDoctorFix();
    return;
  }

  if (args.includes('--check-provider')) {
    const jsonMode = args.includes('--json');
    await runProviderProbe(jsonMode);
    return;
  }

  if (args.includes('--funnel')) {
    await runFunnelReport(args.includes('--json'));
    return;
  }

  const jsonMode = args.includes('--json');

  if (jsonMode) {
    const storage = getStorage();
    const config = await readRawConfig(storage);
    const cfgPath = join(ethosDir(), 'config.yaml');
    const userPersonalitiesDir = join(homedir(), '.ethos', 'personalities');
    const personalitiesLoadable = await storage.exists(userPersonalitiesDir);

    const sdks: Array<{
      label: string;
      module: string;
      required: boolean;
      configured?: boolean;
      loadable: boolean;
    }> = [];

    for (const row of CORE_SDKS) {
      const { ok } = await checkSdk(row.module);
      sdks.push({ label: row.label, module: row.module, required: true, loadable: ok });
    }
    for (const row of CHANNEL_SDKS) {
      const { ok } = await checkSdk(row.module);
      const configured = config ? Boolean(row.configuredWhen?.(config)) : false;
      sdks.push({
        label: row.label,
        module: row.module,
        required: false,
        configured,
        loadable: ok,
      });
    }

    const coreFailures = sdks.filter((s) => s.required && !s.loadable);
    const configuredMissing = sdks.filter((s) => !s.required && s.configured && !s.loadable);

    const secretResults = await checkSecrets(config);
    const requiredSecretMissing = secretResults.some((s) => !s.present);

    const awsSecretsStatus = await checkAwsSecrets(config);
    const awsFailed = awsSecretsStatus.enabled && awsSecretsStatus.reachable === false;

    // W2.3 — DB, gateway heartbeat, and channel-token liveness.
    const db = await checkSessionsDb(storage);
    const integrity = await checkDatabaseIntegrity(ethosDir());
    const secretsDir = checkSecretsDirMode(ethosDir());
    const skillIssues = checkSkillsDir(ethosDir());
    const teamIssues = checkTeamsDir(ethosDir());
    const gateway = await checkGatewayHealth(storage);
    const skipChannelProbe =
      args.includes('--skip-channel-probe') || process.env.ETHOS_SKIP_VALIDATION === '1';
    const resolvedConfig = skipChannelProbe
      ? null
      : await readConfig(storage, await getSecretsResolver());
    const channels = skipChannelProbe ? [] : await probeConfiguredChannels(resolvedConfig);
    const channelRejected = channels.some((c) => !c.ok && c.reason === 'rejected');
    // `unverified` (rate-limited) shares the warn exit with `unreachable` — the
    // distinct reason is still surfaced per-channel in the JSON below, so a 429
    // is never reported as a settled/clean verdict.
    const channelUnreachable = channels.some(
      (c) => !c.ok && (c.reason === 'unreachable' || c.reason === 'unverified'),
    );

    const callCapture = await checkCallCapture(config, storage);

    const exitCode = computeDoctorExit({
      coreFailure: coreFailures.length > 0,
      configuredMissing: configuredMissing.length > 0,
      awsFailed,
      requiredSecretMissing,
      dbUnopenable: !db.ok,
      dbIntegrityFailed: integrity.some((r) => r.status === 'failed'),
      secretsDirTooOpen: secretsDir.tooOpen,
      gatewayStale: gateway.status === 'stale',
      channelRejected,
      channelUnreachable,
      callCaptureDepsMissing: callCapture.configured && !callCapture.ok,
      callCaptureDaemonStale: callCapture.daemon?.status === 'stale',
    });

    const result = {
      version: buildVersionInfo(),
      sdks,
      config: config ? { present: true, path: cfgPath } : { present: false, path: cfgPath },
      personalities: { dir: userPersonalitiesDir, loadable: personalitiesLoadable },
      secrets: secretResults.map((s) => ({
        key: s.key,
        present: s.present,
        required: s.required,
        fillWith: s.fillWith,
      })),
      skillCliIssues: await buildSkillsCliJson(),
      awsSecrets: awsSecretsStatus,
      db: { ok: db.ok, absent: db.absent, ...(db.error ? { error: db.error } : {}) },
      storeIntegrity: integrity,
      secretsDir,
      skillIssues,
      teamIssues,
      gateway,
      channels: channels.map((c) => ({
        platform: c.platform,
        ok: c.ok,
        ...(c.reason ? { reason: c.reason } : {}),
        ...(c.label ? { label: c.label } : {}),
      })),
      callCapture: {
        configured: callCapture.configured,
        ok: callCapture.ok,
        ...(callCapture.missing.length > 0 ? { missing: callCapture.missing } : {}),
        ...(callCapture.errors.length > 0 ? { errors: callCapture.errors } : {}),
        ...(callCapture.daemon ? { daemon: callCapture.daemon } : {}),
      },
      exit: exitCode,
    };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (exitCode > 0) process.exit(exitCode);
    return;
  }

  console.log('');
  console.log(`${c.bold}ethos doctor${c.reset}  ${c.dim}runtime health check${c.reset}`);
  console.log('');

  // -------------------------------------------------------------------------
  // Environment
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Environment${c.reset}`);
  console.log(`  ethos    ${ETHOS_VERSION}`);
  console.log(`  node     ${process.version}`);
  console.log(`  platform ${process.platform} ${process.arch}`);
  console.log('');

  // -------------------------------------------------------------------------
  // Config
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Config${c.reset}`);
  const storage = getStorage();
  const config = await readRawConfig(storage);
  const cfgPath = join(ethosDir(), 'config.yaml');
  if (!config) {
    console.log(`  ${c.yellow}⚠${c.reset}  No config at ${c.dim}${cfgPath}${c.reset}`);
    console.log(
      `      ${c.dim}Run ${c.reset}${c.cyan}ethos setup${c.reset}${c.dim} to create one.${c.reset}`,
    );
    console.log(
      `      ${c.dim}Or: ${c.reset}${c.cyan}ethos doctor --fix${c.reset}${c.dim} → ${c.cyan}ethos setup auth${c.reset}${c.dim} → ${c.cyan}ethos setup model${c.reset}`,
    );
  } else {
    console.log(`  ${c.green}✓${c.reset}  ${cfgPath}`);
    console.log(`     provider:    ${config.provider ?? '(not set)'}`);
    console.log(`     model:       ${config.model ?? '(not set)'}`);
    console.log(`     personality: ${config.personality ?? '(default)'}`);
    // `ethos gateway` and `ethos listen` surface these at boot; an operator
    // running `ethos serve` and driving the web UI would otherwise never see
    // them, and this is the command whose job is "what is wrong with my config".
    const notices = configParseNotices(config);
    for (const err of notices.errors) console.log(`  ${c.red}✗${c.reset}  ${err}`);
    for (const warn of notices.warnings) console.log(`  ${c.yellow}⚠${c.reset}  ${warn}`);
    // A `model:` the ChatGPT account cannot use fails every turn with a bare
    // 400; this is the command whose job is to say so before the first turn.
    if (process.env.ETHOS_SKIP_VALIDATION !== '1') {
      const line = codexModelLine(await checkCodexModel(config, await getSecretsResolver()));
      if (line) console.log(line);
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Secrets
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Secrets${c.reset}`);
  const secretResults = await checkSecrets(config);
  let requiredSecretMissing = false;
  for (const s of secretResults) {
    const keyCol = s.key.padEnd(24);
    if (s.present) {
      console.log(`  ${c.green}✓${c.reset}  ${keyCol} present`);
    } else {
      requiredSecretMissing = true;
      console.log(
        `  ${c.red}✗${c.reset}  ${keyCol} ${c.red}missing${c.reset}   ${c.dim}${s.fillWith}${c.reset}`,
      );
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // AWS Secrets Manager
  // -------------------------------------------------------------------------

  if (config?.aws?.secrets?.enabled) {
    console.log(`${c.bold}AWS Secrets Manager${c.reset}`);
    let awsResolver: { list(): Promise<string[]>; dispose(): void } | undefined;
    try {
      const { AwsSecretsManagerResolver } = await import('@ethosagent/secrets-aws');
      awsResolver = new AwsSecretsManagerResolver({
        region: config.aws.secrets.region ?? 'us-east-1',
        prefix: config.aws.secrets.prefix ?? 'ethos',
        endpoint: config.aws.secrets.endpoint,
      });
      const refs = await awsResolver.list();
      console.log(
        `  ${c.green}✓${c.reset}  Reachable, ${refs.length} secret${refs.length === 1 ? '' : 's'} visible under ${c.dim}${config.aws.secrets.prefix ?? 'ethos'}/${c.reset}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${c.red}✗${c.reset}  Not reachable: ${c.dim}${msg}${c.reset}`);
    } finally {
      awsResolver?.dispose();
    }
    console.log('');
  }

  // -------------------------------------------------------------------------
  // Personality data directory
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Personality data${c.reset}`);
  const userPersonalitiesDir = join(homedir(), '.ethos', 'personalities');
  if (await storage.exists(userPersonalitiesDir)) {
    console.log(
      `  ${c.green}✓${c.reset}  Custom personalities dir: ${c.dim}${userPersonalitiesDir}${c.reset}`,
    );
  } else {
    console.log(
      `  ${c.dim}–  No custom personalities directory yet (built-ins still work). Create ${userPersonalitiesDir}/ to add your own.${c.reset}`,
    );
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Core SDKs
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Core SDKs${c.reset}`);
  const coreResults: RowResult[] = [];
  for (const row of CORE_SDKS) {
    const { ok } = await checkSdk(row.module);
    coreResults.push({ row, ok, inUse: true });
    printRow(coreResults.at(-1) as RowResult);
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Channel SDKs
  // -------------------------------------------------------------------------

  console.log(
    `${c.bold}Channel SDKs${c.reset}  ${c.dim}(optional — only matters when configured)${c.reset}`,
  );
  const channelResults: RowResult[] = [];
  for (const row of CHANNEL_SDKS) {
    const { ok } = await checkSdk(row.module);
    const inUse = config ? Boolean(row.configuredWhen?.(config)) : false;
    channelResults.push({ row, ok, inUse });
    printRow(channelResults.at(-1) as RowResult);
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Skill prerequisites
  // -------------------------------------------------------------------------

  console.log(
    `${c.bold}Skill prerequisites${c.reset}  ${c.dim}(external CLIs declared by bundled skills)${c.reset}`,
  );
  const skillIssues = await checkSkillPrerequisites();
  if (skillIssues.length === 0) {
    console.log(`  ${c.green}✓${c.reset}  All declared external CLIs are reachable.`);
  } else {
    for (const issue of skillIssues) {
      console.log(
        `  ${c.yellow}⚠${c.reset}  ${c.bold}${issue.skill}${c.reset} needs ${c.cyan}${issue.cli}${c.reset} ${c.dim}(not on PATH)${c.reset}`,
      );
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Voice — what `config.voice.*` + `auxiliary.asr/tts` actually resolve to
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Voice${c.reset}`);
  for (const line of await voiceReport(config)) console.log(line);
  console.log('');

  // -------------------------------------------------------------------------
  // Call capture (Phase 4) — macOS-only, opt-in via callCapture.personalityId.
  // Silent when unconfigured — see checkCallCapture's doc comment.
  // -------------------------------------------------------------------------

  const callCapture = await checkCallCapture(config, storage);
  if (callCapture.configured) {
    console.log(`${c.bold}Call capture${c.reset}`);
    if (callCapture.ok) {
      console.log(
        `  ${c.green}✓${c.reset}  All dependencies present ${c.dim}(capture-offer-card, mic-detector, mic-capture, audiotee)${c.reset}`,
      );
    } else {
      console.log(`  ${c.red}✗${c.reset}  Missing: ${callCapture.missing.join(', ')}`);
      for (const err of callCapture.errors) console.log(`      ${c.dim}${err}${c.reset}`);
    }
    if (callCapture.daemon) {
      if (callCapture.daemon.status === 'ok') {
        console.log(
          `  ${c.green}✓${c.reset}  Daemon alive ${c.dim}(heartbeat ${callCapture.daemon.lastHeartbeatAgeSec}s ago)${c.reset}`,
        );
      } else if (callCapture.daemon.status === 'stale') {
        console.log(
          `  ${c.red}✗${c.reset}  Daemon heartbeat stale (${callCapture.daemon.lastHeartbeatAgeSec}s ago) — it may have crashed`,
        );
      } else {
        console.log(
          `  ${c.dim}–  No daemon heartbeat (not currently running inside 'ethos serve'/'ethos gateway').${c.reset}`,
        );
      }
    }
    console.log('');
  }

  // -------------------------------------------------------------------------
  // Plugin health checks (v2.2)
  // -------------------------------------------------------------------------

  if (options?.pluginLoader) {
    console.log(`${c.bold}Plugin Health Checks${c.reset}`);
    try {
      const results = await options.pluginLoader.runHealthChecks();
      if (results.length === 0) {
        console.log(`  ${c.dim}–  No plugin health checks registered.${c.reset}`);
      } else {
        for (const r of results) {
          const icon =
            r.result.status === 'ok'
              ? `${c.green}✓${c.reset}`
              : r.result.status === 'warn'
                ? `${c.yellow}⚠${c.reset}`
                : `${c.red}✗${c.reset}`;
          const duration =
            r.result.durationMs != null
              ? ` ${c.dim}(${Math.round(r.result.durationMs)}ms)${c.reset}`
              : '';
          console.log(`  ${icon}  ${r.pluginId}/${r.checkName}${duration}`);
          console.log(`      ${c.dim}${r.result.message}${c.reset}`);
        }
      }
    } catch (err) {
      console.log(
        `  ${c.yellow}⚠${c.reset}  ${c.dim}Plugin health checks failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
      );
    }
    console.log('');
  }

  // -------------------------------------------------------------------------
  // Sessions database (W2.3)
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Sessions database${c.reset}`);
  const db = await checkSessionsDb(storage);
  if (db.absent) {
    console.log(`  ${c.dim}–  Not created yet (built on first chat).${c.reset}`);
  } else if (db.ok) {
    console.log(`  ${c.green}✓${c.reset}  sessions.db opens and queries cleanly`);
  } else {
    console.log(`  ${c.red}✗${c.reset}  sessions.db failed to open: ${c.dim}${db.error}${c.reset}`);
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Store integrity (plan agent-state-backup §4)
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Store integrity${c.reset}`);
  const integrity = await checkDatabaseIntegrity(ethosDir());
  const present = integrity.filter((r) => r.status !== 'absent');
  const broken = integrity.filter((r) => r.status === 'failed');
  if (present.length === 0) {
    console.log(`  ${c.dim}–  No databases created yet.${c.reset}`);
  } else if (broken.length === 0) {
    console.log(
      `  ${c.green}✓${c.reset}  PRAGMA integrity_check ok on ${present.length} store(s) ${c.dim}(${integrity.length - present.length} not created yet)${c.reset}`,
    );
  } else {
    for (const row of broken) {
      console.log(`  ${c.red}✗${c.reset}  ${row.database}: ${c.dim}${row.detail}${c.reset}`);
    }
    console.log(
      `  ${c.dim}Restore from a backup: ${c.reset}${c.bold}ethos import <archive>${c.reset}`,
    );
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Secrets vault, skills and teams (plan agent-state-backup §4)
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Data directory${c.reset}`);
  const secretsDir = checkSecretsDirMode(ethosDir());
  if (!secretsDir.present) {
    console.log(`  ${c.dim}–  ${describeSecretsDirMode(secretsDir)}${c.reset}`);
  } else if (secretsDir.tooOpen) {
    console.log(
      `  ${c.red}✗${c.reset}  ${describeSecretsDirMode(secretsDir)} — run ${c.bold}ethos doctor --fix${c.reset}`,
    );
  } else {
    console.log(`  ${c.green}✓${c.reset}  ${describeSecretsDirMode(secretsDir)}`);
  }
  const dirIssues = [...checkSkillsDir(ethosDir()), ...checkTeamsDir(ethosDir())];
  if (dirIssues.length === 0) {
    console.log(`  ${c.green}✓${c.reset}  skills/ and teams/ layouts look right`);
  } else {
    for (const issue of dirIssues) {
      console.log(`  ${c.yellow}⚠${c.reset}  ${issue.message}`);
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Gateway heartbeat (W2.3) — mirrors web-api /healthz semantics
  // -------------------------------------------------------------------------

  console.log(`${c.bold}Gateway heartbeat${c.reset}`);
  const gateway = await checkGatewayHealth(storage);
  if (gateway.status === 'ok') {
    console.log(
      `  ${c.green}✓${c.reset}  fresh (${gateway.lastHeartbeatAgeSec}s ago), ${gateway.adapters.length} adapter(s)`,
    );
  } else if (gateway.status === 'stale') {
    console.log(
      `  ${c.red}✗${c.reset}  stale heartbeat (${gateway.lastHeartbeatAgeSec}s ago — gateway may have died)`,
    );
  } else {
    console.log(`  ${c.dim}–  No heartbeat file (gateway not running).${c.reset}`);
  }
  for (const a of gateway.adapters) {
    const icon = a.ok ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
    console.log(`      ${icon} ${a.name}`);
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Channel-token liveness (W2.3) — live probe per configured channel
  // -------------------------------------------------------------------------

  const skipChannelProbe =
    args.includes('--skip-channel-probe') || process.env.ETHOS_SKIP_VALIDATION === '1';
  const channelProbes = skipChannelProbe
    ? []
    : await probeConfiguredChannels(await readConfig(storage, await getSecretsResolver()));
  console.log(`${c.bold}Channel tokens${c.reset}`);
  if (skipChannelProbe) {
    console.log(`  ${c.dim}–  Skipped (--skip-channel-probe / ETHOS_SKIP_VALIDATION).${c.reset}`);
  } else if (channelProbes.length === 0) {
    console.log(`  ${c.dim}–  No channels configured.${c.reset}`);
  } else {
    for (const p of channelProbes) {
      const icon = p.ok
        ? `${c.green}✓${c.reset}`
        : p.reason === 'rejected'
          ? `${c.red}✗${c.reset}`
          : `${c.yellow}⚠${c.reset}`;
      console.log(`  ${icon}  ${channelProbeLine(p)}`);
    }
  }
  console.log('');

  // -------------------------------------------------------------------------
  // Verdict
  // -------------------------------------------------------------------------

  const coreFailures = coreResults.filter((r) => !r.ok);
  const configuredButMissing = channelResults.filter((r) => !r.ok && r.inUse);
  const channelRejected = channelProbes.some((p) => !p.ok && p.reason === 'rejected');
  const channelUnreachable = channelProbes.some(
    (p) => !p.ok && (p.reason === 'unreachable' || p.reason === 'unverified'),
  );

  let exitCode = 0;

  if (coreFailures.length > 0) {
    console.log(
      `${c.red}✗ Core SDK missing — ethos cannot run.${c.reset} Reinstall: ${c.cyan}npm install -g @ethosagent/cli${c.reset}`,
    );
    exitCode = 1;
  }
  if (configuredButMissing.length > 0) {
    const list = configuredButMissing.map((r) => r.row.label).join(', ');
    console.log(`${c.red}✗ Configured channels with missing SDKs: ${list}${c.reset}`);
    console.log(
      `${c.dim}  Install the listed packages globally, or remove the channel from ~/.ethos/config.yaml.${c.reset}`,
    );
    console.log(
      `${c.dim}  Or try: ${c.reset}${c.cyan}ethos doctor --fix${c.reset}${c.dim} → ${c.cyan}ethos setup auth${c.reset}${c.dim} → ${c.cyan}ethos setup model${c.reset}`,
    );
    exitCode = 1;
  }
  if (requiredSecretMissing) {
    console.log(`${c.red}✗ Required secret missing — see Secrets section above.${c.reset}`);
    exitCode = 1;
  }
  if (!db.ok) {
    console.log(
      `${c.red}✗ sessions.db could not be opened — see Sessions database above.${c.reset}`,
    );
    exitCode = 1;
  }
  if (broken.length > 0) {
    console.log(
      `${c.red}✗ ${broken.length} store(s) failed PRAGMA integrity_check — see Store integrity above.${c.reset}`,
    );
    exitCode = 1;
  }
  if (secretsDir.tooOpen) {
    console.log(
      `${c.red}✗ secrets/ is readable beyond its owner (mode ${secretsDir.mode}) — run ${c.cyan}ethos doctor --fix${c.reset}${c.red}.${c.reset}`,
    );
    exitCode = 1;
  }
  if (gateway.status === 'stale') {
    console.log(
      `${c.red}✗ Gateway heartbeat is stale — the gateway process may have died.${c.reset}`,
    );
    exitCode = 1;
  }
  if (channelRejected) {
    console.log(`${c.red}✗ A channel token was rejected — see Channel tokens above.${c.reset}`);
    exitCode = 1;
  }
  if (callCapture.configured && !callCapture.ok) {
    console.log(
      `${c.red}✗ Call capture is configured but a dependency is missing — see Call capture above.${c.reset}`,
    );
    exitCode = 1;
  }
  // Unreachable-but-not-rejected → DISTINCT warn exit code (2), so CI can tell a
  // bad token from an outage. Hard failures still take precedence.
  if (exitCode === 0 && channelUnreachable) {
    console.log(
      `${c.yellow}⚠ A channel token could not be verified (platform unreachable) — see above.${c.reset}`,
    );
    exitCode = WARN_EXIT;
  }
  if (exitCode > 0) {
    process.exit(exitCode);
  }
  console.log(`${c.green}✓ Healthy.${c.reset}`);
}

// ---------------------------------------------------------------------------
// --fix: auto-repair common issues
// ---------------------------------------------------------------------------

async function runDoctorFix(): Promise<void> {
  // chmod stays raw node:fs — Storage has no permissions API (keys.json /
  // config.yaml owner-restriction is the whole point of this repair step).
  const { chmod } = await import('node:fs/promises');
  const storage = getStorage();
  const dir = ethosDir();
  let exitCode = 0;

  console.log('');
  console.log(`${c.bold}ethos doctor --fix${c.reset}`);
  console.log('');

  // 1. Ensure the directories every surface expects exist. `backups/` is where
  //    `ethos backup` and the scheduled job write; the rest are read by the
  //    personality registry, the skill scanner and the team supervisor.
  for (const name of ['personalities', 'skills', 'teams', 'backups']) {
    const path = join(dir, name);
    if (!(await storage.exists(path))) {
      await storage.mkdir(path);
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Created ${path}`);
    } else {
      console.log(`  ${c.green}✓${c.reset}  ${path} exists`);
    }
  }

  // 2. Seed MEMORY.md and USER.md
  for (const filename of ['MEMORY.md', 'USER.md']) {
    const path = join(dir, filename);
    if (!(await storage.exists(path))) {
      await storage.write(path, '');
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Created ${path}`);
    } else {
      console.log(`  ${c.green}✓${c.reset}  ${path} exists`);
    }
  }

  // 3. Fix keys.json permissions (should be 0o600)
  const keysPath = join(dir, 'keys.json');
  if (await storage.exists(keysPath)) {
    try {
      await chmod(keysPath, 0o600);
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Set ${keysPath} to 0600`);
    } catch {
      console.log(`  ${c.yellow}⚠${c.reset}  Could not chmod ${keysPath}`);
      exitCode = 1;
    }
  }

  // 4. Fix config.yaml permissions (may contain secret refs; restrict to owner)
  const configPath = join(dir, 'config.yaml');
  if (await storage.exists(configPath)) {
    try {
      await chmod(configPath, 0o600);
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Set ${configPath} to 0600`);
    } catch {
      console.log(`  ${c.yellow}⚠${c.reset}  Could not chmod ${configPath}`);
      exitCode = 1;
    }
  }

  // 5. Tighten ~/.ethos/secrets/ to 0700 (owner only)
  const secretsPath = join(dir, 'secrets');
  if (await storage.exists(secretsPath)) {
    try {
      await chmod(secretsPath, 0o700);
      console.log(`  ${c.green}✓ Fixed:${c.reset}  Set ${secretsPath} to 0700`);
    } catch {
      console.log(`  ${c.yellow}⚠${c.reset}  Could not chmod ${secretsPath}`);
      exitCode = 1;
    }
  }

  // 6. Validate provider in config
  const config = await readRawConfig(storage);
  if (config) {
    const { PROVIDER_CATALOG } = await import('@ethosagent/wiring/provider-catalog');
    const knownIds = PROVIDER_CATALOG.map((p) => p.id);
    if (!knownIds.includes(config.provider)) {
      const closest = knownIds.find((id) => id.startsWith(config.provider[0] ?? '')) ?? 'anthropic';
      console.log(
        `  ${c.yellow}→ Action needed:${c.reset}  Unknown provider '${config.provider}'. Did you mean '${closest}'?`,
      );
      console.log(`  ${c.dim}  Edit ~/.ethos/config.yaml and set provider: ${closest}${c.reset}`);
      exitCode = 1;
    } else {
      console.log(`  ${c.green}✓${c.reset}  Provider '${config.provider}' is valid`);
    }
  } else {
    console.log(
      `  ${c.yellow}→ Action needed:${c.reset}  No config found. Run: ${c.cyan}ethos setup${c.reset}`,
    );
    exitCode = 1;
  }

  console.log('');
  if (exitCode === 0) {
    console.log(`${c.green}✓ All auto-repairs complete.${c.reset}`);
  } else {
    console.log(
      `${c.yellow}⚠ Some issues need manual action. Try: ${c.cyan}ethos doctor --fix → ethos setup auth → ethos setup model${c.reset}`,
    );
    process.exit(exitCode);
  }
}

// ---------------------------------------------------------------------------
// --check-provider: live connectivity probe against the configured LLM
// ---------------------------------------------------------------------------

export interface ProviderProbeResult {
  provider: string;
  model: string;
  reachable: boolean;
  latencyMs: number | null;
  error: string | null;
  exit: number;
}

async function runProviderProbe(jsonMode: boolean): Promise<void> {
  const storage = getStorage();
  const config = await readRawConfig(storage);

  if (!config) {
    const result: ProviderProbeResult = {
      provider: 'unknown',
      model: 'unknown',
      reachable: false,
      latencyMs: null,
      error: 'No config found — run ethos setup',
      exit: 1,
    };
    if (jsonMode) {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } else {
      console.log(
        `Provider connectivity: ${c.red}✗${c.reset} No config found — run ${c.cyan}ethos setup${c.reset}`,
      );
    }
    process.exit(1);
  }

  const provider = config.provider;
  const model = config.model;

  let reachable = false;
  let latencyMs: number | null = null;
  let error: string | null = null;

  try {
    // Lane 0 (D16) — doctor probes the served window LIVE and rewrites the
    // probe cache, so its numbers are never stale.
    const llm = await createLLM(config, { probeWindowRefresh: true });
    const start = performance.now();
    // Consume the async iterable — we only need to confirm the provider responds.
    // Using max 1 token keeps the call as cheap as possible.
    for await (const _chunk of llm.complete([{ role: 'user', content: 'ping' }], [], {
      maxTokens: 1,
    })) {
      // drain
    }
    latencyMs = Math.round(performance.now() - start);
    reachable = true;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }

  const exit = reachable ? 0 : 1;
  const result: ProviderProbeResult = { provider, model, reachable, latencyMs, error, exit };

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } else if (reachable) {
    console.log(
      `Provider connectivity: ${c.green}✓${c.reset} ${provider} (${model}) — ${latencyMs}ms`,
    );
  } else {
    console.log(`Provider connectivity: ${c.red}✗${c.reset} ${provider} (${model}) — ${error}`);
  }

  if (exit > 0) process.exit(exit);
}

// ---------------------------------------------------------------------------
// --funnel: local adoption-funnel report (W4.2)
// ---------------------------------------------------------------------------

/** Format a millisecond delta as a compact human duration, e.g. "2m 8s". */
export function formatFunnelDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (totalMin < 60) return sec > 0 ? `${totalMin}m ${sec}s` : `${totalMin}m`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  return min > 0 ? `${hours}h ${min}m` : `${hours}h`;
}

export async function runFunnelReport(jsonMode: boolean): Promise<void> {
  // Local palette honoring NO_COLOR (plan requirement for all funnel surfaces).
  const noColor = Boolean(process.env.NO_COLOR);
  const fc = noColor
    ? { reset: '', dim: '', bold: '', green: '' }
    : { reset: c.reset, dim: c.dim, bold: c.bold, green: c.green };

  const state = await getFunnelTracker().readState();

  if (jsonMode) {
    process.stdout.write(`${JSON.stringify(state ?? {})}\n`);
    return;
  }

  console.log(`\n${fc.bold}ethos doctor --funnel${fc.reset}\n`);

  // Legacy / pre-tracking install: no setup stamp means every recorded time
  // is meaningless for TTFM — say so instead of printing garbage numbers.
  if (!state || state.setupCompletedAt === undefined) {
    console.log('No funnel data — this install predates funnel tracking (legacy).');
    if (state?.firstReplyAt !== undefined) {
      console.log(
        `${fc.dim}(a first reply was recorded on ${new Date(state.firstReplyAt).toLocaleString()} after upgrading — excluded from TTFM stats)${fc.reset}`,
      );
    }
    console.log('');
    return;
  }

  const setupAt = state.setupCompletedAt;
  const setupMeta = [
    state.setupWizardPath ? `${state.setupWizardPath} wizard` : null,
    state.setupProvider ? `provider ${state.setupProvider}` : null,
    state.setupChannels && state.setupChannels.length > 0
      ? `channels: ${state.setupChannels.join(', ')}`
      : 'no channels configured',
  ]
    .filter(Boolean)
    .join(', ');

  console.log(
    `Setup completed:      ${fc.green}✓${fc.reset} ${new Date(setupAt).toLocaleString()} ${fc.dim}(${setupMeta})${fc.reset}`,
  );

  if (state.firstReplyAt !== undefined) {
    console.log(
      `First reply:          ${fc.green}✓${fc.reset} ${new Date(state.firstReplyAt).toLocaleString()} ${fc.dim}(+${formatFunnelDuration(state.firstReplyAt - setupAt)} after setup)${fc.reset}`,
    );
  } else {
    console.log(`First reply:          ${fc.dim}not yet recorded${fc.reset}`);
  }

  const channels = Object.entries(state.channelFirstReplyAt ?? {});
  if (channels.length > 0) {
    for (const [platform, ts] of channels) {
      console.log(
        `First channel reply:  ${fc.green}✓${fc.reset} ${platform} — ${new Date(ts).toLocaleString()} ${fc.dim}(+${formatFunnelDuration(ts - setupAt)} after setup)${fc.reset}`,
      );
    }
  } else {
    console.log(`First channel reply:  ${fc.dim}not yet recorded${fc.reset}`);
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// --recent-errors: grouped summary of ~/.ethos/logs/errors.jsonl
// ---------------------------------------------------------------------------

function runRecentErrorsReport(): void {
  console.log('');
  console.log(`${c.bold}ethos doctor${c.reset}  ${c.dim}recent errors${c.reset}`);
  console.log('');

  if (!errorLogExists()) {
    console.log(`  ${c.dim}No error log yet (${errorLogPath()}).${c.reset}`);
    console.log(`  ${c.dim}This is a healthy state — nothing has failed.${c.reset}`);
    console.log('');
    return;
  }

  const recent = readRecentErrors(50);
  if (recent.length === 0) {
    console.log(`  ${c.dim}Log file is present but empty: ${errorLogPath()}${c.reset}`);
    console.log('');
    return;
  }

  // Group by code, count, keep newest occurrence per code for the timestamp.
  const byCode = new Map<string, { count: number; latest: string; sample: string }>();
  for (const e of recent) {
    const existing = byCode.get(e.code);
    if (existing) {
      existing.count += 1;
      // recent[] is newest-first; keep the first timestamp seen.
    } else {
      byCode.set(e.code, { count: 1, latest: e.ts, sample: e.cause });
    }
  }

  const rows = [...byCode.entries()].sort((a, b) => b[1].count - a[1].count);

  console.log(`  ${c.dim}From ${errorLogPath()} (last ${recent.length} entries)${c.reset}`);
  console.log('');
  console.log(`  ${c.bold}${'Count'.padStart(5)}  ${'Code'.padEnd(28)}  Most-recent at${c.reset}`);
  for (const [code, info] of rows) {
    const count = String(info.count).padStart(5);
    const codeCol = code.padEnd(28);
    console.log(`  ${count}  ${c.cyan}${codeCol}${c.reset}  ${c.dim}${info.latest}${c.reset}`);
    console.log(`         ${c.dim}↳ ${info.sample}${c.reset}`);
  }
  console.log('');
  console.log(`  ${c.dim}File a bug? Attach the relevant lines from ${errorLogPath()}.${c.reset}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// Skill prerequisite check — reads `ethos.prerequisites.external_cli` from
// each bundled skill's frontmatter and verifies the binary is on PATH.
// `coding-agent` lists multiple CLI alternatives — at least one must be
// present (it routes to whichever is installed).
// ---------------------------------------------------------------------------

interface SkillPrereqIssue {
  skill: string;
  cli: string;
}

function readExternalCliRequirements(skill: Skill): { all: string[]; anyOf: string[] } {
  const ethos = skill.rawFrontmatter.ethos as
    | { prerequisites?: { external_cli?: unknown } }
    | undefined;
  const raw = ethos?.prerequisites?.external_cli;
  if (!Array.isArray(raw)) return { all: [], anyOf: [] };
  const all: string[] = [];
  const anyOf: string[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      all.push(item);
    } else if (item && typeof item === 'object' && 'any_of' in item) {
      const list = (item as { any_of: unknown }).any_of;
      if (Array.isArray(list)) {
        for (const candidate of list) {
          if (typeof candidate === 'string') anyOf.push(candidate);
        }
      }
    }
  }
  return { all, anyOf };
}

function isOnPath(bin: string): boolean {
  return spawnSync('which', [bin], { stdio: 'ignore' }).status === 0;
}

export interface CallCaptureCheckResult {
  /** Whether `callCapture.personalityId` is set at all — an unconfigured
   *  deployment reports nothing further, same "don't warn about an unused
   *  feature" rule the Channel SDKs section follows. */
  configured: boolean;
  ok: boolean;
  missing: string[];
  errors: string[];
  /** Daemon liveness (see `checkCallCaptureDaemonHealth`) — present only
   *  when `configured` is true. Absent, not a placeholder value, when
   *  unconfigured: a deployment that never enabled call capture must see
   *  nothing new from `ethos doctor`. */
  daemon?: CallCaptureDaemonHealthResult;
}

export interface CheckCallCaptureOptions {
  /** Overrides the dependency preflight call. Tests must supply this — a
   *  fake — instead of exercising the real capture-offer-card/native-binary
   *  presence on the machine running the test suite. Mirrors
   *  `telephonyReport`'s injectable `resolveMedia` option. */
  checkDependencies?: () => Promise<CallCaptureDependencyCheckResult>;
}

/**
 * Call-capture dependency diagnostics (plan/phases/call-capture-extension.md,
 * "Preflight" §6 / T5). Structured result — text mode and `--json` mode each
 * render it their own way, mirroring `probeConfiguredChannels` /
 * `channelProbeLine`'s data/presentation split. `configured && !ok` feeds
 * `computeDoctorExit`'s `callCaptureDepsMissing` flag: configured-but-broken
 * is a hard failure, the same weight as a configured-but-missing channel SDK.
 */
export async function checkCallCapture(
  config: EthosConfig | null,
  storage: Storage,
  options: CheckCallCaptureOptions = {},
): Promise<CallCaptureCheckResult> {
  if (!config?.callCapture?.personalityId) {
    return { configured: false, ok: true, missing: [], errors: [] };
  }
  const checkDependencies =
    options.checkDependencies ??
    (async () => {
      const { checkCallCaptureDependencies } = await import('@ethosagent/platform-callcapture');
      return checkCallCaptureDependencies();
    });
  const [result, daemon] = await Promise.all([
    checkDependencies(),
    checkCallCaptureDaemonHealth(storage),
  ]);
  if (result.ok) return { configured: true, ok: true, missing: [], errors: [], daemon };
  return { configured: true, ok: false, missing: result.missing, errors: result.errors, daemon };
}

/**
 * Voice diagnostics. Runs the SAME resolution path the pipeline uses — same
 * registries, same `trustedVoicePlugins` gate — so a refusal shows up here
 * rather than as silent "voice doesn't work". Resolution constructs providers
 * only; it makes no network calls.
 */
async function voiceReport(config: EthosConfig | null): Promise<string[]> {
  const lines: string[] = [];
  const asr = config?.auxiliary?.asr;
  const tts = config?.auxiliary?.tts;
  const voice = config?.voice;
  if (!asr && !tts && !voice) {
    lines.push(
      `  ${c.dim}–  Not configured (no auxiliary.asr / auxiliary.tts / voice.*).${c.reset}`,
    );
    return lines;
  }

  // Dynamic import — @ethosagent/wiring pulls in the full provider/tool graph
  // (the heaviest package in the repo); loading it only when voice is actually
  // configured keeps --check-provider and other narrow doctor paths cheap.
  const { createBuiltinVoiceRegistries } = await import('@ethosagent/wiring');
  const { sttProviders, ttsProviders } = createBuiltinVoiceRegistries();
  const trustedVoicePlugins = voice?.trustedPlugins ? new Set(voice.trustedPlugins) : undefined;
  const stt = await resolveSttProvider({
    registry: sttProviders,
    providerName: asr?.provider,
    providerConfig: { ...asr },
    ...(trustedVoicePlugins ? { trustedVoicePlugins } : {}),
  });
  const speech = await resolveTtsProvider({
    registry: ttsProviders,
    providerName: tts?.provider,
    providerConfig: { ...tts },
    ...(trustedVoicePlugins ? { trustedVoicePlugins } : {}),
  });

  for (const [label, result] of [
    ['STT', stt],
    ['TTS', speech],
  ] as const) {
    if (result.ok) {
      const local = result.provider.caps.local ? 'local' : 'remote';
      lines.push(
        `  ${c.green}✓${c.reset}  ${label} ${c.cyan}${result.providerId}${c.reset} ${c.dim}(${local})${c.reset}`,
      );
    } else if (result.code === 'not_configured') {
      lines.push(`  ${c.dim}–  ${label} not configured.${c.reset}`);
    } else {
      lines.push(`  ${c.red}✗${c.reset}  ${label}: ${c.dim}${result.error}${c.reset}`);
    }
  }

  lines.push(
    trustedVoicePlugins
      ? `  ${c.green}✓${c.reset}  Egress gate armed ${c.dim}(voice.trustedPlugins: ${
          trustedVoicePlugins.size > 0
            ? [...trustedVoicePlugins].join(', ')
            : 'local providers only'
        })${c.reset}`
      : `  ${c.dim}–  Egress gate off (set voice.trustedPlugins to restrict non-local providers).${c.reset}`,
  );

  // Telephony gets its own rows only when there is a `voice.*` block to report
  // on. Without one there is no number, no trunk and no media question to ask —
  // and a dynamic import of a native package is not worth paying for to print
  // "absent" three ways.
  if (voice) lines.push(...(await telephonyReport(voice)));
  else lines.push(`  ${c.dim}–  Telephony not configured (no voice.*).${c.reset}`);
  return lines;
}

/**
 * Telephony rows — everything an operator needs to know BEFORE they dial.
 *
 * This replaced a single line ("N voice bot(s); LiveKit configured; SIP trunk
 * configured") that answered none of the questions a person actually has when a
 * call does not work: is the webhook listener even running, is the control plane
 * constructible, did the media SDK load, who gets through, and which number
 * reaches which personality. Each of those has its own failure and its own fix,
 * so each gets its own row.
 *
 * Two rules, both load-bearing:
 *
 *   - NOTHING here changes doctor's exit code. `computeDoctorExit` takes
 *     `DoctorFailFlags`, which has no telephony member and gains none — a
 *     deployment that does not do telephony is not unhealthy, and one that does
 *     is not unhealthy for lacking an optional native package.
 *   - An unrun probe reports SKIPPED, never passed (the `listen doctor` rule).
 *     The only thing actually exercised here is the media import; the control
 *     plane and the gates are reported as CONFIGURED, which is a different and
 *     weaker claim than "verified".
 */
export async function telephonyReport(
  voice: NonNullable<EthosConfig['voice']>,
  deps: { resolveMedia?: () => Promise<LiveKitMediaResolution> } = {},
): Promise<string[]> {
  const lines: string[] = [];
  const trunk = voice.trunk;
  const livekit = voice.livekit;

  // --- Trunk -------------------------------------------------------------
  if (!trunk) {
    lines.push(`  ${c.dim}–  SIP trunk not configured (no voice.trunk.*).${c.reset}`);
  } else {
    lines.push(
      `  ${c.green}✓${c.reset}  SIP trunk ${c.cyan}${trunk.provider}${c.reset} ${c.dim}(trunkId ${trunk.trunkId}${trunk.fromNumber ? `, from ${trunk.fromNumber}` : ''})${c.reset}`,
    );
    lines.push(
      trunk.webhookSecret
        ? `  ${c.green}✓${c.reset}  Inbound webhook secret set ${c.dim}(listener mounts at ${trunk.webhookPath ?? '/sip/inbound'})${c.reset}`
        : `  ${c.yellow}⚠${c.reset}  ${c.dim}voice.trunk.webhookSecret is unset — the inbound call listener stays off. An unsigned webhook is an open line anyone who learns the URL can ring.${c.reset}`,
    );
  }

  // --- LiveKit control plane ---------------------------------------------
  // Signed JWT + HTTPS, no SDK: present credentials mean the SIP trunk client
  // and the token minter are CONSTRUCTIBLE. Not that the server answered —
  // nothing here dials it.
  if (!livekit) {
    lines.push(
      trunk
        ? `  ${c.red}✗${c.reset}  LiveKit control plane absent ${c.dim}(voice.livekit.url/apiKey/apiSecret) — a trunk without it has no SIP control plane; telephony is unavailable.${c.reset}`
        : `  ${c.dim}–  LiveKit control plane not configured (no voice.livekit.*).${c.reset}`,
    );
  } else {
    lines.push(
      `  ${c.green}✓${c.reset}  LiveKit control plane ${c.dim}(${livekit.url}; token minter + SIP trunk client constructible — not dialled from here)${c.reset}`,
    );
  }

  // --- LiveKit media ------------------------------------------------------
  // The one thing this report actually runs. `@livekit/rtc-node` is not a repo
  // dependency (per-arch native binary), so an operator installs it themselves;
  // without it every other row can be green and a call still carries no audio.
  const resolveMedia = deps.resolveMedia ?? (() => resolveLiveKitMedia());
  const media = await resolveMedia();
  if (media.ok) {
    lines.push(
      `  ${c.green}✓${c.reset}  LiveKit media ${c.cyan}@livekit/rtc-node${media.version ? ` ${media.version}` : ''}${c.reset} ${c.dim}(calls can carry audio)${c.reset}`,
    );
  } else if (trunk || livekit) {
    lines.push(
      `  ${c.yellow}⚠${c.reset}  LiveKit media unavailable: ${c.dim}${media.reason}${c.reset}`,
    );
    lines.push(
      `  ${c.dim}   Calls are answered, screened and logged, but carry no audio until it loads.${c.reset}`,
    );
  } else {
    lines.push(`  ${c.dim}–  LiveKit media not needed (no trunk, no LiveKit).${c.reset}`);
  }

  // --- Inbound gates ------------------------------------------------------
  const inbound = voice.inbound;
  lines.push(
    `  ${c.dim}   Inbound gates: concurrency ${inbound?.concurrencyCap ?? '2 (default)'}` +
      `; per-caller/hour ${inbound?.perCallerPerHour ?? 'unlimited'}` +
      `; daily budget ${inbound?.dailyBudgetUsd !== undefined ? `$${inbound.dailyBudgetUsd}` : 'unlimited'}` +
      `; prewarm ${inbound?.prewarm ?? 'allowlisted (default)'}${c.reset}`,
  );
  lines.push(
    `  ${c.dim}   Allowlist ${inbound?.allowlist?.length ?? 0} pattern(s)` +
      `; receptionist ${inbound?.receptionist ?? 'not configured'}` +
      `; owner ${inbound?.owner ? `${inbound.owner.platform}:${inbound.owner.chatId}` : 'not configured — call summaries have nowhere to go'}${c.reset}`,
  );

  // --- Number → bot → personality ----------------------------------------
  if (voice.bots.length === 0) {
    lines.push(
      `  ${c.dim}–  No voice bots configured — no number maps to a personality (voice.bots[]).${c.reset}`,
    );
  } else {
    for (const bot of voice.bots) {
      const key = bot.id ?? `sha256(${bot.match})`;
      lines.push(
        `  ${c.dim}   ${bot.match} → ${key} → ${bot.bind.type} ${bot.bind.name}${c.reset}`,
      );
    }
  }

  return lines;
}

async function checkSkillPrerequisites(): Promise<SkillPrereqIssue[]> {
  const issues: SkillPrereqIssue[] = [];
  const pool = await new UniversalScanner({
    storage: getStorage(),
    trustedFirstPartySources: [bundledSkillsSource()],
  }).scan();

  for (const skill of pool.values()) {
    if (skill.source !== 'ethos-bundled') continue;
    const { all, anyOf } = readExternalCliRequirements(skill);

    for (const cli of all) {
      if (!isOnPath(cli)) issues.push({ skill: skill.name, cli });
    }

    if (anyOf.length > 0 && !anyOf.some(isOnPath)) {
      issues.push({ skill: skill.name, cli: `one of ${anyOf.join(' / ')}` });
    }
  }

  return issues;
}

async function buildSkillsCliJson(): Promise<
  Array<{ name: string; path: string | null; ok: boolean }>
> {
  const skillIssues = await checkSkillPrerequisites();
  return skillIssues.map((i) => ({ name: i.cli, path: null, ok: false }));
}
