import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type EthosConfig, ethosDir, readRawConfig, writeConfig } from '@ethosagent/config';
import {
  createPersonalityRegistry,
  PersonalityA2aIdentityProvider,
} from '@ethosagent/personalities';
import type { AgentCard, Storage } from '@ethosagent/types';
import {
  type A2aIdentityView,
  A2aPeeringError,
  type A2aPeerRow,
  buildA2aPeeringService,
} from '@ethosagent/wiring';
import { getSecretsResolver, getStorage } from '../wiring';
import { a2aZeroSkillsWarning } from './serve-helpers';

// `ethos a2a <subcommand>` — Stage 2 of A2A peering (plan §5).
//
// Two command groups kept deliberately separate so the FEATURE toggle
// (`a2a enable`) never collides with PEER management (`a2a peer enable <fp>`):
//   feature: enable | disable | status
//   peers:   identity | peer add|list|enable|disable|remove
//
// The trust rules (verify-first, saved-disabled, full-access) live in the shared
// A2aPeeringService — this command is a thin surface over it. All state writes go
// through the injected deps so the handlers are testable without real personalities.

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
};

const G = `${c.green}✓${c.reset}`;
const W = `${c.yellow}!${c.reset}`;
const R = `${c.red}✗${c.reset}`;

/**
 * The public face of {@link A2aPeeringService} the CLI needs. A structural
 * interface (not the class) so tests can pass a lightweight stub.
 */
export interface A2aPeeringPort {
  identity(personalityId: string): Promise<A2aIdentityView>;
  previewPeer(url: string): Promise<{ card: AgentCard; fingerprint: string }>;
  addPeer(
    personalityId: string,
    args: { url: string; expectedFingerprint?: string; label?: string },
  ): Promise<A2aPeerRow>;
  listPeers(personalityId: string): Promise<A2aPeerRow[]>;
  setEnabled(personalityId: string, fingerprint: string, enabled: boolean): Promise<void>;
  removePeer(personalityId: string, fingerprint: string): Promise<void>;
}

/** Injected dependencies — the seam that makes the handlers unit-testable. */
export interface A2aCommandDeps {
  peering: A2aPeeringPort;
  loadConfig: () => Promise<EthosConfig | null>;
  saveConfig: (config: EthosConfig) => Promise<void>;
  /** Interactive y/N confirm (for `peer remove` / `reset` without `--yes`). */
  confirm: (prompt: string) => Promise<boolean>;
  /**
   * Wipe `~/.ethos/a2a/`'s contents (T1.6 follow-up) — the task store, peer
   * store, allowlist, and any A2A keys for every personality. Returns the
   * names of the top-level entries removed (empty if the directory was
   * already empty or absent).
   */
  resetA2aDir: () => Promise<string[]>;
  /** Clock for relative "last seen" rendering; defaults to Date.now. */
  now?: () => number;
}

interface ParsedFlags {
  personality?: string;
  url?: string;
  fingerprint?: string;
  label?: string;
  json: boolean;
  yes: boolean;
  positional: string[];
}

function parseFlags(args: string[]): ParsedFlags {
  const flags: ParsedFlags = { json: false, yes: false, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--json') flags.json = true;
    else if (a === '--yes' || a === '-y') flags.yes = true;
    else if (a === '--personality') flags.personality = args[++i];
    else if (a === '--url') flags.url = args[++i];
    else if (a === '--fingerprint') flags.fingerprint = args[++i];
    else if (a === '--label') flags.label = args[++i];
    else if (a !== undefined) flags.positional.push(a);
  }
  return flags;
}

const USAGE = `Usage: ethos a2a <command>

  enable                                     turn the A2A surface on (config a2a.enabled)
  disable                                    turn the A2A surface off
  status [--personality <id>]                show enabled state, webBaseUrl, peer count

  identity [--personality <id>] [--json]     print this personality's shareable identity
  peer add --url <url> --fingerprint <fp> [--personality <id>] [--label <name>]
  peer list [--personality <id>] [--json]    list configured peers
  peer enable <fp> [--personality <id>]      activate a peer
  peer disable <fp> [--personality <id>]     revoke a peer
  peer remove <fp> [--personality <id>] [--yes]   delete a peer grant

  reset [--yes]   PERMANENTLY delete ~/.ethos/a2a/ (task store, peer store, allowlist, keys)`;

// ---------------------------------------------------------------------------
// Entry point — builds real deps, then delegates to the testable core.
// ---------------------------------------------------------------------------

export async function runA2a(args: string[]): Promise<void> {
  const deps = await buildRealDeps();
  await runA2aCommand(args, deps);
}

