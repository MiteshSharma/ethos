import { existsSync, readdirSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentMesh } from '@ethosagent/agent-mesh';
import {
  KanbanStore,
  type Task,
  type TaskComment,
  type TaskEvent,
  type TaskRun,
  type TeamMemberStats,
} from '@ethosagent/kanban-store';
import {
  parseTeamManifest,
  readRuntimeFrom,
  type TeamRuntime,
  teamsDir,
} from '@ethosagent/team-supervisor';
import type { HookRegistry } from '@ethosagent/types';
import type {
  KanbanBoardSnapshot,
  KanbanComment,
  KanbanEvent,
  KanbanLink,
  KanbanMemberStats,
  KanbanRun,
  KanbanTask,
  KanbanTaskStatus,
  KanbanTeamSummary,
} from '@ethosagent/web-contracts';

// Kanban service. Lightweight — opens the team's `~/.ethos/teams/<name>/board.db`
// per request, queries it, and shapes rows into wire-format. We do NOT keep a
// long-lived KanbanStore handle here: the team supervisor owns the writer, and
// SQLite WAL lets us read alongside it safely as long as we open/close cleanly.

const RECENT_EVENTS_CAP = 100;

const GLOBAL_BOARD_NAME = 'global';

function resolveBoard(rootDir: string, team: string): string {
  if (team === GLOBAL_BOARD_NAME) {
    // Global board lives at ~/.ethos/board.db, one level above the teams dir
    return join(rootDir, '..', 'board.db');
  }
  return join(rootDir, team, 'board.db');
}

export interface KanbanServiceOptions {
  /** Override the teams directory (testing). Defaults to `~/.ethos/teams`. */
  teamsDir?: string;
  /** Mesh for agent discovery (listAgents, /notify on assign). */
  mesh?: AgentMesh;
  /**
   * Fires `ticket_updated` (Void, fail-open) on human-driven assignee
   * changes. Optional — a service built without one fires zero hooks,
   * matching today's exact behavior.
   */
  hooks?: HookRegistry;
}

export class KanbanService {
  private readonly rootDir: string;
  private readonly mesh: AgentMesh | undefined;
  private readonly hooks: HookRegistry | undefined;

  constructor(opts: KanbanServiceOptions = {}) {
    this.rootDir = opts.teamsDir ?? teamsDir();
    this.mesh = opts.mesh;
    this.hooks = opts.hooks;
  }

  /** Enumerate teams from the manifests on disk; merge in runtime status. */
  async list(): Promise<{ teams: KanbanTeamSummary[] }> {
    const teams: KanbanTeamSummary[] = [];

    // Enumerate team boards from manifests on disk
    if (existsSync(this.rootDir)) {
      const entries = readdirSync(this.rootDir, { withFileTypes: true });
      const manifestFiles = entries
        .filter((e) => e.isFile() && e.name.endsWith('.yaml'))
        .map((e) => e.name.replace(/\.yaml$/, ''));

      for (const name of manifestFiles) {
        const manifestPath = join(this.rootDir, `${name}.yaml`);
        try {
          const src = await readFile(manifestPath, 'utf-8');
          const manifest = parseTeamManifest(src);
          const runtime = readRuntimeFrom(this.rootDir, name);
          teams.push(toTeamSummary(name, manifest.description, manifest, runtime, this.rootDir));
        } catch {
          // Malformed manifest — skip rather than poison the list.
        }
      }
    }

    // Always include the global board so the UI is usable before the first task.
    const globalBoardPath = join(this.rootDir, '..', 'board.db');
    const globalModifiedAt = existsSync(globalBoardPath)
      ? new Date(statSync(globalBoardPath).mtimeMs).toISOString()
      : null;
    teams.unshift({
      name: GLOBAL_BOARD_NAME,
      description: 'Global kanban board',
      dispatchMode: 'self-routing',
      health: 'running',
      memberCount: 0,
      runningCount: 0,
      boardModifiedAt: globalModifiedAt,
    });

    return { teams };
  }

