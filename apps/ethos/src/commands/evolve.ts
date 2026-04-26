import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEvolveConfig, SkillEvolver } from '@ethosagent/skill-evolver';
import { type EthosConfig, ethosDir } from '../config';
import { createLLM } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

interface ParsedArgs {
  evalOutput: string;
  listPending: boolean;
  approve: string;
  reject: string;
  approveAll: boolean;
  autoApprove: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  let evalOutput = '';
  let listPending = false;
  let approve = '';
  let reject = '';
  let approveAll = false;
  let autoApprove = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--eval-output') {
      evalOutput = args[++i] ?? '';
    } else if (arg === '--list-pending') {
      listPending = true;
    } else if (arg === '--approve') {
      approve = args[++i] ?? '';
    } else if (arg === '--reject') {
      reject = args[++i] ?? '';
    } else if (arg === '--approve-all') {
      approveAll = true;
    } else if (arg === '--auto-approve') {
      autoApprove = true;
    }
  }

  return { evalOutput, listPending, approve, reject, approveAll, autoApprove };
}

function printUsage(): void {
  console.log('Usage:');
  console.log('  ethos evolve --eval-output <file.eval.jsonl> [--auto-approve]');
  console.log('  ethos evolve --list-pending');
  console.log('  ethos evolve --approve <filename> | --approve-all');
  console.log('  ethos evolve --reject <filename>');
}

export async function runEvolve(args: string[], config: EthosConfig): Promise<void> {
  const opts = parseArgs(args);
  const dir = ethosDir();
  const skillsDir = join(dir, 'skills');
  const pendingDir = join(skillsDir, 'pending');

  if (opts.listPending) {
    await listPending(pendingDir);
    return;
  }

  if (opts.approveAll) {
    await approveAll(pendingDir, skillsDir);
    return;
  }

  if (opts.approve) {
    await approveOne(opts.approve, pendingDir, skillsDir);
    return;
  }

  if (opts.reject) {
    await rejectOne(opts.reject, pendingDir);
    return;
  }

  if (opts.evalOutput) {
    await runAnalyze(opts.evalOutput, config, skillsDir, pendingDir, opts.autoApprove);
    return;
  }

  printUsage();
}

async function runAnalyze(
  evalOutput: string,
  config: EthosConfig,
  skillsDir: string,
  pendingDir: string,
  autoApprove: boolean,
): Promise<void> {
  try {
    await stat(evalOutput);
  } catch {
    console.error(`${c.red}Cannot read eval output: ${evalOutput}${c.reset}`);
    process.exit(1);
  }

  await mkdir(skillsDir, { recursive: true });

  const evolveConfig = await loadEvolveConfig(join(ethosDir(), 'evolve-config.json'));
  const llm = await createLLM(config);

  console.log(
    `${c.bold}ethos evolve${c.reset}  ${c.dim}eval: ${evalOutput} · model: ${llm.model}${c.reset}`,
  );

  const evolver = new SkillEvolver({
    evalOutputPath: evalOutput,
    skillsDir,
    pendingDir,
    config: evolveConfig,
    llm,
  });

  const result = await evolver.evolve();

  console.log('');
  console.log(`${c.dim}skills analyzed:${c.reset} ${result.plan.skillStats.length}`);
  console.log(`${c.dim}rewrite candidates:${c.reset} ${result.plan.rewriteCandidates.length}`);
  console.log(`${c.dim}new-skill candidates:${c.reset} ${result.plan.newSkillCandidates.length}`);
  console.log('');

  if (result.rewritesWritten.length > 0) {
    console.log(`${c.green}rewrites written:${c.reset}`);
    for (const f of result.rewritesWritten) console.log(`  ${join(pendingDir, f)}`);
  }
  if (result.newSkillsWritten.length > 0) {
    console.log(`${c.green}new skills written:${c.reset}`);
    for (const f of result.newSkillsWritten) console.log(`  ${join(pendingDir, f)}`);
  }
  if (result.skipped.length > 0) {
    console.log(`${c.yellow}skipped:${c.reset}`);
    for (const s of result.skipped) console.log(`  ${s.kind} ${s.target} — ${s.reason}`);
  }
  if (
    result.rewritesWritten.length === 0 &&
    result.newSkillsWritten.length === 0 &&
    result.skipped.length === 0
  ) {
    console.log(`${c.dim}nothing to evolve.${c.reset}`);
    return;
  }

  const allPending = [...result.rewritesWritten, ...result.newSkillsWritten];
  if (autoApprove && allPending.length > 0) {
    console.log('');
    console.log(`${c.bold}--auto-approve${c.reset} promoting ${allPending.length} file(s)...`);
    for (const f of allPending) {
      await rename(join(pendingDir, f), join(skillsDir, f));
      console.log(`  → ${join(skillsDir, f)}`);
    }
    return;
  }

  console.log('');
  console.log(`Review with: ${c.bold}ethos evolve --list-pending${c.reset}`);
  console.log(`Approve with: ${c.bold}ethos evolve --approve <filename>${c.reset}`);
}

async function listPending(pendingDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(pendingDir);
  } catch {
    console.log(`${c.dim}No pending skills.${c.reset}`);
    return;
  }
  const mds = entries.filter((e) => e.endsWith('.md')).sort();
  if (mds.length === 0) {
    console.log(`${c.dim}No pending skills.${c.reset}`);
    return;
  }
  console.log(`${c.bold}Pending skills${c.reset}  ${c.dim}${pendingDir}${c.reset}`);
  for (const f of mds) console.log(`  ${f}`);
}

async function approveAll(pendingDir: string, skillsDir: string): Promise<void> {
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
    await rename(join(pendingDir, f), join(skillsDir, f));
    console.log(`${c.green}approved${c.reset} ${f}`);
  }
}

async function approveOne(fileName: string, pendingDir: string, skillsDir: string): Promise<void> {
  const safe = ensureSafeFilename(fileName);
  if (!safe) {
    console.error(`${c.red}Invalid filename: ${fileName}${c.reset}`);
    process.exit(1);
  }
  try {
    await rename(join(pendingDir, safe), join(skillsDir, safe));
    console.log(`${c.green}approved${c.reset} ${safe}`);
  } catch {
    console.error(`${c.red}No such pending skill: ${safe}${c.reset}`);
    process.exit(1);
  }
}

async function rejectOne(fileName: string, pendingDir: string): Promise<void> {
  const safe = ensureSafeFilename(fileName);
  if (!safe) {
    console.error(`${c.red}Invalid filename: ${fileName}${c.reset}`);
    process.exit(1);
  }
  try {
    await rm(join(pendingDir, safe));
    console.log(`${c.dim}rejected ${safe}${c.reset}`);
  } catch {
    console.error(`${c.red}No such pending skill: ${safe}${c.reset}`);
    process.exit(1);
  }
}

function ensureSafeFilename(name: string): string | null {
  if (!name.endsWith('.md')) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  return name;
}
