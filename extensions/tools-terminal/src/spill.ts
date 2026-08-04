import { join } from 'node:path';
import type { Storage, ToolContext } from '@ethosagent/types';

/**
 * Truncation spill for terminal output.
 *
 * `ToolRegistry.executeParallel` trims an oversized *successful* result to
 * `ctx.resultBudgetChars` and appends a `[truncated — N chars total]` marker;
 * the cut content is gone. The non-zero-exit path returns `ok: false` with the
 * output inside `error`, which is not trimmed at all — that one floods context
 * unbounded. Both paths route through here.
 *
 * The threshold is `ctx.resultBudgetChars`, NOT the tool's `maxResultChars`:
 * the registry hands the tool `min(resultBudgetChars / callCount,
 * maxResultChars)`, so with parallel tool calls the real cap is well under
 * 20k and only the context value knows it.
 *
 * The spill goes through `ctx.storage` — a `ScopedStorage` carrying the
 * personality's write allowlist — so a contained personality cannot use
 * truncation spill as a side channel to stage data outside its boundary. If
 * the write is refused (BoundaryError) or no storage is wired, the caller
 * gets head + tail with no path and no file is created: a path the agent
 * cannot read back is worse than no path at all.
 */

/** Spill directory, relative to the agent working directory. */
const SPILL_DIR_SEGMENTS = ['.ethos', 'terminal-spill'];

/** Spill files older than this are removed on the next spill write. */
const SPILL_TTL_MS = 24 * 60 * 60 * 1000;

/** Share of the inline budget given to the head of the output. */
const HEAD_SHARE = 0.6;

/**
 * Chars reserved for the `Command exited with error (code N):\n` wrapper on
 * the failure path, so the assembled `error` string still lands in budget.
 */
export const ERROR_WRAPPER_RESERVE = 64;

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Best-effort housekeeping: drop spill files older than the TTL. */
async function pruneSpills(storage: Storage, dir: string): Promise<void> {
  const cutoff = Date.now() - SPILL_TTL_MS;
  try {
    const entries = await storage.listEntries(dir);
    for (const entry of entries) {
      if (entry.isDir || !entry.name.endsWith('.log')) continue;
      const path = join(dir, entry.name);
      const mtime = await storage.mtime(path);
      if (mtime !== null && mtime < cutoff) await storage.remove(path);
    }
  } catch {
    // Never fail a spill because an old file could not be listed or removed.
    return;
  }
}

/** Write the full output to the spill directory. Returns null when refused. */
async function writeSpill(text: string, ctx: ToolContext): Promise<string | null> {
  const storage = ctx.storage;
  if (!storage) return null;

  const dir = join(ctx.workingDir, ...SPILL_DIR_SEGMENTS);
  try {
    await storage.mkdir(dir);
    await pruneSpills(storage, dir);
    const session = ctx.sessionId.replace(/[^A-Za-z0-9_-]/g, '_');
    const path = join(dir, `${session}-${Date.now()}-${randomSuffix()}.log`);
    await storage.write(path, text);
    return path;
  } catch {
    // BoundaryError (spill target outside the personality's write reach) or
    // any other storage failure: degrade to head + tail with no path.
    return null;
  }
}

/**
 * Return `text` unchanged when it fits the budget. Otherwise spill the full
 * output to a file and return head + tail plus a notice — including the spill
 * path only when the write actually succeeded.
 */
export async function spillOversizedOutput(
  text: string,
  ctx: ToolContext,
  reserveChars = 0,
): Promise<string> {
  const budget = ctx.resultBudgetChars - reserveChars;
  if (!Number.isFinite(budget) || budget <= 0 || text.length <= budget) return text;

  const spillPath = await writeSpill(text, ctx);
  const notice = spillPath
    ? `\n\n[truncated — ${text.length} chars total; full output written to ${spillPath} — use read_file to see the rest]\n\n`
    : `\n\n[truncated — ${text.length} chars total; the remainder could not be written to a spill file]\n\n`;

  const available = budget - notice.length;
  if (available <= 0) return text.slice(0, budget);

  const headLen = Math.max(1, Math.floor(available * HEAD_SHARE));
  const tailLen = available - headLen;
  const head = text.slice(0, headLen);
  const tail = tailLen > 0 ? text.slice(text.length - tailLen) : '';
  return head + notice + tail;
}
