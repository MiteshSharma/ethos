import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ethosDir } from '@ethosagent/config';
import {
  computeIntegrity,
  derivePluginId,
  grantsPath,
  type PluginGrant,
  type PluginLockEntry,
  readGrants,
  readLockfile,
  recordGrant,
  revokeGrant,
  writeLockfile,
} from '@ethosagent/plugin-loader';
import type { Storage } from '@ethosagent/types';
import { EthosError } from '@ethosagent/types';
import {
  canInstall,
  type PluginScanPermissions,
  type ScanFinding,
  scanPluginCode,
} from '@ethosagent/wiring/security-kernel';
import { writeJson } from '../json-output';
import { getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

function pluginsDir(): string {
  return join(homedir(), '.ethos', 'plugins');
}

export async function runPlugin(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'install': {
      const yesFlag = args.includes('--yes');
      const rest = args.filter((a) => a !== '--yes');
      const pkg = rest[1];
      if (!pkg) {
        console.log('Usage: ethos plugin install <package> [--personality <id>] [--yes]');
        console.log('  --yes  record the capability grant without an interactive prompt');
        process.exit(1);
      }
      const pFlagIdx = rest.indexOf('--personality');
      const personalityId = pFlagIdx >= 0 ? rest[pFlagIdx + 1] : undefined;
      if (pFlagIdx >= 0 && !personalityId) {
        console.log('Usage: ethos plugin install <package> [--personality <id>] [--yes]');
        process.exit(1);
      }
      try {
        await installPlugin(pkg, personalityId, yesFlag);
      } catch (err) {
        if (err instanceof EthosError) {
          console.error(`${c.red}${err.cause}${c.reset}\n${c.dim}→ ${err.action}${c.reset}`);
        } else {
          console.error(
            `${c.red}Install failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
          );
        }
        process.exit(1);
      }
      break;
    }

    case 'remove': {
      const pkg = args[1];
      if (!pkg) {
        console.log('Usage: ethos plugin remove <package>');
        process.exit(1);
      }
      const dir = pluginsDir();
      const result = spawnSync('npm', ['uninstall', '--prefix', dir, pkg], { stdio: 'inherit' });
      if (result.status !== 0) {
        console.error(`${c.red}Remove failed.${c.reset}`);
        process.exit(result.status ?? 1);
      }
      // Removing the package does not withdraw consent: the grant still stands,
      // so a personality lockfile can auto-install it again. Say so.
      console.log(`\n${c.green}✓ Removed.${c.reset}`);
      console.log(
        `${c.dim}The capability grant stands. Withdraw it with: ${c.reset}ethos plugin revoke <pluginId>`,
      );
      break;
    }

    case 'list': {
      await listPlugins(args);
      break;
    }

    case 'credentials': {
      await runCredentials(args.slice(1));
      break;
    }

    case 'grants': {
      await listGrants(args.includes('--json'));
      break;
    }

    case 'revoke': {
      const pluginId = args[1];
      if (!pluginId) {
        console.log('Usage: ethos plugin revoke <pluginId>');
        process.exit(1);
      }
      await revokePluginGrant(pluginId);
      break;
    }

    default:
      console.log(
        'Usage: ethos plugin [install <pkg> | remove <pkg> | list | grants | revoke <pluginId> | credentials <pluginId>]',
      );
  }
}

// ---------------------------------------------------------------------------
// Install: download to temp, scan, prompt, then commit
// ---------------------------------------------------------------------------

async function installPlugin(pkg: string, personalityId?: string, yesFlag = false): Promise<void> {
  const dir = pluginsDir();
  const tmpDir = join(dir, `.tmp-scan-${process.pid}`);

  console.log(
    `${c.dim}Downloading ${c.reset}${c.bold}${pkg}${c.reset}${c.dim} for safety scan...${c.reset}\n`,
  );

  // Step 1: download without running install scripts so we can scan first
  const pre = spawnSync(
    'npm',
    ['install', '--prefix', tmpDir, '--ignore-scripts', '--no-audit', pkg],
    { stdio: 'inherit' },
  );
  if (pre.status !== 0) {
    await rm(tmpDir, { recursive: true, force: true });
    console.error(`${c.red}Download failed.${c.reset}`);
    process.exit(pre.status ?? 1);
  }

  // Exact name@version resolved during the scan — used for the final install so we
  // commit exactly what was scanned rather than re-resolving the original spec (which
  // could yield a different version if a range, dist-tag, git ref, or mutable URL
  // changed between the scan and the install).
  let exactSpec = pkg;

  // Consent is taken AFTER the temp scan dir is cleaned up, so the grant draft
  // is carried out of the `try`. `blockedBy` is likewise reported after the
  // `finally` — `process.exit()` skips `finally`, which would leave the temp
  // scan tree behind.
  let blockedBy: string | undefined;
  let draft: Omit<PluginGrant, 'grantedAt' | 'consent'> | undefined;

  try {
    // Step 2: locate the installed package dir from the manifest npm wrote —
    // deriving the dir from the argument string fails for tarballs, git URLs,
    // local paths, and version ranges.
    const pkgDir = await findInstalledPkgDir(tmpDir, pkg);

    // Step 3: read declared permissions from package.json (ethos.permissions)
    const permissions = await readPluginPermissions(pkgDir);

    // Step 4: recursive scan
    const findings: ScanFinding[] = [];
    await walkAndScan(pkgDir, permissions, findings);
    const hasRed = findings.some((f) => f.severity === 'red');
    const hasYellow = findings.some((f) => f.severity === 'yellow');
    const scanResult = { findings, hasRed, hasYellow };

    // Step 5: read display metadata from the installed package.json
    let author = '(unsigned)';
    let networkDisplay = '(none declared)';
    let shellDisplay = '(none declared)';
    let pkgName = pkg;
    let pkgVersion = 'unknown';
    let pluginId = derivePluginId(undefined, pkg);
    try {
      const rawMeta = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf-8')) as Record<
        string,
        unknown
      >;
      const rawAuthor = rawMeta.author;
      if (typeof rawAuthor === 'string' && rawAuthor) {
        author = rawAuthor;
      } else if (typeof rawAuthor === 'object' && rawAuthor !== null) {
        const a = rawAuthor as Record<string, unknown>;
        if (typeof a.name === 'string' && a.name) author = a.name;
      }
      // Pin to the exact resolved version so the final install commits what was scanned.
      const metaName = typeof rawMeta.name === 'string' ? rawMeta.name : undefined;
      const metaVersion = typeof rawMeta.version === 'string' ? rawMeta.version : undefined;
      if (metaName) pkgName = metaName;
      if (metaVersion) pkgVersion = metaVersion;
      if (metaName && metaVersion) exactSpec = `${metaName}@${metaVersion}`;
      // Key the grant by the id the LOADER resolves, so a revocation recorded
      // here is the one the loader looks up.
      pluginId = derivePluginId(rawMeta, pkgName);
    } catch {
      // package.json already verified to exist; malformed JSON is safe to ignore here
    }
    if (permissions.network !== undefined) {
      networkDisplay =
        permissions.network.length > 0 ? permissions.network.join(' · ') : '(any host)';
    }
    if (permissions.shell === true) {
      shellDisplay = 'yes';
    }

    const labelW = 20;
    console.log(`\n${c.bold}Install metadata — ${pkg}${c.reset}`);
    console.log(`  ${'Source'.padEnd(labelW)}${c.dim}community (npm) · ${pkg}${c.reset}`);
    console.log(`  ${'Author'.padEnd(labelW)}${author}`);
    console.log(`  ${'Network access'.padEnd(labelW)}${c.dim}${networkDisplay}${c.reset}`);
    console.log(`  ${'Shell access'.padEnd(labelW)}${c.dim}${shellDisplay}${c.reset}`);

    // Step 6: show tier badge + findings
    const tier = 'community'; // npm packages are always community
    if (hasRed || hasYellow) {
      const tierColor = c.yellow;
      console.log(`\n${c.bold}Safety scan — ${pkg}${c.reset}  ${tierColor}[${tier}]${c.reset}`);
      for (const f of findings) {
        const color = f.severity === 'red' ? c.red : c.yellow;
        const loc = f.line !== undefined ? `:${f.line}` : '';
        console.log(
          `  ${color}${f.severity === 'red' ? '✗' : '⚠'} ${f.severity}${c.reset}  ${f.rule}${loc}`,
        );
        if (f.message) console.log(`     ${c.dim}${f.message}${c.reset}`);
        if (f.excerpt) console.log(`     ${c.dim}${f.excerpt}${c.reset}`);
      }
    }

    // Step 7: red findings are a hard stop; everything else goes to consent.
    const decision = canInstall(scanResult, tier);
    if (!decision.allowed && hasRed) {
      blockedBy = decision.blockedBy ?? 'red safety finding';
    } else {
      draft = {
        id: pluginId,
        package: pkgName,
        version: pkgVersion,
        source: `npm:${exactSpec}`,
        capabilities: {
          shell: permissions.shell === true,
          network: permissions.network ?? null,
        },
        // Verbatim, as shown above. A later reviewer needs what the operator
        // saw, not a re-scan of code that may have changed since.
        scan: { tier, findings, hasRed, hasYellow },
      };
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }

  if (blockedBy !== undefined || draft === undefined) {
    console.log(
      `\n${c.red}✗ Install blocked:${c.reset} ${blockedBy ?? 'the package could not be scanned'}`,
    );
    console.log(`${c.dim}Review the findings above or choose a different package.${c.reset}`);
    process.exit(1);
  }

  // Step 8: consent. No grant, no install — the operator is told what they are
  // taking on and agrees to it, and that agreement is written down first.
  printPluginConsequence(draft);
  const mode = resolvePluginConsent({
    pkg,
    yesFlag,
    isTTY: !!process.stdin.isTTY,
    managed: process.env.ETHOS_MANAGED === '1',
  });
  let consent: PluginGrant['consent'] = 'flag';
  if (mode === 'prompt') {
    const confirmed = await promptConfirm(
      `\n${c.bold}Install ${pkg} and record this grant? [y/N]${c.reset} `,
    );
    if (!confirmed) {
      console.log(
        `${c.dim}Install cancelled. Nothing was installed and no grant recorded.${c.reset}`,
      );
      process.exit(0);
    }
    consent = 'interactive';
  }

  // Recorded BEFORE the code lands on disk: if the grant cannot be written,
  // the install does not happen. A grant for an install that then fails is
  // harmless (it grants nothing on its own and is revocable); code on disk
  // with no recorded consent is the thing we refuse to produce.
  await recordGrant(getStorage(), dir, {
    ...draft,
    grantedAt: new Date().toISOString(),
    consent,
  });
  console.log(
    `${c.green}✓${c.reset} Grant recorded for ${c.cyan}${draft.id}${c.reset} ${c.dim}(ethos plugin grants)${c.reset}`,
  );

  // Step 9: approved — install into the final plugins dir using the exact resolved
  // spec captured during the scan. --ignore-scripts is intentional: lifecycle
  // scripts (preinstall/install/postinstall) are not scanned and can execute
  // arbitrary code. Plugins must not rely on npm lifecycle scripts for their
  // runtime behaviour.
  console.log(
    `\n${c.dim}Installing ${c.reset}${c.bold}${exactSpec}${c.reset}${c.dim} to ${dir}...${c.reset}\n`,
  );
  const result = spawnSync(
    'npm',
    ['install', '--prefix', dir, '--ignore-scripts', '--no-audit', exactSpec],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) {
    console.error(`${c.red}Install failed.${c.reset}`);
    process.exit(result.status ?? 1);
  }
  console.log(`\n${c.green}✓ Installed.${c.reset} Restart ethos to load the plugin.`);

  if (personalityId) {
    const pkgJsonPath = join(pluginsDir(), 'node_modules', draft.package, 'package.json');
    const integrity = await computeIntegrity(pkgJsonPath);
    const entry: PluginLockEntry = {
      package: draft.package,
      version: draft.version,
      registry: 'https://registry.npmjs.org',
      integrity,
    };
    const personalityDir = join(ethosDir(), 'personalities', personalityId);
    const storage = getStorage();
    await updatePersonalityPluginConfig(storage, personalityDir, draft.id, entry);
    console.log(
      `${c.green}✓${c.reset} Added ${c.cyan}${draft.id}${c.reset} to personality ${c.bold}${personalityId}${c.reset}.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Consent — the operator consequence sentence and the grant decision
// ---------------------------------------------------------------------------

/**
 * The G5 sentence, shown at the moment the operator takes the risk on rather
 * than in a doc they read afterwards.
 *
 * Do not soften this. `PluginLoader` `import()`s the plugin's entry module into
 * the ethos process; the plugin shares the process, the environment, the
 * filesystem, and the API keys. There is no sandbox to fall back on.
 */
export const PLUGIN_CONSEQUENCE =
  'Installing a plugin is equivalent to running arbitrary code as your user.';

/** Print the consequence block plus the capabilities the grant will record. */
function printPluginConsequence(draft: Omit<PluginGrant, 'grantedAt' | 'consent'>): void {
  const network =
    draft.capabilities.network === null
      ? '(none declared)'
      : draft.capabilities.network.length > 0
        ? draft.capabilities.network.join(' · ')
        : '(any host)';

  console.log(`\n${c.bold}What installing this plugin means${c.reset}`);
  console.log(`  ${PLUGIN_CONSEQUENCE}`);
  console.log(
    `  ${c.dim}${draft.package} runs inside the ethos process — your files, your environment,${c.reset}`,
  );
  console.log(
    `  ${c.dim}your API keys. The safety scan is a static, pre-install read of the source${c.reset}`,
  );
  console.log(
    `  ${c.dim}for known-dangerous patterns. It is advisory: it sandboxes nothing, it can${c.reset}`,
  );
  console.log(`  ${c.dim}be evaded, and nothing confines this plugin once it is loaded.${c.reset}`);
  console.log(
    `  ${c.dim}The capabilities below are what the plugin declares, not limits it is held to.${c.reset}`,
  );

  console.log(`\n${c.bold}Grant to record${c.reset}`);
  console.log(`  ${'Plugin'.padEnd(20)}${draft.id}  ${c.dim}${draft.source}${c.reset}`);
  console.log(`  ${'Declares shell'.padEnd(20)}${draft.capabilities.shell ? 'yes' : 'no'}`);
  console.log(`  ${'Declares network'.padEnd(20)}${network}`);
  console.log(
    `  ${'Scan at install'.padEnd(20)}${draft.scan.tier} · ${draft.scan.findings.length} finding(s)`,
  );
}

/**
 * Resolve the install decision without hanging on stdin — same shape as the
 * skills install path's `resolveYellowFindings`.
 *
 * Exported for testing; not part of the public CLI surface.
 *
 * @returns `'proceed'` when `--yes` records consent unattended, `'prompt'` when
 * the caller must ask. Throws `EthosError` when consent cannot be taken at all.
 */
export function resolvePluginConsent(opts: {
  pkg: string;
  yesFlag: boolean;
  isTTY: boolean;
  managed: boolean;
}): 'proceed' | 'prompt' {
  const { pkg, yesFlag, isTTY, managed } = opts;

  // --yes RECORDS consent unattended (CI, managed hosts). It does not skip the
  // grant — the grant is still written with `consent: 'flag'` so an operator
  // can see later that nobody was at the keyboard.
  if (yesFlag) {
    console.log(`\n${c.yellow}⚠ Consent recorded for '${pkg}' via --yes.${c.reset}`);
    return 'proceed';
  }

  if (!isTTY || managed) {
    throw new EthosError({
      code: 'PLUGIN_INSTALL_FAILED',
      cause: `Installing '${pkg}' needs a recorded capability grant and stdin is not a TTY.`,
      action: 'Re-run with --yes to record the grant unattended, or install interactively.',
    });
  }

  return 'prompt';
}

// ---------------------------------------------------------------------------
// Grants — inspect and revoke
// ---------------------------------------------------------------------------

async function listGrants(jsonMode: boolean): Promise<void> {
  const dir = pluginsDir();
  const grants = await readGrants(getStorage(), dir);
  const entries = Object.values(grants).sort((a, b) => a.id.localeCompare(b.id));

  if (jsonMode) {
    writeJson(entries);
    return;
  }

  if (entries.length === 0) {
    console.log(`\n${c.dim}No plugin grants recorded.${c.reset}`);
    console.log(
      `${c.dim}A grant is written when you run: ${c.reset}ethos plugin install <package>\n`,
    );
    return;
  }

  console.log(`\n${c.bold}Plugin grants${c.reset}  ${c.dim}(${grantsPath(dir)})${c.reset}`);
  for (const g of entries) {
    const network =
      g.capabilities.network === null
        ? '(none declared)'
        : g.capabilities.network.length > 0
          ? g.capabilities.network.join(' · ')
          : '(any host)';
    const red = g.scan.findings.filter((f) => f.severity === 'red').length;
    const yellow = g.scan.findings.filter((f) => f.severity === 'yellow').length;

    console.log(`\n  ${c.cyan}${g.id}${c.reset}  ${c.dim}v${g.version}${c.reset}`);
    console.log(`    ${'granted'.padEnd(14)}${g.grantedAt} ${c.dim}(${g.consent})${c.reset}`);
    console.log(`    ${'source'.padEnd(14)}${c.dim}${g.source}${c.reset}`);
    console.log(
      `    ${'declares'.padEnd(14)}${c.dim}shell: ${g.capabilities.shell ? 'yes' : 'no'} · network: ${network}${c.reset}`,
    );
    console.log(
      `    ${'scan at grant'.padEnd(14)}${c.dim}${g.scan.tier} · ${red} red · ${yellow} yellow${c.reset}`,
    );
    for (const f of g.scan.findings) {
      const color = f.severity === 'red' ? c.red : c.yellow;
      console.log(`      ${color}${f.severity}${c.reset}  ${c.dim}${f.rule}${c.reset}`);
    }
    if (g.revokedAt) {
      console.log(`    ${c.red}revoked${c.reset}       ${g.revokedAt}`);
    }
  }

  console.log(
    `\n${c.dim}A grant records consent; it is not a sandbox. Revoking stops the loader from${c.reset}`,
  );
  console.log(
    `${c.dim}importing the plugin again — it cannot undo what an already-loaded plugin did.${c.reset}\n`,
  );
}

async function revokePluginGrant(pluginId: string): Promise<void> {
  const dir = pluginsDir();
  const revoked = await revokeGrant(getStorage(), dir, pluginId);
  if (!revoked) {
    console.error(`${c.red}No active grant for '${pluginId}'.${c.reset}`);
    console.error(`${c.dim}→ ethos plugin grants${c.reset}`);
    process.exit(1);
  }
  console.log(`${c.green}✓${c.reset} Revoked the grant for ${c.cyan}${pluginId}${c.reset}.`);
  console.log(
    `${c.dim}The loader will refuse to import it from the next load onwards. Anything it${c.reset}`,
  );
  console.log(
    `${c.dim}already did in a running process stands — revocation cannot claw that back.${c.reset}`,
  );
  console.log(`${c.dim}Remove the package too with: ${c.reset}ethos plugin remove ${pluginId}`);
}

/**
 * Discover the installed package directory from the manifest npm writes into
 * the temp prefix dir. Fails closed if the manifest is absent or ambiguous —
 * the caller must not scan or install when this throws.
 */
export async function findInstalledPkgDir(tmpDir: string, pkgArg: string): Promise<string> {
  let manifest: { dependencies?: Record<string, string> } = {};
  try {
    manifest = JSON.parse(await readFile(join(tmpDir, 'package.json'), 'utf-8')) as typeof manifest;
  } catch {
    throw new EthosError({
      code: 'SKILL_INSTALL_FAILED',
      cause: `npm did not produce a package manifest — cannot verify what was installed for '${pkgArg}'`,
      action: 'Try a plain package name (e.g. ethos-plugin-foo) rather than a tarball or git URL.',
    });
  }
  const names = Object.keys(manifest.dependencies ?? {});
  if (names.length === 0) {
    throw new EthosError({
      code: 'SKILL_INSTALL_FAILED',
      cause: `npm manifest has no recorded dependencies — cannot locate installed package for '${pkgArg}'`,
      action: 'Ensure the package name is correct and try again.',
    });
  }
  if (names.length > 1) {
    throw new EthosError({
      code: 'SKILL_INSTALL_FAILED',
      cause: `npm manifest has unexpected multiple dependencies (${names.join(', ')}) — cannot safely identify '${pkgArg}'`,
      action: 'Install plugins one at a time.',
    });
  }
  const pkgName = names[0];
  const pkgDir = join(tmpDir, 'node_modules', pkgName);
  try {
    await readFile(join(pkgDir, 'package.json'), 'utf-8');
  } catch {
    throw new EthosError({
      code: 'SKILL_INSTALL_FAILED',
      cause: `Installed package directory not found for '${pkgArg}' — expected package.json at ${join(pkgDir, 'package.json')}`,
      action:
        'The package may have installed under a different name. Use a plain npm package name rather than a tarball, git URL, or local path.',
    });
  }
  return pkgDir;
}

async function readPluginPermissions(pkgDir: string): Promise<PluginScanPermissions> {
  try {
    const raw = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    const ethos = raw.ethos;
    if (typeof ethos !== 'object' || ethos === null || Array.isArray(ethos)) return {};
    const perms = (ethos as Record<string, unknown>).permissions;
    if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) return {};
    const p = perms as Record<string, unknown>;
    const result: PluginScanPermissions = {};
    if (p.shell === true) result.shell = true;
    if (Array.isArray(p.network)) {
      result.network = p.network.filter((x): x is string => typeof x === 'string');
    } else if (p.network === true) {
      result.network = [];
    }
    return result;
  } catch {
    return {};
  }
}

async function walkAndScan(
  dir: string,
  permissions: PluginScanPermissions,
  out: ScanFinding[],
): Promise<void> {
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = String(e.name);
    if (e.isDirectory()) {
      if (name === 'node_modules') continue;
      await walkAndScan(join(dir, name), permissions, out);
    } else if (
      /\.[jt]sx?$|\.(?:cjs|mjs)$/.test(name) &&
      !name.endsWith('.d.ts') &&
      !name.endsWith('.d.cts') &&
      !name.endsWith('.d.mts')
    ) {
      const src = await readFile(join(dir, name), 'utf-8').catch(() => null);
      if (src) out.push(...scanPluginCode(src, permissions).findings);
    }
  }
}

function promptConfirm(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === 'y');
    });
  });
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

