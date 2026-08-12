// `ethos security audit` — Ch.6c posture-drift diagnostic.
//
// Distinct from `ethos audit` (which is a query over observability events).
// This command probes the live config for the safety-framework-relevant
// posture and prints actionable findings, mirroring `ethos doctor`'s
// shape: ✓ pass, ⚠ warn, ✗ fail. Non-zero exit on any ✗.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { ethosDir, readRawConfig } from '@ethosagent/config';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import type { PersonalityConfig } from '@ethosagent/types';
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

type Severity = 'ok' | 'warn' | 'fail';

export interface Finding {
  severity: Severity;
  section: string;
  message: string;
  fixable?: boolean;
  fix?: () => Promise<void>;
}

const CHANNEL_INGRESS_PLATFORMS = new Set(['telegram', 'discord', 'slack', 'whatsapp', 'email']);

// Built-in always-deny floor that every personality should have visible
// coverage for. Personality config lists are not inspected here — we
// already enforce the floor at runtime; this surface tells the user
// which personalities effectively run with which fs_reach scopes.
const ALWAYS_DENY_FLOOR = ['~/.ssh', '/etc/passwd', '/etc/shadow', '~/.aws/credentials'];

async function check0600(path: string): Promise<Severity> {
  try {
    const s = await stat(path);
    const mode = s.mode & 0o777;
    return mode === 0o600 ? 'ok' : 'warn';
  } catch {
    return 'ok'; // missing file = nothing to lock down
  }
}

export async function check0700(path: string): Promise<Severity> {
  try {
    const s = await stat(path);
    const mode = s.mode & 0o777;
    return mode === 0o700 ? 'ok' : 'warn';
  } catch {
    return 'ok'; // missing directory = nothing to lock down
  }
}

/**
 * Directories holding WhatsApp device credentials and pre-keys. Baileys
 * writes those files itself, so the directory mode is the only lever — the
 * adapter creates each one 0o700 (extensions/platform-whatsapp/src/session-store.ts).
 * The default location is always checked so an operator who removed the
 * config still sees a stale world-readable directory.
 */
export function whatsAppSessionDirs(
  whatsapp: ReadonlyArray<{ session_dir?: string }> | undefined,
  ethosHome: string,
): string[] {
  const dirs = [join(ethosHome, 'whatsapp')];
  for (const wa of whatsapp ?? []) {
    if (wa.session_dir) dirs.push(wa.session_dir);
  }
  return [...new Set(dirs)];
}

interface RunOptions {
  fix: boolean;
  json: boolean;
  deep: boolean;
}

function parseFlags(argv: string[]): RunOptions {
  return {
    fix: argv.includes('--fix'),
    json: argv.includes('--json'),
    deep: argv.includes('--deep'),
  };
}

