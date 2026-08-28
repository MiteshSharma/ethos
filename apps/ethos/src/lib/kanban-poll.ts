import { KanbanStore } from '@ethosagent/kanban-store';
import type { SessionLane } from '@ethosagent/session-lane';
import type { AgentEvent } from '@ethosagent/types';

const DEFAULT_INTERVAL_MS = 5_000;
const DEFAULT_STALENESS_THRESHOLD_MS = 1_800_000;

/**
 * Discount a pause from the board's staleness clocks (gates #6/#7 of
 * plan/phases/clock-tolerance-pass.md), returning the number of rows corrected.
 *
 * Lives here rather than in `serve.ts` because this file owns both halves of the
 * problem: `DEFAULT_STALENESS_THRESHOLD_MS` above is the 30-minute window a
 * resumed process would otherwise blow straight through, and `tick()` below is
 * what would then reclaim a healthy task and burn a retry against its
 * `max_retries` budget. Opened and closed per call, exactly as `tick()` does —
 * the loop reopens the board every interval, so there is no long-lived handle to
 * reuse and holding one across a pause would add a second writer.
 */
export function bumpKanbanHeartbeats(boardPath: string, pauseDurationMs: number): number {
  const store = new KanbanStore(boardPath);
  try {
    return store.bumpActiveHeartbeats(pauseDurationMs);
  } finally {
    store.close();
  }
}

export interface KanbanPollConfig {
  /** Path to the board SQLite file. */
  boardPath: string;
  /** Personality ID to match against `assignee`. */
  personalityId: string;
  /** SessionLane to enqueue stimuli through. */
  lane: SessionLane;
  /** Runner to execute the stimulus prompt. */
  runner: (prompt: string, sessionKey: string, taskId: string, taskTitle: string) => Promise<void>;
  /** Poll interval. Default 5000ms. */
  intervalMs?: number;
  /** Optional error callback. */
  onError?: (err: Error) => void;
}

export class KanbanPollLoop {
  private readonly cfg: Required<
    Pick<KanbanPollConfig, 'boardPath' | 'personalityId' | 'intervalMs'>
  > &
    KanbanPollConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(config: KanbanPollConfig) {
    this.cfg = {
      ...config,
      intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
    };
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (err) {
        this.cfg.onError?.(err instanceof Error ? err : new Error(String(err)));
      }
      if (this.running) {
        this.timer = setTimeout(loop, this.cfg.intervalMs);
      }
    };
    void loop();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async tick(): Promise<void> {
    const store = new KanbanStore(this.cfg.boardPath);
    try {
      // Housekeeping — idempotent, safe to run from multiple serves
      store.promoteReady('poll-housekeeping');
      store.promoteScheduled(Date.now(), 'poll-housekeeping');
      store.rollupCompletedGoals('poll-housekeeping');

      // Reclaim stale running tasks
      for (const task of store.findStaleRunningTasks(DEFAULT_STALENESS_THRESHOLD_MS)) {
        try {
          store.reclaimTask(task.id, 'orphan_stale', 'poll-housekeeping');
        } catch {
          // Race: another writer handled it
        }
      }

      // Check for ready tasks assigned to this personality
      const readyTasks = store
        .listTasks({ status: 'ready' })
        .filter((t) => t.assignee === this.cfg.personalityId);

      for (const task of readyTasks) {
        // Atomically claim ready -> running before dispatch. This both moves the
        // task into progress and prevents the next tick from re-notifying it
        // (the status filter is 'ready'). If another writer already claimed it,
        // skip gracefully.
        try {
          store.updateStatus(
            task.id,
            'running',
            'claimed via poll dispatch',
            this.cfg.personalityId,
          );
        } catch (err) {
          this.cfg.onError?.(err instanceof Error ? err : new Error(String(err)));
          continue;
        }

        const prompt =
          `You have been assigned kanban task ${task.id}: "${task.title}". ${task.body}\n` +
          'The task is now in progress (running). Use your tools to complete the work. ' +
          'When finished, call kanban_complete with a short summary. ' +
          'If you are blocked, call kanban_block with the reason. ' +
          'For long-running work, call kanban_heartbeat periodically.';
        const sessionKey = `poll:kanban:${task.id}:${Date.now()}`;
        void this.cfg.lane.enqueue(async () => {
          await this.cfg.runner(prompt, sessionKey, task.id, task.title).catch((err) => {
            this.cfg.onError?.(err instanceof Error ? err : new Error(String(err)));
          });
        });
      }
    } finally {
      store.close();
    }
  }
}

const ARG_PREVIEW_CAP = 500;
const ERROR_CAP = 500;

function truncate(s: string, cap: number): string {
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

/**
 * Drive an agent event stream, writing the agent's activity into the task as
 * comments authored by `author` (the personalityId). Opens one short-lived
 * KanbanStore for the whole run and closes it in a finally — the poll loop's
 * own store is already closed by the time the runner executes, so the runner
 * MUST open its own handle keyed by boardPath. WAL allows concurrent writers.
 * Each comment write is wrapped so a write failure never aborts the run.
 */
export async function writeRunActivityComments(
  boardPath: string,
  taskId: string,
  author: string,
  events: AsyncIterable<AgentEvent>,
  onError?: (err: Error) => void,
): Promise<void> {
  const store = new KanbanStore(boardPath);
  const addComment = (body: string): void => {
    try {
      store.addComment(taskId, author, body);
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error(String(err)));
    }
  };
  try {
    let finalText = '';
    for await (const event of events) {
      if (event.type === 'text_delta') {
        finalText += event.text;
      } else if (event.type === 'tool_start') {
        const argsJson = (() => {
          try {
            return JSON.stringify(event.args);
          } catch {
            return '';
          }
        })();
        addComment(`🔧 ${event.toolName}(${truncate(argsJson, ARG_PREVIEW_CAP)})`);
      } else if (event.type === 'error') {
        addComment(`⚠️ error: ${truncate(event.error, ERROR_CAP)}`);
      } else if (event.type === 'done') {
        if (event.text && event.text.length > 0) finalText = event.text;
      }
    }
    const trimmed = finalText.trim();
    if (trimmed.length > 0) {
      addComment(trimmed);
    }
  } finally {
    store.close();
  }
}