async function runCredentials(args: string[]): Promise<void> {
  const pluginId = args[0];
  if (!pluginId) {
    console.log(
      'Usage: ethos plugin credentials <pluginId> [--list | --set KEY[=VALUE] | --clear KEY]',
    );
    process.exit(1);
  }

  const flag = args[1] ?? '--list';
  const dataDir = join(homedir(), '.ethos');
  const credDir = join(dataDir, 'plugins', pluginId, 'credentials');

  switch (flag) {
    case '--list': {
      await listCredentials(pluginId, credDir);
      break;
    }
    case '--set': {
      const keyArg = args[2];
      if (!keyArg) {
        console.log('Usage: ethos plugin credentials <pluginId> --set KEY[=VALUE]');
        process.exit(1);
      }
      await setCredential(pluginId, credDir, keyArg);
      break;
    }
    case '--clear': {
      const key = args[2];
      if (!key) {
        console.log('Usage: ethos plugin credentials <pluginId> --clear KEY');
        process.exit(1);
      }
      await clearCredential(credDir, key);
      break;
    }
    default:
      console.log(
        'Usage: ethos plugin credentials <pluginId> [--list | --set KEY[=VALUE] | --clear KEY]',
      );
      process.exit(1);
  }
}

async function readPluginCredentialDeclarations(
  pluginId: string,
): Promise<Array<{ key: string; label: string; type: string; refreshHint?: string }>> {
  const dir = pluginsDir();
  const candidates = [
    join(dir, pluginId, 'package.json'),
    join(dir, 'node_modules', pluginId, 'package.json'),
  ];

  for (const pkgPath of candidates) {
    try {
      const raw = JSON.parse(await readFile(pkgPath, 'utf-8')) as Record<string, unknown>;
      const ethosField = raw.ethos as Record<string, unknown> | undefined;
      if (ethosField && Array.isArray(ethosField.credentials)) {
        return ethosField.credentials as Array<{
          key: string;
          label: string;
          type: string;
          refreshHint?: string;
        }>;
      }
    } catch {
      // package.json not found at this candidate path
    }
  }
  return [];
}

