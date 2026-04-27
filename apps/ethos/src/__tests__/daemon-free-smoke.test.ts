// 30.5 — daemon-free path stays first-class.
//
// Doctrine: no top-level feature requires the gateway to run. Cron, skills,
// memory, evals, delegation must work CLI-first. This smoke-test enforces
// that by walking the CLI source tree and asserting that `@ethosagent/gateway`
// is imported by exactly one file: the gateway command itself.
//
// If a future contributor wires the gateway into chat / cron / skills /
// delegate / wiring, this test fails and forces an architectural conversation
// before the regression lands.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const CLI_ROOT = join(import.meta.dirname, '..');
const REPO_ROOT = join(CLI_ROOT, '..', '..', '..');

const GATEWAY_IMPORT = /from\s+['"]@ethosagent\/gateway['"]/;

const ALLOWED_FILES = new Set([
  // The gateway command itself is the one and only place that imports the
  // gateway package. `apps/ethos/src/index.ts` imports the runner _function_
  // (`runGatewaySetup`/`runGatewayStart`) from the local command file, not
  // from `@ethosagent/gateway` — so it's not in this list.
  'commands/gateway.ts',
]);

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === '__tests__' || entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    const stats = statSync(full);
    if (stats.isDirectory()) {
      out.push(...walkTs(full));
    } else if (extname(entry) === '.ts') {
      out.push(full);
    }
  }
  return out;
}

describe('30.5: daemon-free path stays first-class', () => {
  it('only `commands/gateway.ts` imports `@ethosagent/gateway`', () => {
    const offenders: string[] = [];
    for (const file of walkTs(CLI_ROOT)) {
      const rel = relative(CLI_ROOT, file).replace(/\\/g, '/');
      if (ALLOWED_FILES.has(rel)) continue;
      const src = readFileSync(file, 'utf-8');
      if (GATEWAY_IMPORT.test(src)) offenders.push(rel);
    }
    expect(
      offenders,
      `Daemon-free doctrine: only commands/gateway.ts may import @ethosagent/gateway. ` +
        `Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('chat / cron / skills / delegation tools do not depend on the gateway', () => {
    // The four flows from the spec: chat, cron-create, skill-inject, delegate.
    // None of their entry-point packages may import `@ethosagent/gateway`.
    const targets = [
      join(CLI_ROOT, 'commands', 'chat.ts'),
      join(CLI_ROOT, 'commands', 'cron.ts'),
      join(CLI_ROOT, 'commands', 'skills.ts'),
      join(CLI_ROOT, 'wiring.ts'),
      join(REPO_ROOT, 'extensions', 'tools-delegation', 'src', 'index.ts'),
      join(REPO_ROOT, 'extensions', 'cron', 'src', 'index.ts'),
      join(REPO_ROOT, 'extensions', 'skills', 'src', 'index.ts'),
    ];
    const offenders: string[] = [];
    for (const file of targets) {
      const src = readFileSync(file, 'utf-8');
      if (GATEWAY_IMPORT.test(src)) offenders.push(relative(REPO_ROOT, file));
    }
    expect(
      offenders,
      `Top-level features must not require the gateway. Offenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('`ethos gateway start` prints the foreground / always-on notice', () => {
    const src = readFileSync(join(CLI_ROOT, 'commands', 'gateway.ts'), 'utf-8');
    expect(src).toMatch(/foreground/i);
    expect(src).toMatch(/run-as-daemon/);
  });
});
