import { spawnSync } from 'node:child_process';
import { mkdir, open, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { createInterface } from 'node:readline';
import { ethosDir } from '@ethosagent/config';
import { bundledSkillsSource, checkRequirements, UniversalScanner } from '@ethosagent/skills';
import { isSafePathSegment } from '@ethosagent/storage-fs';
import { EthosError, type Skill } from '@ethosagent/types';
import {
  canInstall,
  deriveTier,
  type ScanFinding,
  scanPluginCode,
  scanSkillMd,
  type TrustTier,
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

function skillsRoot(): string {
  return join(ethosDir(), 'skills');
}

export async function runSkills(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'install': {
      const yesFlag = args.includes('--yes');
      const slug = args.filter((a) => a !== '--yes')[1];
      if (!slug) {
        console.log('Usage: ethos skills install <slug> [--yes]');
        console.log('  e.g. ethos skills install steipete/slack');
        console.log('       ethos skills install github:owner/repo/path');
        console.log('       ethos skills install owner/skill --yes  # accept yellow findings');
        process.exit(1);
      }
      await installSkill(slug, yesFlag);
      break;
    }

    case 'update': {
      const yesFlag = args.includes('--yes');
      const slug = args.filter((a) => a !== '--yes')[1];
      if (slug) {
        await updateOne(slug, yesFlag);
      } else {
        await updateAll(yesFlag);
      }
      break;
    }

    case 'remove': {
      const slug = args[1];
      if (!slug) {
        console.log('Usage: ethos skills remove <slug>');
        process.exit(1);
      }
      await removeSkill(slug);
      break;
    }

    case 'list': {
      await listSkills(args);
      break;
    }

    default:
      console.log('Usage: ethos skills [install <slug> | list | update [slug] | remove <slug>]');
  }
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

async function installSkill(slug: string, yesFlag = false): Promise<void> {
  const dir = skillsRoot();
  printSkillConsequence();
  console.log(
    `${c.dim}Installing ${c.reset}${c.bold}${slug}${c.reset}${c.dim} via clawhub to ${dir}...${c.reset}\n`,
  );
  try {
    await atomicInstall({
      slug,
      skillsRoot: dir,
      runInstaller: async (workdir) => {
        const result = runClawhub(['install', '--workdir', workdir, slug]);
        if (result.status !== 0) {
          throw new EthosError({
            code: 'SKILL_INSTALL_FAILED',
            cause: `clawhub exited with status ${result.status ?? 'unknown'}`,
            action: 'Check the clawhub output above and re-run with the corrected slug.',
          });
        }
      },
      onBeforeCommit: (skillDir) => scanSkillDir(slug, skillDir, yesFlag),
    });
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
  console.log(`\n${c.green}✓ Installed ${slug}.${c.reset}`);
}

async function updateOne(slug: string, yesFlag = false, announce = true): Promise<void> {
  const dir = skillsRoot();
  if (announce) printSkillConsequence();
  console.log(`${c.dim}Updating ${c.reset}${c.bold}${slug}${c.reset}${c.dim}...${c.reset}\n`);
  try {
    // clawhub treats `install` of an existing slug as an update.
    await atomicInstall({
      slug,
      skillsRoot: dir,
      runInstaller: async (workdir) => {
        const result = runClawhub(['install', '--workdir', workdir, slug]);
        if (result.status !== 0) {
          throw new EthosError({
            code: 'SKILL_INSTALL_FAILED',
            cause: `clawhub exited with status ${result.status ?? 'unknown'}`,
            action: 'Check the clawhub output above and re-run with the corrected slug.',
          });
        }
      },
      onBeforeCommit: (skillDir) => scanSkillDir(slug, skillDir, yesFlag),
    });
  } catch (err) {
    if (err instanceof EthosError) {
      console.error(`${c.red}${err.cause}${c.reset}\n${c.dim}→ ${err.action}${c.reset}`);
    } else {
      console.error(
        `${c.red}Update failed: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
      );
    }
    process.exit(1);
  }
  console.log(`\n${c.green}✓ Updated ${slug}.${c.reset}`);
}

async function updateAll(yesFlag = false): Promise<void> {
  const slugs = await listInstalledSlugs();
  if (slugs.length === 0) {
    console.log(`${c.dim}No skills installed.${c.reset}`);
    return;
  }
  printSkillConsequence();
  for (const slug of slugs) {
    await updateOne(slug, yesFlag, false);
  }
}

async function removeSkill(slug: string): Promise<void> {
  if (!isSafePathSegment(slug)) {
    console.error(`${c.red}Invalid skill slug: ${slug}${c.reset}`);
    process.exit(1);
  }
  const target = join(skillsRoot(), slug);
  try {
    const s = await stat(target);
    if (!s.isDirectory()) {
      console.error(`${c.red}Not a skill directory: ${target}${c.reset}`);
      process.exit(1);
    }
  } catch {
    console.error(`${c.red}Skill not found: ${slug}${c.reset}`);
    process.exit(1);
  }
  await rm(target, { recursive: true, force: true });
  console.log(`${c.green}✓ Removed ${slug}.${c.reset}`);
}

async function listSkills(args: string[] = []): Promise<void> {
  const jsonMode = args.includes('--json');
  const pool = await new UniversalScanner({
    storage: getStorage(),
    trustedFirstPartySources: [bundledSkillsSource()],
  }).scan();

  const bySource = new Map<string, Skill[]>();
  for (const skill of pool.values()) {
    const list = bySource.get(skill.source) ?? [];
    list.push(skill);
    bySource.set(skill.source, list);
  }

  // Stable order: bundled first, then ethos (user), then alphabetical
  const sourceOrder = (label: string): number => {
    if (label === 'ethos-bundled') return 0;
    if (label === 'ethos') return 1;
    return 2;
  };
  const sortedSources = [...bySource.keys()].sort(
    (a, b) => sourceOrder(a) - sourceOrder(b) || a.localeCompare(b),
  );

  if (jsonMode) {
    const result: Array<{ name: string; source: string; category?: string }> = [];
    for (const source of sortedSources) {
      const skills = (bySource.get(source) ?? []).sort((a, b) => a.name.localeCompare(b.name));
      for (const skill of skills) {
        const ethosFm = skill.rawFrontmatter.ethos as { category?: unknown } | undefined;
        const category = typeof ethosFm?.category === 'string' ? ethosFm.category : undefined;
        const entry: { name: string; source: string; category?: string } = {
          name: skill.name,
          source,
        };
        if (category) entry.category = category;
        result.push(entry);
      }
    }
    writeJson(result);
    return;
  }

  if (sortedSources.length === 0) {
    console.log(`\n${c.dim}No skills found.${c.reset}`);
    console.log(`${c.dim}Install one with: ${c.reset}ethos skills install <slug>\n`);
    return;
  }

  // Gap 11 — check `requires` gates so we can surface unavailable skills.
  // This command runs standalone (no agent loop, no tool registry), so tool
  // availability is unknown: pass null so checkRequirements skips the tools
  // gate (env/os still checked) instead of marking every tool-requiring
  // skill unavailable against an empty set.
  for (const skill of pool.values()) {
    const reason = checkRequirements(skill.requires, null);
    if (reason) skill.unavailableReason = reason;
  }

  console.log();
  for (const source of sortedSources) {
    const skills = (bySource.get(source) ?? []).sort((a, b) => a.name.localeCompare(b.name));
    const root = source === 'ethos' ? `  ${c.dim}(${skillsRoot()})${c.reset}` : '';
    console.log(`${c.bold}${source}${c.reset}${root}`);
    for (const skill of skills) {
      const ethosFm = skill.rawFrontmatter.ethos as { category?: unknown } | undefined;
      const category = typeof ethosFm?.category === 'string' ? ethosFm.category : undefined;
      const tag = category ? `  ${c.dim}[${category}]${c.reset}` : '';
      const unavail = skill.unavailableReason
        ? `  ${c.dim}[unavailable: ${skill.unavailableReason}]${c.reset}`
        : '';
      console.log(`  ${c.cyan}${skill.name}${c.reset}${tag}${unavail}`);
    }
    console.log();
  }
}

// ---------------------------------------------------------------------------
// The operator consequence — shown before the install, not after
// ---------------------------------------------------------------------------

/**
 * §4.7 / G5 — the consequence sentence at the moment the operator takes the
 * risk on. A skill is instructions plus scripts handed to an agent that already
 * holds the user's shell, files, and keys; installing one is the same class of
 * decision as installing a plugin, one indirection removed.
 *
 * Do not soften this, and do not let it imply the scanner is a boundary.
 */
export const SKILL_CONSEQUENCE =
  'Installing a skill is equivalent to running arbitrary code as your user.';

function printSkillConsequence(): void {
  console.log(`\n${c.bold}What installing a skill means${c.reset}`);
  console.log(`  ${SKILL_CONSEQUENCE}`);
  console.log(
    `  ${c.dim}Your agent reads its instructions and runs its scripts with your files,${c.reset}`,
  );
  console.log(
    `  ${c.dim}your environment, and your API keys. The safety scan below is a static${c.reset}`,
  );
  console.log(
    `  ${c.dim}pre-install read of the source: advisory only. It sandboxes nothing and${c.reset}`,
  );
  console.log(`  ${c.dim}it can be evaded.${c.reset}\n`);
}

// ---------------------------------------------------------------------------
// Pre-install safety scan
// ---------------------------------------------------------------------------

function deriveTierFromSlug(slug: string): TrustTier {
  if (slug.startsWith('/') || slug.startsWith('./') || slug.startsWith('../')) {
    return 'untrusted';
  }
  if (slug.startsWith('github:')) {
    return deriveTier(`github.com/${slug.slice('github:'.length)}`);
  }
  // Short clawhub slug: owner/name
  return deriveTier(`clawhub/${slug}`);
}

/** Regex matching scannable source file extensions. */
const SCANNABLE_SOURCE_EXT = /\.[jt]sx?$|\.(?:cjs|mjs)$/;

/** Declaration-file suffixes that should be skipped. */
function isDeclarationFile(name: string): boolean {
  return name.endsWith('.d.ts') || name.endsWith('.d.cts') || name.endsWith('.d.mts');
}

/**
 * Recursively walk `dir` and scan all source files through `scanPluginCode`.
 * Skips `node_modules` directories and declaration files.
 */
async function walkAndScanSkillSource(dir: string, out: ScanFinding[]): Promise<void> {
  let entries: Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const name = String(e.name);
    if (e.isDirectory()) {
      if (name === 'node_modules') continue;
      await walkAndScanSkillSource(join(dir, name), out);
    } else if (SCANNABLE_SOURCE_EXT.test(name) && !isDeclarationFile(name)) {
      const src = await readFile(join(dir, name), 'utf-8').catch(() => null);
      if (src) out.push(...scanPluginCode(src).findings);
    }
  }
}

async function scanSkillDir(slug: string, skillDir: string, yesFlag = false): Promise<void> {
  // Scan SKILL.md for prompt-injection / hidden-unicode / etc.
  const allFindings: ScanFinding[] = [];
  try {
    const content = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
    allFindings.push(...scanSkillMd(content, join(skillDir, 'SKILL.md')).findings);
  } catch {
    // No SKILL.md — locateSlugSubpath already verified its presence
  }

  // Also scan any source files (.ts, .js, .cjs, .mjs, .tsx, .jsx) in the bundle
  await walkAndScanSkillSource(skillDir, allFindings);

  const result = {
    findings: allFindings,
    hasRed: allFindings.some((f) => f.severity === 'red'),
    hasYellow: allFindings.some((f) => f.severity === 'yellow'),
  };

  if (!result.hasRed && !result.hasYellow) return;

  const tier = deriveTierFromSlug(slug);
  const tierColor = tier === 'untrusted' ? c.red : tier === 'community' ? c.yellow : c.dim;
  const decision = canInstall(result, tier);

  console.log(`\n${c.bold}Safety scan — ${slug}${c.reset}  ${tierColor}[${tier}]${c.reset}`);
  for (const f of result.findings) {
    const color = f.severity === 'red' ? c.red : c.yellow;
    const loc = f.line !== undefined ? `:${f.line}` : '';
    console.log(
      `  ${color}${f.severity === 'red' ? '✗' : '⚠'} ${f.severity}${c.reset}  ${f.rule}${loc}`,
    );
    if (f.message) console.log(`     ${c.dim}${f.message}${c.reset}`);
    if (f.excerpt) console.log(`     ${c.dim}${f.excerpt}${c.reset}`);
  }

  if (!decision.allowed) {
    if (result.hasRed) {
      console.log();
      throw new EthosError({
        code: 'SKILL_INSTALL_FAILED',
        cause: `Skill '${slug}' blocked by safety scan: ${decision.blockedBy}`,
        action:
          'Review the findings above. Remove the flagged content or choose a different skill.',
      });
    }
    // Yellow-only for community/untrusted: accept via --yes, fail fast if
    // non-interactive, or prompt interactively.
    const yellowAction = resolveYellowFindings({
      slug,
      findings: result.findings,
      yesFlag,
      isTTY: !!process.stdin.isTTY,
      managed: process.env.ETHOS_MANAGED === '1',
    });

    if (yellowAction === 'proceed') return;

    // Interactive TTY path: prompt for confirmation
    const confirmed = await promptConfirm(
      `\n${c.yellow}⚠ Install '${slug}' with the warnings above? [y/N]${c.reset} `,
    );
    if (!confirmed) {
      throw new EthosError({
        code: 'SKILL_INSTALL_FAILED',
        cause: `Skill '${slug}' install cancelled by user`,
        action: 'Choose a different skill or contact the skill author to address the findings.',
      });
    }
    return;
  }

  console.log(`${c.yellow}⚠ Installed with warnings — review findings above.${c.reset}`);
}

/**
 * Resolve a yellow-finding install decision without hanging on stdin.
 *
 * Exported for testing — not part of the public CLI surface.
 *
 * @returns `'proceed'` to continue installing, or throws EthosError to abort.
 */
export function resolveYellowFindings(opts: {
  slug: string;
  findings: ScanFinding[];
  yesFlag: boolean;
  isTTY: boolean;
  managed: boolean;
}): 'proceed' | 'prompt' {
  const { slug, findings, yesFlag, isTTY, managed } = opts;
  const yellowFindings = findings.filter((f) => f.severity === 'yellow');

  if (yesFlag) {
    console.log(`${c.yellow}⚠ Accepted yellow findings for '${slug}' (--yes)${c.reset}`);
    for (const f of yellowFindings) {
      console.log(`  ${c.dim}accepted: ${f.rule}${c.reset}`);
    }
    return 'proceed';
  }

  const nonInteractive = !isTTY || managed;
  if (nonInteractive) {
    const findingSummary = yellowFindings.map((f) => f.rule).join(', ');
    throw new EthosError({
      code: 'SKILL_INSTALL_FAILED',
      cause: `Skill '${slug}' has yellow safety findings (${findingSummary}) and stdin is not a TTY.`,
      action: 'Re-run with --yes to accept the findings, or install interactively.',
    });
  }

  return 'prompt';
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
// Atomic install
// ---------------------------------------------------------------------------
//
// Skill installs must never leave a half-written `<skillsRoot>/<slug>/` on
// disk: the user runs `ethos skills install`, kills the process during a slow
// download, and the directory is either present-and-complete or absent.
//
// Strategy:
//   1. Acquire an exclusive lock on `<skillsRoot>/.lock` (concurrent installs
//      serialize behind it; a second caller waits up to LOCK_TIMEOUT_MS).
//   2. Run the installer (clawhub) into a per-pid temp dir under
//      `<skillsRoot>/.tmp/<slug>-<pid>/`.
//   3. After the installer reports success, locate the slug subtree (the
//      directory containing `SKILL.md`) and atomically `rename(2)` it into
//      its final destination. If the destination already exists (update
//      flow), rename it aside first, swap the new in, then remove the aside.
//   4. On any error, `rm -rf` the temp dir; the destination stays untouched.
//   5. SIGKILL during step 2 leaves orphaned tmp dirs but never a partial
//      `<skillsRoot>/<slug>/` — `listInstalledSlugs()` skips dotfile
//      directories so the orphaned `.tmp/` is invisible to users. Subsequent
//      installs can reuse the tmp namespace freely (per-pid suffix avoids
//      collisions).

const LOCK_TIMEOUT_MS = 60_000;
const LOCK_POLL_MS = 200;

interface AtomicInstallOpts {
  slug: string;
  skillsRoot: string;
  /**
   * Runs the actual install into the supplied workdir. Must throw on failure.
   * On return, the workdir is expected to contain the slug subtree (one
   * `SKILL.md` file marks the leaf directory).
   */
  runInstaller: (workdir: string) => Promise<void>;
  /**
   * Called with the resolved skill directory after the installer succeeds but
   * before the rename commits it to the final location. Throw to abort —
   * the workdir is cleaned up and the destination is left untouched.
   */
  onBeforeCommit?: (skillDir: string) => Promise<void>;
  /** Override pid for deterministic tests; defaults to `process.pid`. */
  pid?: number;
}

export async function atomicInstall(opts: AtomicInstallOpts): Promise<void> {
  const { slug, skillsRoot, runInstaller, onBeforeCommit } = opts;
  const pid = opts.pid ?? process.pid;
  const tmpRoot = join(skillsRoot, '.tmp');
  const lockPath = join(skillsRoot, '.lock');

  await mkdir(skillsRoot, { recursive: true });
  await mkdir(tmpRoot, { recursive: true });

  const tmpDir = join(tmpRoot, `${slug.replace(/[^A-Za-z0-9._-]/g, '_')}-${pid}`);

  const releaseLock = await acquireLock(lockPath);
  try {
    // Wipe any prior remnant for this pid, then create a fresh tmp dir.
    await rm(tmpDir, { recursive: true, force: true });
    await mkdir(tmpDir, { recursive: true });

    // If the installer throws, the `finally` below still runs `rm -rf` on the
    // tmp dir — destination is never touched.
    await runInstaller(tmpDir);

    // Locate the slug subtree by finding the SKILL.md leaf.
    const slugSubpath = await locateSlugSubpath(tmpDir);
    if (!slugSubpath) {
      throw new EthosError({
        code: 'SKILL_INSTALL_FAILED',
        cause: `installer produced no SKILL.md under ${tmpDir}`,
        action:
          'The slug may be wrong, or the upstream skill is missing SKILL.md. Check the installer output above.',
      });
    }

    const src = join(tmpDir, slugSubpath);
    const dst = join(skillsRoot, slugSubpath);

    // Pre-commit hook (e.g. safety scan) — throw to abort before any rename.
    await onBeforeCommit?.(src);

    await mkdir(dirname(dst), { recursive: true });

    // If the destination exists (update flow), rename it aside first so the
    // swap-in is still atomic. We restore the aside if rename fails.
    let aside: string | undefined;
    try {
      await stat(dst);
      aside = `${dst}.old-${pid}`;
      await rm(aside, { recursive: true, force: true });
      await rename(dst, aside);
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== 'ENOENT') throw err;
      // Destination doesn't exist — first-time install.
    }

    try {
      await rename(src, dst);
    } catch (err) {
      // Roll back: restore the aside.
      if (aside) {
        try {
          await rename(aside, dst);
        } catch {
          // Best-effort; leave the aside in place if even rollback fails.
        }
      }
      throw err;
    }

    // Success → drop the aside copy.
    if (aside) await rm(aside, { recursive: true, force: true });
  } finally {
    // Always clean up the per-pid tmp directory; never leaves a half-written
    // dir under <skillsRoot>/<slug>/ either way.
    try {
      await rm(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
    await releaseLock();
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const start = Date.now();
  while (true) {
    try {
      const fh = await open(lockPath, 'wx');
      await fh.write(`${process.pid}\n`);
      await fh.close();
      return async () => {
        try {
          await unlink(lockPath);
        } catch {
          // Lock file already gone — nothing to release.
        }
      };
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      if (code !== 'EEXIST') throw err;
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new EthosError({
          code: 'SKILL_INSTALL_FAILED',
          cause: `another skill install is in progress (lock held: ${lockPath})`,
          action:
            'Wait for the other install to finish. If no install is running, remove the lock file manually.',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, LOCK_POLL_MS));
    }
  }
}

async function locateSlugSubpath(tmpDir: string): Promise<string | undefined> {
  // Walk `tmpDir` looking for the first `SKILL.md`; return its parent dir
  // path relative to `tmpDir`. clawhub may emit either `<slug>/SKILL.md` or
  // `<scope>/<name>/SKILL.md`, so we don't pre-assume the depth.
  const stack: string[] = [tmpDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (!dir) break;
    let entries: Array<{ name: string; isDir: boolean; isFile: boolean }>;
    try {
      const raw = await readdir(dir, { withFileTypes: true });
      entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory(), isFile: e.isFile() }));
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isFile && entry.name === 'SKILL.md') {
        const parent = dirname(full);
        return relative(tmpDir, parent);
      }
      if (entry.isDir) stack.push(full);
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function runClawhub(extraArgs: string[]) {
  // Prefer a globally-installed `clawhub`, otherwise fall back to `npx clawhub@latest`.
  const direct = spawnSync('clawhub', ['--version'], { stdio: 'ignore' });
  if (direct.status === 0) {
    return spawnSync('clawhub', extraArgs, { stdio: 'inherit' });
  }
  return spawnSync('npx', ['clawhub@latest', ...extraArgs], { stdio: 'inherit' });
}

async function listInstalledSlugs(): Promise<string[]> {
  const root = skillsRoot();
  let entries: Array<{ name: string; isDir: boolean }>;
  try {
    const raw = await readdir(root, { withFileTypes: true });
    entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }));
  } catch {
    return [];
  }

  const slugs: string[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.isDir) continue;
    if (entry.name === 'pending' || entry.name.startsWith('.')) continue;
    const skillRoot = join(root, entry.name);

    if (await exists(join(skillRoot, 'SKILL.md'))) {
      slugs.push(entry.name);
      continue;
    }

    // Scoped: <root>/<scope>/<slug>/SKILL.md
    try {
      const inner = await readdir(skillRoot, { withFileTypes: true });
      for (const child of inner.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!child.isDirectory()) continue;
        if (await exists(join(skillRoot, child.name, 'SKILL.md'))) {
          slugs.push(`${entry.name}/${child.name}`);
        }
      }
    } catch {
      // ignore unreadable dirs
    }
  }
  return slugs;
}

async function exists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}