async function listCredentials(pluginId: string, credDir: string): Promise<void> {
  const declared = await readPluginCredentialDeclarations(pluginId);

  let entries: string[] = [];
  try {
    entries = (await readdir(credDir)).filter((name) => !name.endsWith('.meta'));
  } catch {
    // credentials dir doesn't exist yet
  }

  const allKeys = new Set([...declared.map((d) => d.key), ...entries]);

  if (allKeys.size === 0) {
    console.log(`\n${c.dim}No credentials declared or set for ${pluginId}.${c.reset}`);
    return;
  }

  console.log();
  for (const key of allKeys) {
    const isSet = entries.includes(key);
    let detail = `${c.dim}not set${c.reset}`;

    if (isSet) {
      try {
        const metaRaw = await readFile(join(credDir, `${key}.meta`), 'utf-8');
        const meta = JSON.parse(metaRaw) as { updatedAt?: string };
        if (meta.updatedAt) {
          const ageMs = Date.now() - new Date(meta.updatedAt).getTime();
          const ageH = Math.floor(ageMs / (1000 * 60 * 60));
          detail = `${c.green}set${c.reset}  ${c.dim}updated ${ageH}h ago${c.reset}`;
          const decl = declared.find((d) => d.key === key);
          if (decl?.refreshHint === 'daily' && ageH > 20) {
            detail += `  ${c.yellow}-- daily rotation due${c.reset}`;
          } else if (decl?.refreshHint === 'weekly' && ageH > 144) {
            detail += `  ${c.yellow}-- weekly rotation due${c.reset}`;
          }
        } else {
          detail = `${c.green}set${c.reset}`;
        }
      } catch {
        detail = `${c.green}set${c.reset}`;
      }
    }

    console.log(`  ${c.cyan}${key}${c.reset}  ${detail}`);
  }
  console.log();
}