  /** Open the team board read-only, return a snapshot. */
  async getBoard(team: string): Promise<{ board: KanbanBoardSnapshot }> {
    if (team === GLOBAL_BOARD_NAME) return this.getGlobalBoard();
    assertSafeTeamName(team);
    const manifestPath = join(this.rootDir, `${team}.yaml`);
    if (!existsSync(manifestPath)) {
      throw new Error(`team not found: ${team}`);
    }
    const manifest = parseTeamManifest(await readFile(manifestPath, 'utf-8'));
    const runtime = readRuntimeFrom(this.rootDir, team);
    const summary = toTeamSummary(team, manifest.description, manifest, runtime, this.rootDir);

    const boardPath = join(this.rootDir, team, 'board.db');
    if (!existsSync(boardPath)) {
      // No board yet — return an empty snapshot rather than 404.
      return {
        board: {
          team: summary,
          tasks: [],
          links: [],
          recentEvents: [],
          memberStats: [],
        },
      };
    }

    // Open with the team name as `teamId` so `getMemberStats()` returns this
    // board's per-member outcome counters.
    const store = new KanbanStore(boardPath, { teamId: team });
    try {
      const tasks = store.listTasks({ limit: 1000 }).map(toWireTask);
      // Pull links straight from the underlying DB — store doesn't expose a
      // list method since callers usually want parent/child filtering instead.
      const linkRows = (
        store as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
      ).db
        .prepare('SELECT parent_id, child_id FROM task_links')
        .all() as Array<{ parent_id: string; child_id: string }>;
      const links: KanbanLink[] = linkRows.map((r) => ({
        parentId: r.parent_id,
        childId: r.child_id,
      }));

      // Recent events across the whole board, capped.
      const eventRows = (
        store as unknown as { db: { prepare: (s: string) => { all: (n: number) => unknown[] } } }
      ).db
        .prepare(
          'SELECT id, task_id, kind, actor, data_json, created_at FROM task_events ORDER BY id DESC LIMIT ?',
        )
        .all(RECENT_EVENTS_CAP) as Array<{
        id: number;
        task_id: string;
        kind: string;
        actor: string;
        data_json: string;
        created_at: number;
      }>;
      const recentEvents: KanbanEvent[] = eventRows.reverse().map((r) => ({
        id: r.id,
        taskId: r.task_id,
        kind: r.kind as KanbanEvent['kind'],
        actor: r.actor,
        data: JSON.parse(r.data_json) as Record<string, unknown>,
        createdAt: new Date(r.created_at).toISOString(),
      }));

      const memberStats: KanbanMemberStats[] = [...store.getMemberStats().values()].map(
        toWireMemberStats,
      );

      return {
        board: {
          team: summary,
          tasks,
          links,
          recentEvents,
          memberStats,
        },
      };
    } finally {
      store.close();
    }
  }

  private async getGlobalBoard(): Promise<{ board: KanbanBoardSnapshot }> {
    const boardPath = join(this.rootDir, '..', 'board.db');
    const summary: KanbanTeamSummary = {
      name: GLOBAL_BOARD_NAME,
      description: 'Global kanban board',
      dispatchMode: 'self-routing',
      health: 'running',
      memberCount: 0,
      runningCount: 0,
      boardModifiedAt: existsSync(boardPath)
        ? new Date(statSync(boardPath).mtimeMs).toISOString()
        : null,
    };

    if (!existsSync(boardPath)) {
      return {
        board: { team: summary, tasks: [], links: [], recentEvents: [], memberStats: [] },
      };
    }

    const store = new KanbanStore(boardPath);
    try {
      const tasks = store.listTasks({ limit: 1000 }).map(toWireTask);
      const linkRows = (
        store as unknown as { db: { prepare: (s: string) => { all: () => unknown[] } } }
      ).db
        .prepare('SELECT parent_id, child_id FROM task_links')
        .all() as Array<{ parent_id: string; child_id: string }>;
      const links: KanbanLink[] = linkRows.map((r) => ({
        parentId: r.parent_id,
        childId: r.child_id,
      }));
      const eventRows = (
        store as unknown as { db: { prepare: (s: string) => { all: (n: number) => unknown[] } } }
      ).db
        .prepare(
          'SELECT id, task_id, kind, actor, data_json, created_at FROM task_events ORDER BY id DESC LIMIT ?',
        )
        .all(RECENT_EVENTS_CAP) as Array<{
        id: number;
        task_id: string;
        kind: string;
        actor: string;
        data_json: string;
        created_at: number;
      }>;
      const recentEvents: KanbanEvent[] = eventRows.reverse().map((r) => ({
        id: r.id,
        taskId: r.task_id,
        kind: r.kind as KanbanEvent['kind'],
        actor: r.actor,
        data: JSON.parse(r.data_json) as Record<string, unknown>,
        createdAt: new Date(r.created_at).toISOString(),
      }));
      const memberStats: KanbanMemberStats[] = [...store.getMemberStats().values()].map(
        toWireMemberStats,
      );

      return {
        board: { team: summary, tasks, links, recentEvents, memberStats },
      };
    } finally {
      store.close();
    }
  }

