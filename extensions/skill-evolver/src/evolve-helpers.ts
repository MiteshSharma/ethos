// Testable implementations of `ethos evolve status` and `ethos evolve apply`.
// These accept an explicit `ethosDir` string so tests can inject a temp dir
// without mocking the module-level `ethosDir()` function.

import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { checkSkillFrontmatter } from '@ethosagent/skills';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

// ---------------------------------------------------------------------------
// ethos evolve status
// ---------------------------------------------------------------------------

interface HistoryRecord {
  ranAt: string;
  evalOutputPath?: string;
  rewritesProposed: number;
  newSkillsProposed: number;
  skipped: unknown[];
}

function parseLastRecord(raw: string): HistoryRecord | null {
  const lines = raw
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const last = lines[lines.length - 1];
  if (!last) return null;
  try {
    return JSON.parse(last) as HistoryRecord;
  } catch {
    return null;
  }
}

export async function runEvolveStatus(_args: string[], ethosDir: string): Promise<void> {
  const historyPath = join(ethosDir, 'evolver-history.jsonl');
  const skillsDir = join(ethosDir, 'skills');
  const pendingDir = join(skillsDir, 'pending');

  // Read history
  let lastRecord: HistoryRecord | null = null;
  try {
    const raw = await readFile(historyPath, 'utf-8');
    lastRecord = parseLastRecord(raw);
  } catch {
    // No history yet
  }

  // Read pending files
  let pendingFiles: string[] = [];
  try {
    const entries = await readdir(pendingDir);
    pendingFiles = entries.filter((e) => e.endsWith('.md')).sort();
  } catch {
    // No pending dir
  }

  if (!lastRecord && pendingFiles.length === 0) {
    console.log(`${c.dim}No proposals yet. Run: ethos evolve run${c.reset}`);
    return;
  }

  if (lastRecord) {
    const ranAt = new Date(lastRecord.ranAt).toLocaleString();
    const proposed = (lastRecord.rewritesProposed ?? 0) + (lastRecord.newSkillsProposed ?? 0);
    const skipped = Array.isArray(lastRecord.skipped) ? lastRecord.skipped.length : 0;
    console.log(`${c.bold}Last run:${c.reset} ${ranAt}`);
    console.log(`  ${c.dim}proposed: ${proposed}  skipped: ${skipped}${c.reset}`);
    console.log('');
  }

  if (pendingFiles.length === 0) {
    console.log(`${c.dim}No pending proposals.${c.reset}`);
    return;
  }

  console.log(`${c.bold}Pending (${pendingFiles.length}):${c.reset}`);
  for (const f of pendingFiles) {
    console.log(`  ${f}`);
  }
  console.log('');
  console.log(
    `Approve with: ${c.bold}ethos evolve apply <filename>${c.reset}  or  ${c.bold}ethos evolve apply --all${c.reset}`,
  );
}

// ---------------------------------------------------------------------------
// ethos evolve apply <skill-id>  |  ethos evolve apply --all [-y]
// ---------------------------------------------------------------------------

function ensureSafeFilename(name: string): string | null {
  if (!name.endsWith('.md')) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return name;
}

/**
 * Skills in `skillsDir` are parsed at startup, so promoting a file with
 * unparseable frontmatter turns a bad proposal into a boot failure. Returns
 * an error string when the file must not be promoted, null when it is safe.
 */
async function frontmatterBlocker(path: string): Promise<string | null> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch {
    return 'unreadable';
  }
  const check = checkSkillFrontmatter(raw);
  return check.ok ? null : check.error;
}