async function setCredential(pluginId: string, credDir: string, keyArg: string): Promise<void> {
  const eqIdx = keyArg.indexOf('=');
  let key: string;
  let value: string;

  if (eqIdx >= 0) {
    key = keyArg.slice(0, eqIdx);
    value = keyArg.slice(eqIdx + 1);
  } else {
    key = keyArg;
    value = await promptSecret(`Enter value for ${key}: `);
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(key)) {
    console.error(
      `${c.red}Invalid key "${key}" -- must be alphanumeric, underscores, hyphens.${c.reset}`,
    );
    process.exit(1);
  }

  await mkdir(credDir, { recursive: true });

  await writeFile(join(credDir, key), value, { mode: 0o600 });
  await writeFile(
    join(credDir, `${key}.meta`),
    JSON.stringify({ updatedAt: new Date().toISOString() }),
    { mode: 0o600 },
  );

  console.log(`${c.green}✓${c.reset} Credential ${c.cyan}${key}${c.reset} saved for ${pluginId}.`);
}

function promptSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function clearCredential(credDir: string, key: string): Promise<void> {
  await rm(join(credDir, key), { force: true }).catch(() => {});
  await rm(join(credDir, `${key}.meta`), { force: true }).catch(() => {});

  console.log(`${c.green}✓${c.reset} Credential ${c.cyan}${key}${c.reset} cleared.`);
}

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