export async function runSecurityAudit(argv: string[]): Promise<void> {
  if (argv[0] !== 'audit' && argv[0] !== undefined) {
    console.error(`Usage: ethos security audit [--fix] [--json] [--deep]`);
    process.exit(2);
  }
  const opts = parseFlags(argv);

  const findings: Finding[] = [];
  const dir = ethosDir();

  // ---- Channel boundaries ----
  // We don't have a live gateway here; report the personality-side state.
  let registry: import('@ethosagent/personalities').FilePersonalityRegistry;
  try {
    registry = await createPersonalityRegistry({
      storage: getStorage(),
      userPersonalitiesDir: join(dir, 'personalities'),
    });
  } catch (err) {
    findings.push({
      severity: 'fail',
      section: 'Personalities',
      message: `Personality load failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return emit(findings, opts);
  }
  const personalities = registry.list();

  for (const p of personalities) {
    const platform = p.platform;
    if (platform && CHANNEL_INGRESS_PLATFORMS.has(platform)) {
      if (p.safety?.approvalMode === 'off') {
        findings.push({
          severity: 'fail',
          section: 'Channel boundaries',
          message: `${p.id}: approvalMode: off + channel ${platform} (load-time rule should have rejected this)`,
        });
      } else {
        findings.push({
          severity: 'ok',
          section: 'Channel boundaries',
          message: `${p.id}: approvalMode=${p.safety?.approvalMode ?? 'manual'} on channel ${platform}`,
        });
      }
    }
  }

  // ---- Tool boundaries (approval mode) ----
  for (const p of personalities) {
    const mode = p.safety?.approvalMode ?? 'manual';
    findings.push({
      severity: mode === 'off' ? 'warn' : 'ok',
      section: 'Tool boundaries',
      message: `${p.id}: approvalMode=${mode}`,
    });
  }

  // ---- File hygiene ----
  const sensitiveFiles = [
    join(dir, 'config.yaml'),
    join(dir, 'keys.json'),
    join(dir, 'observability.db'),
  ];
  for (const f of sensitiveFiles) {
    const sev = await check0600(f);
    findings.push({
      severity: sev,
      section: 'File hygiene',
      message:
        sev === 'ok'
          ? `${f} is mode 0600 (or absent)`
          : `${f} mode is too permissive — should be 0600`,
      fixable: sev !== 'ok',
      fix: async () => {
        const { chmod } = await import('node:fs/promises');
        await chmod(f, 0o600);
      },
    });
  }

  const rawConfig = await readRawConfig(getStorage()).catch(() => null);
  for (const d of whatsAppSessionDirs(rawConfig?.whatsapp, dir)) {
    const sev = await check0700(d);
    findings.push({
      severity: sev,
      section: 'File hygiene',
      message:
        sev === 'ok'
          ? `${d} is mode 0700 (or absent)`
          : `${d} mode is too permissive — WhatsApp device credentials live under it, should be 0700`,
      fixable: sev !== 'ok',
      fix: async () => {
        const { chmod } = await import('node:fs/promises');
        await chmod(d, 0o700);
      },
    });
  }

  // ---- Always-deny floor advisory (informational) ----
  findings.push({
    severity: 'ok',
    section: 'FS always-deny floor',
    message: `built-in always-deny prefixes apply to every personality: ${ALWAYS_DENY_FLOOR.join(', ')}, …`,
  });

  // ---- Watcher / Network policy advisories ----
  for (const p of personalities) {
    const net = p.safety?.network;
    if (net?.allow_private_urls === true) {
      findings.push({
        severity: 'warn',
        section: 'Network policy',
        message: `${p.id}: allow_private_urls=true (cloud-metadata still blocked, but RFC1918 is reachable)`,
      });
    }
  }

  // ---- Apply fixes ----
  if (opts.fix) {
    for (const f of findings) {
      if (f.fixable && f.fix) {
        try {
          await f.fix();
          f.severity = 'ok';
          f.message = `${f.message} — FIXED`;
        } catch (err) {
          f.message = `${f.message} — FIX FAILED: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }
  }

  emit(findings, opts);
}

function severityIcon(s: Severity): string {
  if (s === 'ok') return `${c.green}✓${c.reset}`;
  if (s === 'warn') return `${c.yellow}⚠${c.reset}`;
  return `${c.red}✗${c.reset}`;
}

function emit(findings: Finding[], opts: RunOptions): void {
  if (opts.json) {
    process.stdout.write(JSON.stringify({ findings }, null, 2));
    process.stdout.write('\n');
  } else {
    let lastSection = '';
    for (const f of findings) {
      if (f.section !== lastSection) {
        process.stdout.write(`\n${c.bold}─ ${f.section} ${'─'.repeat(40)}${c.reset}\n`);
        lastSection = f.section;
      }
      process.stdout.write(`  ${severityIcon(f.severity)} ${f.message}\n`);
    }
    const fails = findings.filter((f) => f.severity === 'fail').length;
    const warns = findings.filter((f) => f.severity === 'warn').length;
    process.stdout.write(`\n${fails} fail, ${warns} warn, ${findings.length - fails - warns} ok\n`);
    if (!opts.fix) {
      const fixable = findings.filter((f) => f.fixable).length;
      if (fixable > 0) {
        process.stdout.write(
          `Run ${c.cyan}ethos security audit --fix${c.reset} to auto-repair ${fixable}.\n`,
        );
      }
    }
  }

  const fails = findings.filter((f) => f.severity === 'fail').length;
  if (fails > 0) process.exit(1);
}

// Helper for tests — synthesize findings in-process without exiting.
export async function runSecurityAuditAndCollect(
  personalities: PersonalityConfig[],
): Promise<{ findings: Finding[] }> {
  const findings: Finding[] = [];
  for (const p of personalities) {
    const platform = p.platform;
    if (platform && CHANNEL_INGRESS_PLATFORMS.has(platform)) {
      if (p.safety?.approvalMode === 'off') {
        findings.push({
          severity: 'fail',
          section: 'Channel boundaries',
          message: `${p.id}: approvalMode: off + channel ${platform}`,
        });
      } else {
        findings.push({
          severity: 'ok',
          section: 'Channel boundaries',
          message: `${p.id}: approvalMode=${p.safety?.approvalMode ?? 'manual'} on channel ${platform}`,
        });
      }
    }
    const mode = p.safety?.approvalMode ?? 'manual';
    findings.push({
      severity: mode === 'off' ? 'warn' : 'ok',
      section: 'Tool boundaries',
      message: `${p.id}: approvalMode=${mode}`,
    });
    if (p.safety?.network?.allow_private_urls === true) {
      findings.push({
        severity: 'warn',
        section: 'Network policy',
        message: `${p.id}: allow_private_urls=true`,
      });
    }
  }
  return { findings };
}