async function buildRealDeps(): Promise<A2aCommandDeps> {
  const storage = getStorage();
  const config = await readRawConfig(storage);
  if (!config) {
    console.error(`${R} no ~/.ethos/config.yaml — run ${c.bold}ethos setup${c.reset} first`);
    process.exit(1);
  }
  const dir = ethosDir();
  const secrets = await getSecretsResolver();
  const personalities = await createPersonalityRegistry({ storage, userPersonalitiesDir: dir });
  await personalities.loadFromDirectory(join(dir, 'personalities'));
  const identity = new PersonalityA2aIdentityProvider({
    personalities,
    secrets,
    storage,
    ...(config.webBaseUrl ? { baseUrl: config.webBaseUrl } : {}),
  });
  const a2aDir = join(dir, 'a2a');
  const peering = buildA2aPeeringService({ storage, baseDir: a2aDir, identity });
  return {
    peering,
    loadConfig: () => readRawConfig(storage),
    saveConfig: (cfg) => writeConfig(storage, cfg, secrets),
    confirm,
    resetA2aDir: () => resetDirContents(storage, a2aDir),
  };
}

/**
 * Remove every top-level entry under `dir`, returning their names. Exported
 * for direct testing against `InMemoryStorage` — the command-level tests stub
 * the whole `resetA2aDir` seam, so this is what actually exercises the
 * filesystem-clearing behaviour.
 */
export async function resetDirContents(storage: Storage, dir: string): Promise<string[]> {
  const names = await storage.list(dir);
  for (const name of names) {
    await storage.remove(join(dir, name), { recursive: true });
  }
  return names;
}

// ---------------------------------------------------------------------------
// Testable core.
// ---------------------------------------------------------------------------

export async function runA2aCommand(args: string[], deps: A2aCommandDeps): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'enable':
      return a2aEnable(deps);
    case 'disable':
      return a2aDisable(deps);
    case 'status':
      return a2aStatus(args.slice(1), deps);
    case 'identity':
      return a2aIdentity(args.slice(1), deps);
    case 'peer':
      return a2aPeer(args.slice(1), deps);
    case 'reset':
      return a2aReset(args.slice(1), deps);
    default:
      console.log(USAGE);
  }
}

async function requireConfig(deps: A2aCommandDeps): Promise<EthosConfig> {
  const config = await deps.loadConfig();
  if (!config) {
    console.error(`${R} no ~/.ethos/config.yaml — run ${c.bold}ethos setup${c.reset} first`);
    process.exit(1);
  }
  return config;
}

// -- feature toggle ---------------------------------------------------------

async function a2aEnable(deps: A2aCommandDeps): Promise<void> {
  const config = await requireConfig(deps);
  await deps.saveConfig({ ...config, a2a: { enabled: true } });
  if (!config.webBaseUrl) {
    console.log(
      `${W} ${c.bold}webBaseUrl${c.reset} not set — cards will advertise the default port (:8787).` +
        ` Set it with ${c.bold}ethos config set webBaseUrl <url>${c.reset} so peers reach the right host.`,
    );
  }
  console.log(
    `${G} A2A enabled. (Live in the web UI immediately; a running ${c.bold}ethos serve${c.reset}/${c.bold}gateway${c.reset} picks it up on next start.)`,
  );
}

async function a2aDisable(deps: A2aCommandDeps): Promise<void> {
  const config = await requireConfig(deps);
  await deps.saveConfig({ ...config, a2a: { enabled: false } });
  console.log(`${G} A2A disabled. Endpoints 404 and ${c.bold}a2a_send${c.reset} is unavailable.`);
}

async function a2aStatus(args: string[], deps: A2aCommandDeps): Promise<void> {
  const flags = parseFlags(args);
  const config = await requireConfig(deps);
  const enabled = config.a2a?.enabled === true || process.env.ETHOS_A2A_ENABLED === '1';
  const pid = flags.personality ?? config.personality;

  console.log(
    enabled
      ? `${G} ${c.bold}a2a${c.reset}           ${c.green}enabled${c.reset}`
      : `${c.dim}- a2a           disabled${c.reset}`,
  );
  if (config.webBaseUrl) {
    console.log(`${G} ${c.bold}webBaseUrl${c.reset}    ${c.cyan}${config.webBaseUrl}${c.reset}`);
  } else {
    console.log(
      `${W} ${c.bold}webBaseUrl${c.reset}    not set — cards advertise default port (:8787)`,
    );
  }
  const peers = await deps.peering.listPeers(pid);
  console.log(
    `${G} ${c.bold}peers${c.reset}         ${peers.length} configured for ${c.cyan}${pid}${c.reset}`,
  );

  // T0.1 — the zero-skills warning (the headline bug). Best-effort: an
  // unknown/unreachable personality here must not turn `status` into an error.
  if (enabled) {
    try {
      const view = await deps.peering.identity(pid);
      const warning = a2aZeroSkillsWarning(pid, view.exposedSkills.length);
      if (warning) console.log(`${W} ${warning}`);
    } catch {
      // best-effort; `identity` surfaces its own errors elsewhere (ethos a2a identity)
    }
  }
}