  /**
   * Bounded tail of board events, ascending — the last `cap` rows in
   * `task_events`, same cap (`RECENT_EVENTS_CAP`) as `getBoard()`'s
   * `recentEvents`. Used for a COLD SSE connect (no real `Last-Event-ID`
   * cursor): replaying the entire table for a board with a long history is
   * strictly worse than the polling it replaced, so a cold connect gets the
   * recent tail instead. A genuine reconnect still uses `getEventsSince`
   * below and replays everything since its real cursor.
   */
  async getRecentEvents(team: string, cap: number = RECENT_EVENTS_CAP): Promise<KanbanEvent[]> {
    if (team !== GLOBAL_BOARD_NAME) assertSafeTeamName(team);
    const boardPath = resolveBoard(this.rootDir, team);
    if (!existsSync(boardPath)) return [];

    const store =
      team !== GLOBAL_BOARD_NAME
        ? new KanbanStore(boardPath, { teamId: team })
        : new KanbanStore(boardPath);
    try {
      const eventRows = (
        store as unknown as { db: { prepare: (s: string) => { all: (n: number) => unknown[] } } }
      ).db
        .prepare(
          'SELECT id, task_id, kind, actor, data_json, created_at FROM task_events ORDER BY id DESC LIMIT ?',
        )
        .all(cap) as Array<{
        id: number;
        task_id: string;
        kind: string;
        actor: string;
        data_json: string;
        created_at: number;
      }>;
      return eventRows.reverse().map((r) => ({
        id: r.id,
        taskId: r.task_id,
        kind: r.kind as KanbanEvent['kind'],
        actor: r.actor,
        data: JSON.parse(r.data_json) as Record<string, unknown>,
        createdAt: new Date(r.created_at).toISOString(),
      }));
    } finally {
      store.close();
    }
  }

  /**
   * Board events strictly after `afterId`, ascending — the resume-since-cursor
   * query behind the kanban SSE stream. Same `task_events` query as
   * `getBoard()`'s, but `WHERE id > ?` ascending instead of `ORDER BY id DESC
   * LIMIT ?`.
   */
  async getEventsSince(team: string, afterId: number): Promise<KanbanEvent[]> {
    if (team !== GLOBAL_BOARD_NAME) assertSafeTeamName(team);
    const boardPath = resolveBoard(this.rootDir, team);
    if (!existsSync(boardPath)) return [];

    const store =
      team !== GLOBAL_BOARD_NAME
        ? new KanbanStore(boardPath, { teamId: team })
        : new KanbanStore(boardPath);
    try {
      const eventRows = (
        store as unknown as { db: { prepare: (s: string) => { all: (n: number) => unknown[] } } }
      ).db
        .prepare(
          'SELECT id, task_id, kind, actor, data_json, created_at FROM task_events WHERE id > ? ORDER BY id ASC',
        )
        .all(afterId) as Array<{
        id: number;
        task_id: string;
        kind: string;
        actor: string;
        data_json: string;
        created_at: number;
      }>;
      return eventRows.map((r) => ({
        id: r.id,
        taskId: r.task_id,
        kind: r.kind as KanbanEvent['kind'],
        actor: r.actor,
        data: JSON.parse(r.data_json) as Record<string, unknown>,
        createdAt: new Date(r.created_at).toISOString(),
      }));
    } finally {
      store.close();
    }
  }

