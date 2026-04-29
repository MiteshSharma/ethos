import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Cron } from 'croner';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MissedRunPolicy = 'run-once' | 'skip';
export type JobStatus = 'active' | 'paused';

export interface CronJob {
  id: string;
  name: string;
  /** Standard 5-field cron expression e.g. "0 8 * * 1-5" */
  schedule: string;
  prompt: string;
  personality?: string;
  /** Delivery target: "telegram", "cli", etc. */
  deliver?: string;
  status: JobStatus;
  missedRunPolicy: MissedRunPolicy;
  lastRunAt?: string;
  nextRunAt?: string;
  createdAt: string;
}

export interface CronRunResult {
  jobId: string;
  ranAt: string;
  output: string;
  sessionKey: string;
}

export interface CronSchedulerConfig {
  /** Called when a job fires. Returns the text output and session key. */
  runJob: (job: CronJob) => Promise<CronRunResult>;
  /** Directory for jobs.json and output files. Defaults to ~/.ethos/cron/ */
  cronDir?: string;
  /** Tick interval in ms. Default 60_000 (1 min). */
  tickIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// File helpers with advisory file locking
// ---------------------------------------------------------------------------

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  let lockFd: Awaited<ReturnType<typeof open>> | null = null;
  const start = Date.now();

  while (Date.now() - start < 5_000) {
    try {
      lockFd = await open(lockPath, 'wx'); // exclusive create — atomic
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 100)); // wait and retry
    }
  }

  if (!lockFd) throw new Error(`Could not acquire lock: ${lockPath}`);

  try {
    return await fn();
  } finally {
    await lockFd.close();
    await unlink(lockPath).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// CronScheduler
// ---------------------------------------------------------------------------

export class CronScheduler {
  private readonly cronDir: string;
  private readonly jobsPath: string;
  private readonly lockPath: string;
  private readonly outputDir: string;
  private readonly runJob: (job: CronJob) => Promise<CronRunResult>;
  private readonly tickIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: CronSchedulerConfig) {
    this.cronDir = config.cronDir ?? join(homedir(), '.ethos', 'cron');
    this.jobsPath = join(this.cronDir, 'jobs.json');
    this.lockPath = join(this.cronDir, 'jobs.json.lock');
    this.outputDir = join(this.cronDir, 'output');
    this.runJob = config.runJob;
    this.tickIntervalMs = config.tickIntervalMs ?? 60_000;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  start(): void {
    void this.tick(); // check immediately on start (handles missed runs)
    this.timer = setInterval(() => void this.tick(), this.tickIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Job management (used by tools-cron and CLI)
  // ---------------------------------------------------------------------------

  async createJob(
    params: Omit<CronJob, 'id' | 'createdAt' | 'nextRunAt' | 'status'>,
  ): Promise<CronJob> {
    if (!isValidCronExpression(params.schedule)) {
      throw new Error(`Invalid cron expression: "${params.schedule}"`);
    }

    const job: CronJob = {
      ...params,
      id: slugify(params.name),
      status: 'active',
      missedRunPolicy: params.missedRunPolicy ?? 'skip',
      nextRunAt: nextRun(params.schedule)?.toISOString(),
      createdAt: new Date().toISOString(),
    };

    await this.withJobsLock(async (jobs) => {
      if (jobs.find((j) => j.id === job.id)) {
        throw new Error(`Job with id "${job.id}" already exists`);
      }
      jobs.push(job);
      return jobs;
    });

    return job;
  }

  async listJobs(): Promise<CronJob[]> {
    return this.readJobs();
  }

  async getJob(id: string): Promise<CronJob | null> {
    const jobs = await this.readJobs();
    return jobs.find((j) => j.id === id) ?? null;
  }

  async deleteJob(id: string): Promise<void> {
    await this.withJobsLock(async (jobs) => {
      const filtered = jobs.filter((j) => j.id !== id);
      if (filtered.length === jobs.length) throw new Error(`Job not found: ${id}`);
      return filtered;
    });
  }

  async pauseJob(id: string): Promise<void> {
    await this.patchJob(id, { status: 'paused' });
  }

  async resumeJob(id: string): Promise<void> {
    await this.patchJob(id, {
      status: 'active',
      nextRunAt: nextRun(await this.getSchedule(id))?.toISOString(),
    });
  }

  async runJobNow(id: string): Promise<CronRunResult> {
    const job = await this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return this.executeJob(job);
  }

  // ---------------------------------------------------------------------------
  // Tick — called every minute
  // ---------------------------------------------------------------------------

  private async tick(): Promise<void> {
    const now = new Date();
    let jobs: CronJob[];

    try {
      jobs = await this.readJobs();
    } catch {
      return; // jobs.json doesn't exist yet
    }

    for (const job of jobs) {
      if (job.status !== 'active' || !job.nextRunAt) continue;

      const due = new Date(job.nextRunAt);
      if (now < due) continue;

      // Missed run handling
      if (job.missedRunPolicy === 'skip') {
        // Don't run the missed job, just update nextRunAt to the next future time
        const upcoming = nextRunAfter(job.schedule, now);
        await this.patchJob(job.id, { nextRunAt: upcoming?.toISOString() }).catch(() => {});
        continue;
      }

      // run-once: claim the job by advancing nextRunAt BEFORE executing.
      // If the patch fails (lock contention, disk error), we skip this tick
      // — better than double-firing because the schedule never advanced.
      const upcoming = nextRunAfter(job.schedule, now);
      try {
        await this.patchJob(job.id, {
          lastRunAt: now.toISOString(),
          nextRunAt: upcoming?.toISOString(),
        });
      } catch (err) {
        console.error(`[cron] Could not claim job "${job.id}", skipping tick:`, err);
        continue;
      }

      await this.executeJob(job).catch((err) => {
        console.error(`[cron] Job "${job.id}" failed:`, err);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Execution
  // ---------------------------------------------------------------------------

  private async executeJob(job: CronJob): Promise<CronRunResult> {
    const result = await this.runJob(job);

    // Persist output to ~/.ethos/cron/output/<id>/<timestamp>.md
    const ts = result.ranAt.replace(/[:.]/g, '-').replace('Z', 'Z');
    const outPath = join(this.outputDir, job.id, `${ts}.md`);
    await mkdir(dirname(outPath), { recursive: true });
    await writeFile(outPath, `# ${job.name}\n\n${result.output}\n`, 'utf-8');

    return result;
  }

  // ---------------------------------------------------------------------------
  // Storage helpers
  // ---------------------------------------------------------------------------

  private async readJobs(): Promise<CronJob[]> {
    try {
      const raw = await readFile(this.jobsPath, 'utf-8');
      return JSON.parse(raw) as CronJob[];
    } catch {
      return [];
    }
  }

  private async writeJobs(jobs: CronJob[]): Promise<void> {
    await mkdir(this.cronDir, { recursive: true });
    await writeFile(this.jobsPath, JSON.stringify(jobs, null, 2), 'utf-8');
  }

  private async withJobsLock(fn: (jobs: CronJob[]) => Promise<CronJob[]>): Promise<void> {
    await withLock(this.lockPath, async () => {
      const jobs = await this.readJobs();
      const updated = await fn(jobs);
      await this.writeJobs(updated);
    });
  }

  private async patchJob(id: string, patch: Partial<CronJob>): Promise<void> {
    await this.withJobsLock(async (jobs) => {
      const idx = jobs.findIndex((j) => j.id === id);
      const existing = idx >= 0 ? jobs[idx] : undefined;
      if (!existing) throw new Error(`Job not found: ${id}`);
      jobs[idx] = { ...existing, ...patch };
      return jobs;
    });
  }

  private async getSchedule(id: string): Promise<string> {
    const job = await this.getJob(id);
    if (!job) throw new Error(`Job not found: ${id}`);
    return job.schedule;
  }
}

// ---------------------------------------------------------------------------
// Cron expression helpers
// ---------------------------------------------------------------------------

export function isValidCronExpression(expr: string): boolean {
  try {
    new Cron(expr, { maxRuns: 1 });
    return true;
  } catch {
    return false;
  }
}

/** Next scheduled run from now. */
export function nextRun(schedule: string): Date | null {
  try {
    return new Cron(schedule).nextRun() ?? null;
  } catch {
    return null;
  }
}

/** Next scheduled run strictly after a given date. */
export function nextRunAfter(schedule: string, after: Date): Date | null {
  try {
    return new Cron(schedule).nextRun(after) ?? null;
  } catch {
    return null;
  }
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64);
}
