import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseTasksJsonl } from '@ethosagent/batch-runner';
import { EvalRunner, parseExpectedJsonl } from '@ethosagent/eval-harness';
import { loadEvolveConfig, SkillEvolver } from '@ethosagent/skill-evolver';
import { type EthosConfig, ethosDir } from '../config';
import { createAgentLoop, createLLM } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

type Scorer = 'exact' | 'contains' | 'regex' | 'llm';

function isScorer(v: string): v is Scorer {
  return v === 'exact' || v === 'contains' || v === 'regex' || v === 'llm';
}

function parseArgs(args: string[]): {
  inputPath: string;
  expectedPath: string;
  outputPath: string;
  scorer: Scorer;
  concurrency: number;
  evolve: boolean;
  autoApprove: boolean;
} {
  let inputPath = '';
  let expectedPath = '';
  let outputPath = '';
  let scorer: Scorer = 'contains';
  let concurrency = 3;
  let evolve = false;
  let autoApprove = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--expected' || arg === '-e') {
      expectedPath = args[++i] ?? '';
    } else if (arg === '--scorer' || arg === '-s') {
      const val = args[++i] ?? '';
      if (!isScorer(val))
        throw new Error(`--scorer must be one of: exact, contains, regex, llm (got: ${val})`);
      scorer = val;
    } else if (arg === '--output' || arg === '-o') {
      outputPath = args[++i] ?? '';
    } else if (arg === '--concurrency' || arg === '-c') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1)
        throw new Error('--concurrency must be a positive integer');
      concurrency = n;
    } else if (arg === '--evolve') {
      evolve = true;
    } else if (arg === '--auto-approve') {
      autoApprove = true;
    } else if (!arg.startsWith('-')) {
      inputPath = arg;
    }
  }

  if (!inputPath)
    throw new Error(
      'Usage: ethos eval run <tasks.jsonl> --expected <expected.jsonl> [--scorer exact|contains|regex|llm] [--concurrency N] [--output out.jsonl] [--evolve [--auto-approve]]',
    );
  if (!expectedPath) throw new Error('--expected <expected.jsonl> is required');

  const base = inputPath.replace(/\.jsonl$/, '');
  if (!outputPath) outputPath = `${base}.eval.jsonl`;

  return { inputPath, expectedPath, outputPath, scorer, concurrency, evolve, autoApprove };
}