export async function updatePersonalityPluginConfig(
  storage: Storage,
  personalityDir: string,
  pluginId: string,
  entry: PluginLockEntry,
): Promise<void> {
  const lockfile = await readLockfile(storage, personalityDir);
  lockfile[pluginId] = entry;
  await writeLockfile(storage, personalityDir, lockfile);

  const configPath = join(personalityDir, 'config.yaml');
  const configContent = await storage.read(configPath);
  if (!configContent) return;

  const lines = configContent.split('\n');
  const pluginsIdx = lines.findIndex((l) => l.startsWith('plugins:'));

  if (pluginsIdx >= 0) {
    const existing = lines[pluginsIdx].replace('plugins:', '').trim();
    const ids = existing ? existing.split(/\s+/) : [];
    if (!ids.includes(pluginId)) {
      ids.push(pluginId);
      lines[pluginsIdx] = `plugins: ${ids.join(' ')}`;
    }
  } else {
    lines.push(`plugins: ${pluginId}`);
  }

  await storage.write(configPath, lines.join('\n'));
}

async function listPlugins(args: string[] = []): Promise<void> {
  const jsonMode = args.includes('--json');
  const dir = pluginsDir();
  const nmDir = join(dir, 'node_modules');

  const manual: string[] = [];
  const npm: Array<{ name: string; version: string }> = [];

  // Direct subdirectories (manually dropped in, excluding node_modules)
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules') {
        manual.push(e.name);
      }
    }
  } catch {
    // plugins dir doesn't exist yet
  }

  // npm-installed: ethos-plugin-* and @ethos-plugins/* in node_modules
  try {
    const entries = await readdir(nmDir, { withFileTypes: true });
    const candidates = entries.filter(
      (e) =>
        e.isDirectory() &&
        (e.name.startsWith('ethos-plugin-') || e.name.startsWith('@ethos-plugins')),
    );

    for (const e of candidates) {
      const pkgPath = join(nmDir, e.name, 'package.json');
      try {
        const raw = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string };
        npm.push({ name: e.name, version: raw.version ?? '?' });
      } catch {
        npm.push({ name: e.name, version: '?' });
      }
    }

    // Also scan scoped @ethos-plugins/ subdirs
    for (const e of entries.filter((x) => x.isDirectory() && x.name.startsWith('@'))) {
      try {
        const scoped = await readdir(join(nmDir, e.name), { withFileTypes: true });
        for (const s of scoped.filter((x) => x.isDirectory())) {
          const name = `${e.name}/${s.name}`;
          const pkgPath = join(nmDir, name, 'package.json');
          try {
            const raw = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string };
            npm.push({ name, version: raw.version ?? '?' });
          } catch {
            npm.push({ name, version: '?' });
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // node_modules doesn't exist yet
  }

  if (jsonMode) {
    const result: Array<{ name: string; version?: string; source: string }> = [];
    for (const p of npm) {
      const entry: { name: string; version?: string; source: string } = {
        name: p.name,
        source: 'npm',
      };
      if (p.version !== '?') entry.version = p.version;
      result.push(entry);
    }
    for (const name of manual) {
      result.push({ name, source: 'manual' });
    }
    writeJson(result);
    return;
  }

  if (manual.length === 0 && npm.length === 0) {
    console.log(`\n${c.dim}No plugins installed.${c.reset}`);
    console.log(`${c.dim}Install one with: ${c.reset}ethos plugin install ethos-plugin-<name>\n`);
    return;
  }

  console.log();
  if (npm.length > 0) {
    console.log(`${c.bold}npm plugins${c.reset}  ${c.dim}(${dir}/node_modules)${c.reset}`);
    for (const p of npm) {
      console.log(`  ${c.cyan}${p.name}${c.reset}  ${c.dim}v${p.version}${c.reset}`);
    }
    console.log();
  }
  if (manual.length > 0) {
    console.log(`${c.bold}manual plugins${c.reset}  ${c.dim}(${dir})${c.reset}`);
    for (const name of manual) {
      console.log(`  ${c.cyan}${name}${c.reset}`);
    }
    console.log();
  }
}
