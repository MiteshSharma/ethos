// `ethos upgrade` — fetch the latest published version, compare with what's
// running, and run `npm install -g` to upgrade. Detects source-mode (running
// via tsx from a git clone) and prints the right git/pnpm instructions instead.
//
// Per Phase 29.5.

import { spawn } from 'node:child_process';
import { EthosError } from '@ethosagent/types';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

const PACKAGE = '@ethosagent/cli';

declare const __ETHOS_VERSION__: string;
const CURRENT_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

export async function runUpgrade(): Promise<void> {
  const installMethod = detectInstallMethod();

  // Source-mode users update via git, not npm — no need to hit the registry.
  // (Also avoids confusing "registry 404" errors when running from a private
  // fork or before the cli has been published.)
  if (installMethod === 'source') {
    console.log(`\n  ${c.dim}Current:${c.reset} ${c.bold}${CURRENT_VERSION}${c.reset}\n`);
    printSourceInstructions();
    return;
  }

  // npm install — check the registry to show before/after, then install.
  console.log(`${c.dim}Checking npm registry...${c.reset}`);
  let latest: string;
  try {
    latest = await fetchLatestVersion();
  } catch (err) {
    console.error(`${c.red}✗${c.reset} Couldn't reach the npm registry: ${errMsg(err)}`);
    console.error(
      `${c.dim}  Check your network and try again, or install manually: npm install -g ${PACKAGE}@latest${c.reset}`,
    );
    process.exit(1);
  }

  console.log(`\n  ${c.dim}Current:${c.reset} ${c.bold}${CURRENT_VERSION}${c.reset}`);
  console.log(`  ${c.dim}Latest: ${c.reset} ${c.bold}${latest}${c.reset}\n`);

  if (CURRENT_VERSION === latest) {
    console.log(`${c.green}✓${c.reset} Already on the latest version.`);
    return;
  }

  console.log(
    `${c.dim}Running ${c.reset}${c.cyan}npm install -g ${PACKAGE}@latest${c.reset}${c.dim}...${c.reset}\n`,
  );
  const exitCode = await runNpmInstall();
  if (exitCode !== 0) {
    console.error(`\n${c.red}✗${c.reset} npm install failed (exit code ${exitCode}).`);
    process.exit(exitCode);
  }
  console.log(`\n${c.green}✓${c.reset} Upgraded to ${c.bold}${PACKAGE}@${latest}${c.reset}.`);
  console.log(
    `${c.dim}  Run ${c.reset}${c.cyan}ethos --version${c.reset}${c.dim} in a fresh terminal to confirm.${c.reset}`,
  );
}

// ---------------------------------------------------------------------------
// Install method detection
// ---------------------------------------------------------------------------

type InstallMethod = 'npm' | 'source';

/**
 * Inspect `process.argv[1]` to figure out whether the cli was launched from a
 * global npm install (path contains `/node_modules/@ethosagent/cli/`) or from
 * a source-tree dev run (everything else — typically `tsx apps/ethos/src/index.ts`
 * or a local worktree build).
 */
function detectInstallMethod(): InstallMethod {
  const path = process.argv[1] ?? '';
  // npm-global installs always land under .../node_modules/@ethosagent/cli/...
  // (matches macOS /usr/local, nvm $NVM_DIR/versions/node/.../, $HOME/.npm-global,
  // and Linux distro-managed prefixes alike).
  if (path.includes('/node_modules/@ethosagent/cli/')) return 'npm';
  return 'source';
}

function printSourceInstructions(): void {
  console.log(
    `${c.yellow}⚠${c.reset} This binary is running from source ${c.dim}(${process.argv[1] ?? 'unknown path'})${c.reset}.`,
  );
  console.log('');
  console.log(`${c.bold}To upgrade your source checkout:${c.reset}`);
  console.log(`  ${c.cyan}git pull${c.reset}`);
  console.log(`  ${c.cyan}pnpm install${c.reset}`);
  console.log(`  ${c.cyan}pnpm build${c.reset}`);
  console.log('');
  console.log(`${c.bold}Or install the published cli globally:${c.reset}`);
  console.log(`  ${c.cyan}npm install -g ${PACKAGE}@latest${c.reset}`);
  console.log('');
}

// ---------------------------------------------------------------------------
// npm registry + install
// ---------------------------------------------------------------------------

interface RegistryResponse {
  version?: string;
  [key: string]: unknown;
}

async function fetchLatestVersion(): Promise<string> {
  // Hit the registry's <pkg>/latest endpoint — returns the dist-tagged latest
  // without pulling the full package metadata blob.
  const url = `https://registry.npmjs.org/${PACKAGE}/latest`;
  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
    // Don't sit on a slow registry forever. 10s is generous.
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new EthosError({
      code: 'REGISTRY_FETCH_FAILED',
      cause: `registry returned ${res.status} ${res.statusText}`,
      action: `Check your network and try again, or install manually: npm install -g ${PACKAGE}@latest`,
    });
  }
  const body = (await res.json()) as RegistryResponse;
  if (!body.version || typeof body.version !== 'string') {
    throw new EthosError({
      code: 'REGISTRY_FETCH_FAILED',
      cause: "registry response missing 'version' field",
      action: `Try again later, or install manually: npm install -g ${PACKAGE}@latest`,
    });
  }
  return body.version;
}

function runNpmInstall(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn('npm', ['install', '-g', `${PACKAGE}@latest`], {
      stdio: 'inherit',
    });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