export async function runEval(subArgs: string[], config: EthosConfig): Promise<void> {
  const sub = subArgs[0] ?? '';
  const rest = subArgs.slice(1);

  if (sub !== 'run') {
    console.log('Usage: ethos eval run <tasks.jsonl> --expected <expected.jsonl> [options]');
    console.log('');
    console.log('Options:');
    console.log('  --expected, -e   Path to expected outputs JSONL (required)');
    console.log('  --scorer, -s     Scorer: exact | contains | regex | llm  (default: contains)');
    console.log('  --concurrency -c Concurrent tasks (default: 3)');
    console.log('  --output, -o     Output path (default: <input>.eval.jsonl)');
    console.log('  --evolve         After scoring, run skill evolver on the output');
    console.log('  --auto-approve   With --evolve, promote pending skills automatically');
    return;
  }

  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(rest);
  } catch (err) {
    console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
    process.exit(1);
  }

  const { inputPath, expectedPath, outputPath, scorer, concurrency, evolve, autoApprove } = opts;

  let taskSrc: string;
  try {
    taskSrc = await readFile(inputPath, 'utf-8');
  } catch {
    console.error(`${c.red}Cannot read tasks file: ${inputPath}${c.reset}`);
    process.exit(1);
  }

  let expectedSrc: string;
  try {
    expectedSrc = await readFile(expectedPath, 'utf-8');
  } catch {
    console.error(`${c.red}Cannot read expected file: ${expectedPath}${c.reset}`);
    process.exit(1);
  }

  let tasks: ReturnType<typeof parseTasksJsonl>;
  try {
    tasks = parseTasksJsonl(taskSrc);
  } catch (err) {
    console.error(
      `${c.red}Invalid tasks file: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    process.exit(1);
  }

  let expectedMap: ReturnType<typeof parseExpectedJsonl>;
  try {
    expectedMap = parseExpectedJsonl(expectedSrc);
  } catch (err) {
    console.error(
      `${c.red}Invalid expected file: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    process.exit(1);
  }

  if (tasks.length === 0) {
    console.log(`${c.yellow}No tasks found in ${inputPath}${c.reset}`);
    return;
  }

  console.log(
    `${c.bold}ethos eval${c.reset}  ${c.dim}${tasks.length} tasks · scorer: ${scorer} · concurrency ${concurrency}${c.reset}`,
  );
  console.log(`${c.dim}  expected   → ${expectedPath}${c.reset}`);
  console.log(`${c.dim}  output     → ${outputPath}${c.reset}\n`);

  const loop = await createAgentLoop(config);
  const runner = new EvalRunner(loop, {
    concurrency,
    outputPath,
    defaultScorer: scorer,
  });

  const start = Date.now();
  let lastLine = '';

  const stats = await runner.run(tasks, expectedMap, (done, total) => {
    const pct = Math.round((done / total) * 100);
    const line = `  ${done}/${total} (${pct}%)`;
    process.stdout.write(`\r${line.padEnd(lastLine.length + 2)}`);
    lastLine = line;
  });

  if (lastLine) process.stdout.write('\n');

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const passMark = `${c.green}${stats.passed} passed${c.reset}`;
  const failMark = stats.failed > 0 ? `  ${c.red}${stats.failed} failed${c.reset}` : '';
  const avgMark = `  ${c.dim}avg ${(stats.avgScore * 100).toFixed(0)}%${c.reset}`;

  console.log(`\n${c.bold}${passMark}${failMark}${avgMark}  ${c.dim}${elapsed}s${c.reset}`);
  console.log(`${c.dim}output → ${outputPath}${c.reset}`);

  if (evolve) await runEvolveAfter(config, outputPath, autoApprove);

  if (stats.failed > 0) process.exit(1);
}

async function runEvolveAfter(
  config: EthosConfig,
  evalOutputPath: string,
  autoApprove: boolean,
): Promise<void> {
  const dir = ethosDir();
  const skillsDir = join(dir, 'skills');
  const pendingDir = join(skillsDir, 'pending');
  const evolveConfig = await loadEvolveConfig(join(dir, 'evolve-config.json'));
  const llm = await createLLM(config);

  console.log(`\n${c.bold}evolving skills${c.reset}  ${c.dim}model: ${llm.model}${c.reset}`);

  const evolver = new SkillEvolver({
    evalOutputPath,
    skillsDir,
    pendingDir,
    config: evolveConfig,
    llm,
  });
  const result = await evolver.evolve();

  console.log(
    `  rewrites: ${result.rewritesWritten.length}  new: ${result.newSkillsWritten.length}  skipped: ${result.skipped.length}`,
  );
  for (const f of result.rewritesWritten) console.log(`  ${c.green}rewrite${c.reset} ${f}`);
  for (const f of result.newSkillsWritten) console.log(`  ${c.green}new${c.reset}     ${f}`);
  for (const s of result.skipped)
    console.log(`  ${c.yellow}skip${c.reset}    ${s.kind} ${s.target} — ${s.reason}`);

  if (autoApprove) {
    const { rename } = await import('node:fs/promises');
    const all = [...result.rewritesWritten, ...result.newSkillsWritten];
    for (const f of all) await rename(join(pendingDir, f), join(skillsDir, f));
    if (all.length > 0) console.log(`  ${c.green}auto-approved${c.reset} ${all.length} file(s)`);
  } else if (result.rewritesWritten.length + result.newSkillsWritten.length > 0) {
    console.log(`  ${c.dim}review with: ethos evolve --list-pending${c.reset}`);
  }
}