// -- identity ---------------------------------------------------------------

async function a2aIdentity(args: string[], deps: A2aCommandDeps): Promise<void> {
  const flags = parseFlags(args);
  const config = await requireConfig(deps);
  const pid = flags.personality ?? config.personality;

  let view: A2aIdentityView;
  try {
    view = await deps.peering.identity(pid);
  } catch (err) {
    if (err instanceof A2aPeeringError && err.code === 'unknown_personality') {
      console.error(`${R} unknown personality: ${c.bold}${pid}${c.reset}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (flags.json) {
    console.log(JSON.stringify(view, null, 2));
    return;
  }

  console.log(
    `${c.bold}personality${c.reset}    ${view.name} ${c.dim}(${view.personalityId})${c.reset}`,
  );
  console.log(`${c.bold}fingerprint${c.reset}    ${c.cyan}${view.fingerprint}${c.reset}`);
  console.log(`${c.bold}well-known${c.reset}     ${view.wellKnownUrl}`);
  console.log(`${c.bold}json-rpc${c.reset}       ${view.jsonRpcUrl}`);
  console.log(`${c.bold}auth${c.reset}           ${view.authUrl}`);
  if (view.did) console.log(`${c.bold}did${c.reset}            ${view.did}`);
  console.log(
    `${c.bold}exposed skills${c.reset} ${view.exposedSkills.length > 0 ? view.exposedSkills.join(', ') : `${c.dim}none${c.reset}`}`,
  );
  if (!config.webBaseUrl) {
    console.log(`${W} webBaseUrl not set — the URLs above advertise the default port (:8787).`);
  }
}

// -- peer management --------------------------------------------------------

async function a2aPeer(args: string[], deps: A2aCommandDeps): Promise<void> {
  const sub = args[0];
  switch (sub) {
    case 'add':
      return peerAdd(args.slice(1), deps);
    case 'list':
      return peerList(args.slice(1), deps);
    case 'enable':
      return peerSetEnabled(args.slice(1), deps, true);
    case 'disable':
      return peerSetEnabled(args.slice(1), deps, false);
    case 'remove':
      return peerRemove(args.slice(1), deps);
    default:
      console.log(USAGE);
  }
}

async function peerAdd(args: string[], deps: A2aCommandDeps): Promise<void> {
  const flags = parseFlags(args);
  const config = await requireConfig(deps);
  const pid = flags.personality ?? config.personality;
  const url = flags.url;
  if (!url) {
    console.error(
      `${R} --url is required: ethos a2a peer add --url <wellKnownUrl> --fingerprint <fp>`,
    );
    process.exitCode = 1;
    return;
  }

  // No --fingerprint → PREVIEW only. Never write without a human-anchored
  // fingerprint: fetching + verifying a card proves nothing about WHOSE key it
  // is. Show the fetched fp so the user can confirm it out-of-band, then re-run.
  if (!flags.fingerprint) {
    try {
      const { card, fingerprint } = await deps.peering.previewPeer(url);
      console.log(`${c.bold}peer${c.reset}         ${card.name}`);
      console.log(`${c.bold}fingerprint${c.reset}  ${c.cyan}${fingerprint}${c.reset}`);
      console.log(
        `\nConfirm this fingerprint out-of-band, then re-run to add the peer:\n` +
          `  ${c.bold}ethos a2a peer add --url ${url} --fingerprint ${fingerprint}${c.reset}`,
      );
    } catch (err) {
      reportPeeringError(err);
    }
    return;
  }

  try {
    const row = await deps.peering.addPeer(pid, {
      url,
      expectedFingerprint: flags.fingerprint,
      ...(flags.label !== undefined ? { label: flags.label } : {}),
    });
    const name = row.label ?? row.cardName ?? row.fingerprint;
    console.log(
      `${G} ${c.bold}${name}${c.reset} added (disabled, full access) — run ${c.bold}ethos a2a peer enable ${row.fingerprint}${c.reset} to activate.`,
    );
  } catch (err) {
    if (err instanceof A2aPeeringError && err.code === 'fingerprint_mismatch') {
      console.error(`${R} fingerprint mismatch — ${err.message}`);
      console.error(
        `${c.dim}The fetched fingerprint does not match --fingerprint ${flags.fingerprint}; nothing was written.${c.reset}`,
      );
      process.exitCode = 1;
      return;
    }
    reportPeeringError(err);
  }
}

async function peerList(args: string[], deps: A2aCommandDeps): Promise<void> {
  const flags = parseFlags(args);
  const config = await requireConfig(deps);
  const pid = flags.personality ?? config.personality;
  const rows = await deps.peering.listPeers(pid);

  if (flags.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }
  if (rows.length === 0) {
    console.log('no peers configured.');
    return;
  }

  const nowFn = deps.now ?? Date.now;
  const now = nowFn();
  const header = [
    pad('NAME', 20),
    pad('FINGERPRINT', 14),
    pad('URL', 30),
    pad('ACCESS', 7),
    pad('STATE', 10),
    'LAST SEEN',
  ].join(' ');
  console.log(`${c.dim}${header}${c.reset}`);
  for (const row of rows) {
    const name = row.label ?? row.cardName ?? '—';
    const fp = row.fingerprint.length > 12 ? `${row.fingerprint.slice(0, 12)}…` : row.fingerprint;
    const state = row.enabled ? `${c.green}●${c.reset} enabled` : `${c.dim}○ disabled${c.reset}`;
    console.log(
      [
        pad(name, 20),
        pad(fp, 14),
        pad(row.url ?? '—', 30),
        pad(row.access, 7),
        padVisible(state, 10, row.enabled ? '● enabled'.length : '○ disabled'.length),
        relativeTime(row.lastSeenAt, now),
      ].join(' '),
    );
  }
}

async function peerSetEnabled(
  args: string[],
  deps: A2aCommandDeps,
  enabled: boolean,
): Promise<void> {
  const flags = parseFlags(args);
  const config = await requireConfig(deps);
  const pid = flags.personality ?? config.personality;
  const fp = flags.positional[0];
  if (!fp) {
    console.error(`${R} usage: ethos a2a peer ${enabled ? 'enable' : 'disable'} <fingerprint>`);
    process.exitCode = 1;
    return;
  }
  await deps.peering.setEnabled(pid, fp, enabled);
  console.log(
    enabled
      ? `${G} peer ${c.cyan}${fp}${c.reset} ${c.green}enabled${c.reset}.`
      : `${G} peer ${c.cyan}${fp}${c.reset} disabled (revoked).`,
  );
}

async function peerRemove(args: string[], deps: A2aCommandDeps): Promise<void> {
  const flags = parseFlags(args);
  const config = await requireConfig(deps);
  const pid = flags.personality ?? config.personality;
  const fp = flags.positional[0];
  if (!fp) {
    console.error(`${R} usage: ethos a2a peer remove <fingerprint>`);
    process.exitCode = 1;
    return;
  }
  if (!flags.yes) {
    const ok = await deps.confirm(`Remove peer ${fp} for ${pid}? [y/N] `);
    if (!ok) {
      console.log('aborted.');
      return;
    }
  }
  await deps.peering.removePeer(pid, fp);
  console.log(`${G} peer ${c.cyan}${fp}${c.reset} removed.`);
}

// -- reset (T1.6 follow-up) --------------------------------------------------

/**
 * Wipe `~/.ethos/a2a/` — the task store, every personality's peer store and
 * allowlist, and any A2A signing keys. No prior migration policy exists for
 * that directory (T1.6), so this is a full, explicit reset: run `ethos a2a
 * disable` first if `ethos serve`/`gateway` is live, since a running process
 * can still hold the task store open.
 */
async function a2aReset(args: string[], deps: A2aCommandDeps): Promise<void> {
  const flags = parseFlags(args);
  if (!flags.yes) {
    const ok = await deps.confirm(
      `${c.red}This permanently deletes ~/.ethos/a2a/${c.reset} — the task store, every ` +
        `personality's peer store, allowlist, and A2A signing keys. Continue? [y/N] `,
    );
    if (!ok) {
      console.log('aborted.');
      return;
    }
  }
  const removed = await deps.resetA2aDir();
  if (removed.length === 0) {
    console.log(`${G} nothing to reset — ~/.ethos/a2a/ is already empty or absent.`);
    return;
  }
  console.log(`${G} reset ~/.ethos/a2a/ — removed: ${removed.join(', ')}`);
}

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

function reportPeeringError(err: unknown): void {
  if (err instanceof A2aPeeringError) {
    console.error(`${R} ${err.message}`);
    process.exitCode = 1;
    return;
  }
  throw err;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + ' '.repeat(width - s.length);
}

/** Pad a string that contains ANSI escapes, using its VISIBLE length. */
function padVisible(s: string, width: number, visibleLen: number): string {
  return visibleLen >= width ? s : s + ' '.repeat(width - visibleLen);
}

function relativeTime(ms: number | undefined, now: number): string {
  if (ms === undefined) return 'never';
  const diff = now - ms;
  if (diff < 0) return 'just now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === 'y' || a === 'yes');
    });
  });
}
