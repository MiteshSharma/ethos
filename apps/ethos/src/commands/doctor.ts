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
//
// Configured-but-missing channels exit non-zero so this command can be used
// in CI / health checks. Everything else is informational.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { type EthosConfig, ethosDir, readConfig } from '../config';
import { errorLogExists, errorLogPath, readRecentErrors } from '../error-log';
import { getStorage } from '../wiring';

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

export async function runDoctor(args: string[] = []): Promise<void> {
  // Phase 30.10 — `ethos doctor --recent-errors` prints a grouped summary of
  // the last 50 errors from ~/.ethos/logs/errors.jsonl. Skips the SDK checks.
  if (args.includes('--recent-errors')) {
    runRecentErrorsReport();
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
  const config = await readConfig(storage);
  const cfgPath = join(ethosDir(), 'config.yaml');
  if (!config) {
    console.log(`  ${c.yellow}⚠${c.reset}  No config at ${c.dim}${cfgPath}${c.reset}`);
    console.log(
      `      ${c.dim}Run ${c.reset}${c.cyan}ethos setup${c.reset}${c.dim} to create one.${c.reset}`,
    );
  } else {
    console.log(`  ${c.green}✓${c.reset}  ${cfgPath}`);
    console.log(`     provider:    ${config.provider ?? '(not set)'}`);
    console.log(`     model:       ${config.model ?? '(not set)'}`);
    console.log(`     personality: ${config.personality ?? '(default)'}`);
  }
  console.log('');

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
  // Verdict
  // -------------------------------------------------------------------------

  const coreFailures = coreResults.filter((r) => !r.ok);
  const configuredButMissing = channelResults.filter((r) => !r.ok && r.inUse);

  if (coreFailures.length > 0) {
    console.log(
      `${c.red}✗ Core SDK missing — ethos cannot run.${c.reset} Reinstall: ${c.cyan}npm install -g @ethosagent/cli${c.reset}`,
    );
    process.exit(1);
  }
  if (configuredButMissing.length > 0) {
    const list = configuredButMissing.map((r) => r.row.label).join(', ');
    console.log(`${c.red}✗ Configured channels with missing SDKs: ${list}${c.reset}`);
    console.log(
      `${c.dim}  Install the listed packages globally, or remove the channel from ~/.ethos/config.yaml.${c.reset}`,
    );
    process.exit(1);
  }
  console.log(`${c.green}✓ Healthy.${c.reset}`);
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