  /**
   * Human-initiated status update. Threads `human:<sessionLabel>` as the actor
   * so the audit trail clearly separates UI edits from agent actions. Honors
   * the same auto-cancel-on-leave-running semantics as agent calls.
   */
  async updateStatus(opts: {
    team: string;
    taskId: string;
    status: KanbanTaskStatus;
    reason?: string;
    actor: string;
  }): Promise<{ task: KanbanTask }> {
    if (opts.team !== GLOBAL_BOARD_NAME) assertSafeTeamName(opts.team);
    const boardPath = resolveBoard(this.rootDir, opts.team);
    if (!existsSync(boardPath)) {
      throw new Error(`team board not found: ${opts.team}`);
    }
    // Open with the team name as `teamId` so terminal transitions (failed,
    // needs_revision) recorded here update the same per-member stats ledger the
    // dispatcher writes through — keeping the ledger consistent regardless of
    // whether a human or an agent drove the transition.
    const store = new KanbanStore(boardPath, { teamId: opts.team });
    try {
      const updated = store.updateStatus(opts.taskId, opts.status, opts.reason, opts.actor);
      return { task: toWireTask(updated) };
    } finally {
      store.close();
    }
  }

  /**
   * Batch status update — one KanbanStore transaction for the whole set of
   * taskIds rather than looping the single-task RPC from the client.
   */
  async bulkUpdateStatus(opts: {
    team: string;
    taskIds: string[];
    status: KanbanTaskStatus;
    actor: string;
  }): Promise<{ tasks: KanbanTask[] }> {
    if (opts.team !== GLOBAL_BOARD_NAME) assertSafeTeamName(opts.team);
    const boardPath = resolveBoard(this.rootDir, opts.team);
    if (!existsSync(boardPath)) {
      throw new Error(`team board not found: ${opts.team}`);
    }
    const store = new KanbanStore(boardPath, { teamId: opts.team });
    try {
      const updated = store.bulkUpdateStatus(opts.taskIds, opts.status, opts.actor);
      return { tasks: updated.map(toWireTask) };
    } finally {
      store.close();
    }
  }

  /** Create a task on a team board. */
  async createTask(opts: {
    team: string;
    title: string;
    body?: string;
    priority?: number;
    assignee?: string;
    acceptanceCriteria?: string;
    actor: string;
  }): Promise<{ task: KanbanTask }> {
    if (opts.team !== GLOBAL_BOARD_NAME) assertSafeTeamName(opts.team);
    const boardPath = resolveBoard(this.rootDir, opts.team);
    const store = new KanbanStore(boardPath, { teamId: opts.team });
    try {
      const task = store.createTask({
        title: opts.title,
        body: opts.body,
        priority: opts.priority,
        assignee: opts.assignee,
        acceptanceCriteria: opts.acceptanceCriteria,
        actor: opts.actor,
      });
      return { task: toWireTask(task) };
    } finally {
      store.close();
    }
  }

  /** List agents subscribed to a team board via the mesh registry. */
  async listAgents(opts: { team: string }): Promise<{
    agents: Array<{
      personalityId: string;
      displayName: string;
      agentId: string;
      online: boolean;
    }>;
  }> {
    if (opts.team !== GLOBAL_BOARD_NAME) assertSafeTeamName(opts.team);
    if (!this.mesh) return { agents: [] };

    const entries = await this.mesh.list();
    const agents = entries
      .filter((e) => e.boardSubscriptions?.some((s) => s.board === opts.team))
      .map((e) => ({
        personalityId: e.personalityId ?? e.agentId,
        displayName: e.displayName ?? e.agentId,
        agentId: e.agentId,
        online: Date.now() - e.lastHeartbeatAt < 30_000,
      }));

    return { agents };
  }

  /** Assign a task and fire /notify to the assignee via mesh. */
  async assign(opts: {
    team: string;
    taskId: string;
    assignee: string;
    actor: string;
  }): Promise<{ task: KanbanTask }> {
    if (opts.team !== GLOBAL_BOARD_NAME) assertSafeTeamName(opts.team);
    const boardPath = resolveBoard(this.rootDir, opts.team);
    const store = new KanbanStore(boardPath, { teamId: opts.team });
    try {
      const task = store.assign(opts.taskId, opts.assignee, opts.actor);

      if (this.hooks) {
        await this.hooks.fireVoid('ticket_updated', {
          taskId: opts.taskId,
          changedFields: ['assignee'],
        });
      }

      // Fire /notify to the assignee via mesh — non-fatal on failure.
      if (this.mesh && task.status === 'ready') {
        void this.notifyAssignee(opts.assignee, task.id, 'kanban', opts.team).catch(() => {});
      }

      return { task: toWireTask(task) };
    } finally {
      store.close();
    }
  }