export async function runEvolveApply(args: string[], ethosDir: string): Promise<void> {
  const skillsDir = join(ethosDir, 'skills');
  const pendingDir = join(skillsDir, 'pending');

  const applyAll = args.includes('--all');

  if (applyAll) {
    let entries: string[];
    try {
      entries = await readdir(pendingDir);
    } catch {
      console.log(`${c.dim}No pending skills.${c.reset}`);
      return;
    }
    const mds = entries.filter((e) => e.endsWith('.md'));
    if (mds.length === 0) {
      console.log(`${c.dim}No pending skills.${c.reset}`);
      return;
    }
    for (const f of mds) {
      const blocker = await frontmatterBlocker(join(pendingDir, f));
      if (blocker) {
        console.error(`${c.red}skipped${c.reset} ${f} — invalid frontmatter: ${blocker}`);
        continue;
      }
      await rename(join(pendingDir, f), join(skillsDir, f));
      console.log(`${c.green}approved${c.reset} ${f}`);
    }
    return;
  }

  // Single file
  const fileName = args.find((a) => !a.startsWith('-'));
  if (!fileName) {
    console.error(`${c.red}Usage: ethos evolve apply <filename.md> | --all${c.reset}`);
    process.exit(1);
  }

  const safe = ensureSafeFilename(fileName);
  if (!safe) {
    console.error(`${c.red}Invalid filename: ${fileName}${c.reset}`);
    process.exit(1);
  }

  try {
    await stat(join(pendingDir, safe));
  } catch {
    console.error(`${c.red}No such pending skill: ${safe}${c.reset}`);
    process.exit(1);
  }

  const blocker = await frontmatterBlocker(join(pendingDir, safe));
  if (blocker) {
    console.error(`${c.red}Invalid frontmatter in ${safe}: ${blocker}${c.reset}`);
    console.error(`${c.dim}Values containing ": " must be quoted. Left in pending/.${c.reset}`);
    process.exit(1);
  }

  await rename(join(pendingDir, safe), join(skillsDir, safe));
  console.log(`${c.green}approved${c.reset} ${safe}`);
}

// ---------------------------------------------------------------------------
// ethos evolve prune [--older-than <days>] [--yes]
// ---------------------------------------------------------------------------

function parseOlderThan(args: string[], defaultDays: number): number {
  const idx = args.indexOf('--older-than');
  if (idx === -1 || idx + 1 >= args.length) return defaultDays;
  const val = Number(args[idx + 1]);
  return Number.isFinite(val) && val > 0 ? val : defaultDays;
}

function askConfirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function runEvolvePrune(args: string[], ethosDir: string): Promise<void> {
  const days = parseOlderThan(args, 7);
  const yes = args.includes('--yes');
  const pendingDir = join(ethosDir, 'skills', 'pending');

  let entries: string[];
  try {
    entries = await readdir(pendingDir);
  } catch {
    console.log(`${c.dim}No pending directory.${c.reset}`);
    return;
  }

  const mds = entries.filter((e) => e.endsWith('.md'));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const stale: string[] = [];

  for (const f of mds) {
    try {
      const info = await stat(join(pendingDir, f));
      if (info.mtimeMs < cutoff) stale.push(f);
    } catch {
      // skip unreadable files
    }
  }

  if (stale.length === 0) {
    console.log(`${c.dim}No pending files older than ${days} days.${c.reset}`);
    return;
  }

  if (!yes) {
    for (const f of stale) console.log(`  ${f}`);
    const confirmed = await askConfirm(`Delete ${stale.length} files? [y/N] `);
    if (!confirmed) {
      console.log(`${c.dim}Aborted.${c.reset}`);
      return;
    }
  }

  for (const f of stale) {
    await rm(join(pendingDir, f));
  }
  console.log(`${c.green}pruned ${stale.length} files older than ${days} days${c.reset}`);
}

// ---------------------------------------------------------------------------
// ethos evolve archive [--older-than <days>]
// ---------------------------------------------------------------------------

export async function runEvolveArchive(args: string[], ethosDir: string): Promise<void> {
  const days = parseOlderThan(args, 30);
  const skillsDir = join(ethosDir, 'skills');

  let entries: string[];
  try {
    entries = await readdir(skillsDir);
  } catch {
    console.log(`${c.dim}No skills directory.${c.reset}`);
    return;
  }

  const mds = entries.filter((e) => e.endsWith('.md'));
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const stale: string[] = [];

  for (const f of mds) {
    try {
      const info = await stat(join(skillsDir, f));
      if (info.mtimeMs < cutoff) stale.push(f);
    } catch {
      // skip unreadable files
    }
  }

  if (stale.length === 0) {
    console.log(`${c.dim}No active skills older than ${days} days.${c.reset}`);
    return;
  }

  const prefix = new Date().toISOString().slice(0, 10);
  const archiveDir = join(skillsDir, '.archive', prefix);
  await mkdir(archiveDir, { recursive: true });

  for (const f of stale) {
    await rename(join(skillsDir, f), join(archiveDir, f));
  }

  const manifest = {
    archivedAt: new Date().toISOString(),
    files: stale,
  };
  await writeFile(join(archiveDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  console.log(`${c.green}archived ${stale.length} skills to .archive/${prefix}/${c.reset}`);
}
