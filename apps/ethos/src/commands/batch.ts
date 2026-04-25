import { readFile } from 'node:fs/promises';
import { BatchRunner, parseTasksJsonl } from '@ethosagent/batch-runner';
import type { EthosConfig } from '../config';
import { createAgentLoop } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

function parseArgs(args: string[]): {
  inputPath: string;
  concurrency: number;
  outputPath: string;
  checkpointPath: string;
} {
  let inputPath = '';
  let concurrency = 3;
  let outputPath = '';
  let checkpointPath = '';

  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--concurrency' || arg === '-c') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1)
        throw new Error('--concurrency must be a positive integer');
      concurrency = n;
    } else if (arg === '--output' || arg === '-o') {
      outputPath = args[++i] ?? '';
    } else if (arg === '--checkpoint') {
      checkpointPath = args[++i] ?? '';
    } else if (!arg.startsWith('-')) {
      inputPath = arg;
    }
  }

  if (!inputPath)
    throw new Error(
      'Usage: ethos batch <tasks.jsonl> [--concurrency N] [--output out.jsonl] [--checkpoint cp.json]',
    );

  const base = inputPath.replace(/\.jsonl$/, '');
  if (!outputPath) outputPath = `${base}.output.jsonl`;
  if (!checkpointPath) checkpointPath = `${base}.checkpoint.json`;

  return { inputPath, concurrency, outputPath, checkpointPath };
}

export async function runBatch(args: string[], config: EthosConfig): Promise<void> {
  let opts: ReturnType<typeof parseArgs>;
  try {
    opts = parseArgs(args);
  } catch (err) {
    console.error(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
    process.exit(1);
  }

  const { inputPath, concurrency, outputPath, checkpointPath } = opts;

  let src: string;
  try {
    src = await readFile(inputPath, 'utf-8');
  } catch {
    console.error(`${c.red}Cannot read input file: ${inputPath}${c.reset}`);
    process.exit(1);
  }

  let tasks: ReturnType<typeof parseTasksJsonl>;
  try {
    tasks = parseTasksJsonl(src);
  } catch (err) {
    console.error(
      `${c.red}Invalid tasks file: ${err instanceof Error ? err.message : String(err)}${c.reset}`,
    );
    process.exit(1);
  }

  if (tasks.length === 0) {
    console.log(`${c.yellow}No tasks found in ${inputPath}${c.reset}`);
    return;
  }

  console.log(
    `${c.bold}ethos batch${c.reset}  ${c.dim}${tasks.length} tasks · concurrency ${concurrency}${c.reset}`,
  );
  console.log(`${c.dim}  output     → ${outputPath}${c.reset}`);
  console.log(`${c.dim}  checkpoint → ${checkpointPath}${c.reset}\n`);

  const loop = await createAgentLoop(config);

  const runner = new BatchRunner(loop, {
    concurrency,
    outputPath,
    checkpointPath,
    defaultPersonalityId: config.personality,
  });

  const start = Date.now();
  let lastLine = '';

  const stats = await runner.run(tasks, (done, total) => {
    // Overwrite progress line in terminal
    const pct = Math.round((done / total) * 100);
    const line = `  ${done}/${total} (${pct}%)`;
    process.stdout.write(`\r${line.padEnd(lastLine.length + 2)}`);
    lastLine = line;
  });

  if (lastLine) process.stdout.write('\n');

  const elapsed = ((Date.now() - start) / 1000).toFixed(1);
  const failMark = stats.failed > 0 ? `${c.red}${stats.failed} failed${c.reset}  ` : '';
  const skipMark = stats.skipped > 0 ? `${c.dim}${stats.skipped} skipped${c.reset}  ` : '';

  console.log(
    `\n${c.green}✓${c.reset} ${c.bold}${stats.completed} completed${c.reset}  ${failMark}${skipMark}${c.dim}${elapsed}s${c.reset}`,
  );
  console.log(`${c.dim}output → ${outputPath}${c.reset}`);

  if (stats.failed > 0) process.exit(1);
}
