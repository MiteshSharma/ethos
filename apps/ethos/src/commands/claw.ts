import { createInterface } from 'node:readline';
import { ClawMigrator, type MigrateOptions, type MigrationPlan } from '@ethosagent/claw-migrate';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

interface ParsedFlags {
  dryRun: boolean;
  preset: 'all' | 'user-data';
  overwrite: boolean;
  yes: boolean;
}

export async function runClaw(args: string[]): Promise<void> {
  const sub = args[0] ?? '';
  if (sub !== 'migrate') {
    console.log('Usage: ethos claw migrate [--dry-run] [--preset user-data] [--overwrite] [--yes]');
    process.exit(sub === '' ? 0 : 1);
  }

  const flags = parseFlags(args.slice(1));
  const opts: MigrateOptions = {
    dryRun: flags.dryRun,
    preset: flags.preset,
    overwrite: flags.overwrite,
  };

  const migrator = new ClawMigrator(opts);

  if (!(await migrator.sourceExists())) {
    console.error(
      `${c.red}No OpenClaw install found at ${migrator.source}.${c.reset}\n${c.dim}Looking for ${migrator.source}/config.yaml — exiting without changes.${c.reset}`,
    );
    process.exit(1);
  }

  const plan = await migrator.plan();
  printPlanSummary(plan, flags);

  if (plan.ops.length === 0) {
    console.log(`${c.yellow}Nothing to migrate.${c.reset}`);
    return;
  }

  if (!flags.dryRun && !flags.yes) {
    const ok = await confirm(`${c.bold}Proceed with migration?${c.reset} [y/N] `);
    if (!ok) {
      console.log(`${c.dim}Cancelled.${c.reset}`);
      return;
    }
  }

  const result = await migrator.execute(plan);

  console.log();
  for (const item of result.items) {
    if (item.status === 'copied') {
      const verb = flags.dryRun ? 'would copy' : 'copied';
      console.log(`  ${c.green}✓ ${verb}${c.reset}  ${item.label}`);
    } else if (item.status === 'skipped') {
      console.log(
        `  ${c.yellow}⚠ skipped${c.reset}  ${item.label}${c.dim}  (${item.reason ?? 'unknown'})${c.reset}`,
      );
    } else {
      console.log(
        `  ${c.red}✗ failed${c.reset}   ${item.label}${c.dim}  (${item.reason ?? 'unknown'})${c.reset}`,
      );
    }
  }

  console.log();
  if (flags.dryRun) {
    console.log(
      `${c.dim}Dry run — no files written. Re-run without --dry-run to migrate.${c.reset}`,
    );
    return;
  }
  if (result.failed > 0) {
    console.log(
      `${c.yellow}Migration finished with ${result.failed} failure${result.failed === 1 ? '' : 's'}.${c.reset}`,
    );
  } else {
    console.log(
      `${c.green}Migration complete.${c.reset} Run \`ethos setup\` to verify your config.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFlags(args: string[]): ParsedFlags {
  let dryRun = false;
  let preset: 'all' | 'user-data' = 'all';
  let overwrite = false;
  let yes = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--dry-run') dryRun = true;
    else if (a === '--overwrite') overwrite = true;
    else if (a === '--yes' || a === '-y') yes = true;
    else if (a === '--preset') {
      const next = args[i + 1];
      if (next === 'user-data' || next === 'all') {
        preset = next;
        i += 1;
      } else {
        console.error(`Unknown preset: ${next}. Valid: 'all' | 'user-data'.`);
        process.exit(1);
      }
    } else {
      console.error(`Unknown flag: ${a}`);
      process.exit(1);
    }
  }
  return { dryRun, preset, overwrite, yes };
}

function printPlanSummary(plan: MigrationPlan, flags: ParsedFlags): void {
  console.log(`\n${c.bold}OpenClaw → Ethos migration plan${c.reset}`);
  console.log(`${c.dim}  source: ${c.reset}${plan.source}`);
  console.log(`${c.dim}  target: ${c.reset}${plan.target}`);
  if (plan.detected.agents) console.log(`${c.dim}  workspace: ${c.reset}${plan.workspace}`);
  console.log(
    `${c.dim}  preset: ${c.reset}${flags.preset}${flags.overwrite ? ` ${c.yellow}(--overwrite)${c.reset}` : ''}`,
  );
  console.log();
  console.log(
    `${c.dim}  ${plan.summary.memories} memory file${plural(plan.summary.memories)}, ${plan.summary.skills} skill${plural(plan.summary.skills)}, ${plan.summary.platformTokens} platform token${plural(plan.summary.platformTokens)}, ${plan.summary.apiKeys} API key${plural(plan.summary.apiKeys)}${c.reset}`,
  );
  if (plan.personality.becomesMigrated) {
    console.log(
      `${c.dim}  personality: ${c.reset}${c.cyan}migrated${c.reset}${c.dim} (from SOUL.md${plan.personality.requested ? `, was \`${plan.personality.requested}\`` : ''})${c.reset}`,
    );
  } else if (plan.personality.requested) {
    console.log(`${c.dim}  personality: ${c.reset}${c.cyan}${plan.personality.resolved}${c.reset}`);
  }
  console.log();
  console.log(`${c.bold}Operations:${c.reset}`);
  for (const op of plan.ops) {
    console.log(`  ${c.cyan}${op.kind.padEnd(22)}${c.reset} ${op.label}`);
  }
}

function plural(n: number): string {
  return n === 1 ? '' : 's';
}

async function confirm(prompt: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes');
    });
  });
}
