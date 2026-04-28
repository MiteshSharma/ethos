import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CronRun } from '@ethosagent/web-contracts';

// File-backed view of cron run history. The CronScheduler persists each
// run's output as `<cronDir>/output/<jobId>/<ISO-timestamp>.md`. This
// repository reads that directory tree and maps it into the wire-shape
// `CronRun[]`. Job CRUD lives in the CronScheduler itself; we only own
// the history fan-out here so the service can stay focused on
// orchestrating the scheduler with output reads.

export interface CronRepositoryOptions {
  /** Root cron directory — `~/.ethos/cron/` by default. */
  cronDir: string;
}

export class CronRepository {
  private readonly outputDir: string;

  constructor(opts: CronRepositoryOptions) {
    this.outputDir = join(opts.cronDir, 'output');
  }

  /**
   * List run-output files for `jobId`, newest first. Returns at most
   * `limit` entries (default 20). The `output` body is left null —
   * callers that want to render output fetch it via `loadOutput`.
   */
  async listRuns(jobId: string, limit = 20): Promise<CronRun[]> {
    const dir = join(this.outputDir, jobId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return []; // job has never run
    }
    return names
      .filter((n) => n.endsWith('.md'))
      .map((name) => ({
        ranAt: filenameToIso(name),
        outputPath: join(dir, name),
        output: null,
      }))
      .sort((a, b) => (a.ranAt < b.ranAt ? 1 : -1))
      .slice(0, limit);
  }

  /** Read the full output body for a single run. */
  async loadOutput(outputPath: string): Promise<string> {
    return readFile(outputPath, 'utf-8');
  }
}

/**
 * The scheduler writes filenames like `2026-04-28T17-06-37-123Z.md`
 * (the original ISO with `:` and `.` replaced by `-`). This reverses
 * that mapping so the wire timestamp is a proper ISO-8601 string. If
 * the filename doesn't match the pattern, fall back to the raw stem.
 */
function filenameToIso(filename: string): string {
  const stem = filename.replace(/\.md$/, '');
  // Match YYYY-MM-DDTHH-mm-ss-SSSZ — everything after T uses `-` for
  // both `:` and `.`. The first two `-` after T are colons; the third
  // is the millisecond separator.
  const m = stem.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})(Z?)$/);
  if (!m) return stem;
  const [, date, hh, mm, ss, ms, z] = m;
  return `${date}T${hh}:${mm}:${ss}.${ms}${z ?? ''}`;
}