  /**
   * Batch reassign — one KanbanStore transaction for the whole set of
   * taskIds, firing the same non-fatal per-task /notify as assign().
   */
  async bulkAssign(opts: {
    team: string;
    taskIds: string[];
    assignee: string;
    actor: string;
  }): Promise<{ tasks: KanbanTask[] }> {
    if (opts.team !== GLOBAL_BOARD_NAME) assertSafeTeamName(opts.team);
    const boardPath = resolveBoard(this.rootDir, opts.team);
    const store = new KanbanStore(boardPath, { teamId: opts.team });
    try {
      const updated = store.bulkAssign(opts.taskIds, opts.assignee, opts.actor);

      for (const task of updated) {
        if (this.hooks) {
          await this.hooks.fireVoid('ticket_updated', {
            taskId: task.id,
            changedFields: ['assignee'],
          });
        }

        if (this.mesh && task.status === 'ready') {
          void this.notifyAssignee(opts.assignee, task.id, 'kanban', opts.team).catch(() => {});
        }
      }

      return { tasks: updated.map(toWireTask) };
    } finally {
      store.close();
    }
  }

  async getTask(opts: { team: string; taskId: string }): Promise<{
    task: KanbanTask;
    comments: KanbanComment[];
    runs: KanbanRun[];
  }> {
    if (opts.team !== GLOBAL_BOARD_NAME) assertSafeTeamName(opts.team);
    const boardPath = resolveBoard(this.rootDir, opts.team);
    if (!existsSync(boardPath)) {
      throw new Error(`team board not found: ${opts.team}`);
    }
    const store =
      opts.team !== GLOBAL_BOARD_NAME
        ? new KanbanStore(boardPath, { teamId: opts.team })
        : new KanbanStore(boardPath);
    try {
      const task = store.getTask(opts.taskId);
      if (!task) throw new Error(`task not found: ${opts.taskId}`);
      const comments = store.listComments(opts.taskId).map(toWireComment);
      const runs = store.listRuns(opts.taskId).map(toWireRun);
      return { task: toWireTask(task), comments, runs };
    } finally {
      store.close();
    }
  }

  async addComment(opts: { team: string; taskId: string; body: string }): Promise<{
    comment: KanbanComment;
  }> {
    if (opts.team !== GLOBAL_BOARD_NAME) assertSafeTeamName(opts.team);
    const boardPath = resolveBoard(this.rootDir, opts.team);
    if (!existsSync(boardPath)) {
      throw new Error(`team board not found: ${opts.team}`);
    }
    const store =
      opts.team !== GLOBAL_BOARD_NAME
        ? new KanbanStore(boardPath, { teamId: opts.team })
        : new KanbanStore(boardPath);
    let comment: TaskComment;
    let assignee: string | null;
    try {
      comment = store.addComment(opts.taskId, 'human:control-center', opts.body);
      assignee = store.getTask(opts.taskId)?.assignee ?? null;
    } finally {
      store.close();
    }
    // Best-effort notify recipients — the assignee plus any @-mentioned agents
    // in the comment body. Dedupe so a mentioned assignee is only pinged once.
    // Non-fatal on failure (network/offline agents are reconciled by the poll loop).
    if (this.mesh) {
      const recipients = new Set<string>();
      if (assignee) recipients.add(assignee);
      for (const token of parseMentions(opts.body)) recipients.add(token);
      for (const personalityId of recipients) {
        void this.notifyAssignee(personalityId, opts.taskId, 'kanban_comment', opts.team).catch(
          () => {},
        );
      }
    }
    return { comment: toWireComment(comment) };
  }

