import { type CronJob, type CronScheduler, isValidCronExpression, nextRun } from '@ethosagent/cron';
import type { Tool, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCronTools(scheduler: CronScheduler): Tool[] {
  return [
    createJobTool(scheduler),
    listJobsTool(scheduler),
    deleteJobTool(scheduler),
    pauseJobTool(scheduler),
    resumeJobTool(scheduler),
    runJobNowTool(scheduler),
  ];
}

// ---------------------------------------------------------------------------
// create_cron_job
// ---------------------------------------------------------------------------

function createJobTool(scheduler: CronScheduler): Tool {
  return {
    name: 'create_cron_job',
    description:
      'Schedule a recurring task. The agent will run the given prompt automatically on the cron schedule and save the output.',
    toolset: 'cron',
    schema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable name for the job (e.g. "Morning Briefing")',
        },
        schedule: {
          type: 'string',
          description:
            'Standard 5-field cron expression (e.g. "0 8 * * 1-5" for weekdays at 8am). All times are local.',
        },
        prompt: { type: 'string', description: 'The prompt the agent will run on each execution' },
        personality: {
          type: 'string',
          description: 'Personality to use (default: current personality)',
        },
        deliver: {
          type: 'string',
          description: 'Where to deliver the output: "telegram", "cli"',
        },
        missed_run_policy: {
          type: 'string',
          enum: ['run-once', 'skip'],
          description:
            '"run-once" runs the missed job on next start. "skip" waits for the next scheduled time. Default: skip',
        },
      },
      required: ['name', 'schedule', 'prompt'],
    },
    async execute(args): Promise<ToolResult> {
      const { name, schedule, prompt, personality, deliver, missed_run_policy } = args as {
        name: string;
        schedule: string;
        prompt: string;
        personality?: string;
        deliver?: string;
        missed_run_policy?: 'run-once' | 'skip';
      };

      if (!name) return { ok: false, error: 'name is required', code: 'input_invalid' };
      if (!schedule) return { ok: false, error: 'schedule is required', code: 'input_invalid' };
      if (!prompt) return { ok: false, error: 'prompt is required', code: 'input_invalid' };

      if (!isValidCronExpression(schedule)) {
        return {
          ok: false,
          error: `Invalid cron expression: "${schedule}". Example: "0 8 * * 1-5" for weekdays at 8am.`,
          code: 'input_invalid',
        };
      }

      try {
        const job = await scheduler.createJob({
          name,
          schedule,
          prompt,
          personality,
          deliver,
          missedRunPolicy: missed_run_policy ?? 'skip',
        });

        const next = nextRun(schedule);
        const nextStr = next ? next.toLocaleString() : 'unknown';

        return {
          ok: true,
          value: `✓ Created job "${job.name}" (id: ${job.id})\nSchedule: ${schedule}\nNext run: ${nextStr}`,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// list_cron_jobs
// ---------------------------------------------------------------------------

function listJobsTool(scheduler: CronScheduler): Tool {
  return {
    name: 'list_cron_jobs',
    description: 'List all scheduled cron jobs with their status and next run time.',
    toolset: 'cron',
    schema: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      const jobs = await scheduler.listJobs();

      if (jobs.length === 0) {
        return { ok: true, value: 'No cron jobs scheduled. Use create_cron_job to add one.' };
      }

      const lines = jobs.map((j) => formatJob(j));
      return {
        ok: true,
        value: `${jobs.length} cron job${jobs.length === 1 ? '' : 's'}:\n\n${lines.join('\n\n')}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// delete_cron_job
// ---------------------------------------------------------------------------

function deleteJobTool(scheduler: CronScheduler): Tool {
  return {
    name: 'delete_cron_job',
    description: 'Permanently delete a cron job.',
    toolset: 'cron',
    schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Job id (from list_cron_jobs)' },
      },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id } = args as { id: string };
      if (!id) return { ok: false, error: 'id is required', code: 'input_invalid' };

      try {
        await scheduler.deleteJob(id);
        return { ok: true, value: `✓ Deleted job "${id}"` };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// pause_cron_job / resume_cron_job
// ---------------------------------------------------------------------------

function pauseJobTool(scheduler: CronScheduler): Tool {
  return {
    name: 'pause_cron_job',
    description: 'Pause a cron job without deleting it. Resumable with resume_cron_job.',
    toolset: 'cron',
    schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Job id' } },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id } = args as { id: string };
      try {
        await scheduler.pauseJob(id);
        return { ok: true, value: `✓ Paused job "${id}"` };
      } catch (err) {
        return { ok: false, error: String(err), code: 'execution_failed' };
      }
    },
  };
}

function resumeJobTool(scheduler: CronScheduler): Tool {
  return {
    name: 'resume_cron_job',
    description: 'Resume a paused cron job.',
    toolset: 'cron',
    schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Job id' } },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id } = args as { id: string };
      try {
        await scheduler.resumeJob(id);
        return { ok: true, value: `✓ Resumed job "${id}"` };
      } catch (err) {
        return { ok: false, error: String(err), code: 'execution_failed' };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// run_cron_job_now
// ---------------------------------------------------------------------------

function runJobNowTool(scheduler: CronScheduler): Tool {
  return {
    name: 'run_cron_job_now',
    description: 'Run a cron job immediately, outside its normal schedule.',
    toolset: 'cron',
    maxResultChars: 10_000,
    schema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Job id' } },
      required: ['id'],
    },
    async execute(args): Promise<ToolResult> {
      const { id } = args as { id: string };
      try {
        const result = await scheduler.runJobNow(id);
        return {
          ok: true,
          value: `✓ Ran job "${id}"\n\nOutput:\n${result.output}`,
        };
      } catch (err) {
        return { ok: false, error: String(err), code: 'execution_failed' };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatJob(j: CronJob): string {
  const status = j.status === 'paused' ? '⏸ paused' : '▶ active';
  const next = j.nextRunAt ? new Date(j.nextRunAt).toLocaleString() : 'not scheduled';
  const last = j.lastRunAt ? new Date(j.lastRunAt).toLocaleString() : 'never';
  return [
    `**${j.name}** (${j.id})`,
    `  Status:      ${status}`,
    `  Schedule:    ${j.schedule}`,
    `  Personality: ${j.personality ?? 'default'}`,
    `  Next run:    ${next}`,
    `  Last run:    ${last}`,
    `  Missed runs: ${j.missedRunPolicy}`,
  ].join('\n');
}
