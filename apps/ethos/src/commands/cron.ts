import { CronScheduler, isValidCronExpression, nextRun } from '@ethosagent/cron';
import type { EthosConfig } from '../config';
import { createAgentLoop } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

function makeScheduler(config: EthosConfig): { scheduler: CronScheduler; cleanup: () => void } {
  let loop: Awaited<ReturnType<typeof createAgentLoop>> | null = null;

  const scheduler = new CronScheduler({
    runJob: async (job) => {
      if (!loop) loop = await createAgentLoop(config);
      const sessionKey = `cron:${job.id}:${new Date().toISOString()}`;
      let output = '';

      for await (const event of loop.run(job.prompt, {
        sessionKey,
        personalityId: job.personality ?? config.personality,
      })) {
        if (event.type === 'text_delta') output += event.text;
      }

      return { jobId: job.id, ranAt: new Date().toISOString(), output, sessionKey };
    },
  });

  return { scheduler, cleanup: () => scheduler.stop() };
}

export async function runCronCommand(
  sub: string,
  args: string[],
  config: EthosConfig,
): Promise<void> {
  switch (sub) {
    case 'list': {
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        const jobs = await scheduler.listJobs();
        if (jobs.length === 0) {
          console.log(`${c.dim}No cron jobs. Create one with: ethos cron create${c.reset}`);
          return;
        }
        console.log(`\n${c.bold}Cron jobs:${c.reset}\n`);
        for (const j of jobs) {
          const status =
            j.status === 'paused'
              ? `${c.yellow}⏸ paused${c.reset}`
              : `${c.green}▶ active${c.reset}`;
          const next = j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : 'not scheduled';
          console.log(`  ${c.bold}${j.name}${c.reset} ${c.dim}(${j.id})${c.reset} — ${status}`);
          console.log(`    Schedule : ${j.schedule}`);
          console.log(`    Next run : ${next}`);
          console.log(`    Prompt   : ${j.prompt.slice(0, 80)}${j.prompt.length > 80 ? '…' : ''}`);
          console.log();
        }
      } finally {
        cleanup();
      }
      break;
    }

    case 'create': {
      // ethos cron create --name "..." --schedule "..." --prompt "..." [--personality X] [--deliver Y]
      const params = parseFlags(args);
      const name = params.name ?? params.n;
      const schedule = params.schedule ?? params.s;
      const prompt = params.prompt ?? params.p;
      const personality = params.personality;
      const deliver = params.deliver;

      if (!name || !schedule || !prompt) {
        console.log(
          'Usage: ethos cron create --name "Job name" --schedule "0 8 * * *" --prompt "Your prompt"',
        );
        return;
      }

      if (!isValidCronExpression(schedule)) {
        console.log(`${c.red}Invalid cron expression: "${schedule}"${c.reset}`);
        console.log(`${c.dim}Example: "0 8 * * 1-5" (weekdays at 8am)${c.reset}`);
        return;
      }

      const { scheduler, cleanup } = makeScheduler(config);
      try {
        const job = await scheduler.createJob({
          name,
          schedule,
          prompt,
          personality,
          deliver,
          missedRunPolicy: 'skip',
        });
        const next = nextRun(schedule);
        console.log(`${c.green}✓ Created "${job.name}" (${job.id})${c.reset}`);
        if (next) console.log(`${c.dim}Next run: ${next.toLocaleString()}${c.reset}`);
      } finally {
        cleanup();
      }
      break;
    }

    case 'pause': {
      const id = args[0];
      if (!id) {
        console.log('Usage: ethos cron pause <id>');
        return;
      }
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        await scheduler.pauseJob(id);
        console.log(`${c.green}✓ Paused "${id}"${c.reset}`);
      } catch (err) {
        console.log(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      } finally {
        cleanup();
      }
      break;
    }

    case 'resume': {
      const id = args[0];
      if (!id) {
        console.log('Usage: ethos cron resume <id>');
        return;
      }
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        await scheduler.resumeJob(id);
        console.log(`${c.green}✓ Resumed "${id}"${c.reset}`);
      } catch (err) {
        console.log(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      } finally {
        cleanup();
      }
      break;
    }

    case 'delete': {
      const id = args[0];
      if (!id) {
        console.log('Usage: ethos cron delete <id>');
        return;
      }
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        await scheduler.deleteJob(id);
        console.log(`${c.green}✓ Deleted "${id}"${c.reset}`);
      } catch (err) {
        console.log(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      } finally {
        cleanup();
      }
      break;
    }

    case 'run': {
      const id = args[0];
      if (!id) {
        console.log('Usage: ethos cron run <id>');
        return;
      }
      const { scheduler, cleanup } = makeScheduler(config);
      try {
        console.log(`${c.dim}Running job "${id}"...${c.reset}`);
        const result = await scheduler.runJobNow(id);
        console.log(`\n${result.output}`);
      } catch (err) {
        console.log(`${c.red}${err instanceof Error ? err.message : String(err)}${c.reset}`);
      } finally {
        cleanup();
      }
      break;
    }

    default:
      console.log('Usage: ethos cron [list | create | pause | resume | delete | run]');
  }
}

function parseFlags(args: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        result[key] = val;
        i++;
      }
    } else if (arg?.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1);
      const val = args[i + 1];
      if (val && !val.startsWith('-')) {
        result[key] = val;
        i++;
      }
    }
  }
  return result;
}