  private async notifyAssignee(
    personalityId: string,
    taskId: string,
    kind: string,
    team: string,
  ): Promise<void> {
    if (!this.mesh) return;
    const entries = await this.mesh.findByPersonality(personalityId);
    const entry = entries[0];
    if (!entry) return;

    // Phase 3 (kanban-hooks-notify-parity, D7): honor the subscriber's durable
    // per-board mode preference instead of hardcoding notify+wake. A
    // subscription with no entry for this board, or no `mode` set on it,
    // falls back to notify+wake — the only behavior that existed before
    // per-subscription preference did.
    const mode = entry.boardSubscriptions?.find((s) => s.board === team)?.mode ?? 'notify+wake';

    try {
      const res = await fetch(`http://${entry.host}:${entry.port}/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, ref: taskId, mode }),
      });
      if (!res.ok) {
        // Notification failure is non-fatal — poll loop reconciles.
      }
    } catch {
      // Network failure is non-fatal.
    }
  }
}

// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------

function toTeamSummary(
  name: string,
  description: string,
  manifest: {
    dispatch_mode?: 'coordinator' | 'self-routing' | 'broadcast';
    coordinator?: string;
    members: unknown[];
  },
  runtime: TeamRuntime | null,
  rootDir: string,
): KanbanTeamSummary {
  // Match the schema's superRefine default resolution: an unset dispatch_mode
  // with a coordinator field means 'coordinator'; otherwise 'self-routing'.
  const dispatchMode =
    manifest.dispatch_mode ?? (manifest.coordinator !== undefined ? 'coordinator' : 'self-routing');
  const runningCount = runtime?.members.filter((m) => m.status === 'running').length ?? 0;
  const health: KanbanTeamSummary['health'] = runtime
    ? runningCount > 0
      ? 'running'
      : 'stale'
    : 'stopped';
  const boardPath = join(rootDir, name, 'board.db');
  const boardModifiedAt = existsSync(boardPath)
    ? new Date(statSync(boardPath).mtimeMs).toISOString()
    : null;
  return {
    name,
    description,
    dispatchMode,
    health,
    memberCount: manifest.members.length,
    runningCount,
    boardModifiedAt,
  };
}

function toWireTask(t: Task): KanbanTask {
  return {
    id: t.id,
    title: t.title,
    body: t.body,
    status: t.status,
    assignee: t.assignee,
    priority: t.priority,
    workspaceMode: t.workspaceMode,
    workspacePath: t.workspacePath,
    scheduledFor: t.scheduledFor !== null ? new Date(t.scheduledFor).toISOString() : null,
    currentRunId: t.currentRunId,
    retryCount: t.retryCount,
    maxRetries: t.maxRetries,
    acceptanceCriteria: t.acceptanceCriteria,
    createdAt: new Date(t.createdAt).toISOString(),
    updatedAt: new Date(t.updatedAt).toISOString(),
  };
}

function toWireComment(c: TaskComment): KanbanComment {
  return {
    id: c.id,
    taskId: c.taskId,
    author: c.author,
    body: c.body,
    createdAt: new Date(c.createdAt).toISOString(),
  };
}

function toWireRun(r: TaskRun): KanbanRun {
  return {
    id: r.id,
    taskId: r.taskId,
    startedAt: new Date(r.startedAt).toISOString(),
    endedAt: r.endedAt !== null ? new Date(r.endedAt).toISOString() : null,
    outcome: r.outcome,
    summary: r.summary,
    lastHeartbeatAt: new Date(r.lastHeartbeatAt).toISOString(),
    completedBy: r.completedBy,
  };
}

function toWireMemberStats(s: TeamMemberStats): KanbanMemberStats {
  return {
    teamId: s.teamId,
    memberId: s.memberId,
    ticketsCompleted: s.ticketsCompleted,
    ticketsFailed: s.ticketsFailed,
    ticketsOrphaned: s.ticketsOrphaned,
    lastUpdatedAt: new Date(s.lastUpdatedAt).toISOString(),
  };
}

// Match @-mentions of personality ids: letters, digits, hyphens, underscores.
// e.g. "@swing-trader" -> "swing-trader". Returns the unique set of tokens.
const MENTION_PATTERN = /@([A-Za-z0-9_-]+)/g;
function parseMentions(body: string): string[] {
  const out = new Set<string>();
  for (const m of body.matchAll(MENTION_PATTERN)) {
    const token = m[1];
    if (token) out.add(token);
  }
  return [...out];
}

// Path-traversal guard. Same logic as `ethos team destroy` — refuse anything
// that could resolve outside `teamsDir()`. Without it, a malicious or buggy
// caller could feed `..` into a path and reach beyond the teams directory.
const TEAM_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function assertSafeTeamName(name: string): void {
  if (name === '.' || name === '..' || !TEAM_NAME_PATTERN.test(name)) {
    throw new Error(`invalid team name: ${name}`);
  }
}

// Re-exports kept lightweight so callers don't need to depend on kanban-store
// directly when they just want the shape names from the wire types.
export type { KanbanComment, KanbanRun, TaskComment, TaskEvent, TaskRun };
