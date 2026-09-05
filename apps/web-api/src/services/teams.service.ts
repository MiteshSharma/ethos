import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { autonomyTier } from '@ethosagent/kanban-store';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import { parseTeamManifest, readRuntimeFrom, teamsDir } from '@ethosagent/team-supervisor';
import type { MemoryContext, Storage, TeamManifest } from '@ethosagent/types';
import type {
  KanbanEvent,
  KanbanMemberStats,
  KanbanTask,
  LedgerEvent,
  LedgerSeverity,
  TeamDetail,
  TeamMemberSummary,
  TeamSummary,
} from '@ethosagent/web-contracts';
import { assertSafeTeamName, type KanbanService } from './kanban.service';

// Teams service — the team altitude's read model (plan/phases/teams-as-a-scope.md
// §9). Composes over `KanbanService` for discovery, the board snapshot and the
// path-containment guard; adds what the manifest and runtime file say about
// members, and the supervisor ledger derived from `task_events` (§7). Team
// memory goes through the same markdown provider wiring mounts for the team
// loop (`<teamsDir>/<name>/memory`, `scopeId = team:<name>`), via Storage.

const GLOBAL_BOARD_NAME = 'global';

// Supervisor defaults (`extensions/team-supervisor/src/dispatcher.ts`).
const DEFAULT_STALE_MS = 90_000;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_STALENESS_THRESHOLD_MS = 300_000;

/** How many `task_events` rows the ledger scans before filtering. */
const LEDGER_SCAN_WINDOW = 1000;

const TOPIC_KEY_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface TeamsServiceOptions {
  kanban: KanbanService;
  storage: Storage;
  /** Override the teams directory (testing). Defaults to `~/.ethos/teams`. */
  teamsDir?: string;
}

export class TeamsService {
  private readonly kanban: KanbanService;
  private readonly storage: Storage;
  private readonly rootDir: string;

  constructor(opts: TeamsServiceOptions) {
    this.kanban = opts.kanban;
    this.storage = opts.storage;
    this.rootDir = opts.teamsDir ?? teamsDir();
  }

  /** Every team with a parseable manifest. The global board is not a team. */
  async list(): Promise<{ items: TeamSummary[] }> {
    const { teams } = await this.kanban.list();
    const items: TeamSummary[] = [];
    for (const t of teams) {
      if (t.name === GLOBAL_BOARD_NAME) continue;
      try {
        items.push((await this.load(t.name)).summary);
      } catch {
        // Malformed manifest or unreadable board — skip, as kanban.list does.
      }
    }
    return { items };
  }

  async get(team: string): Promise<TeamDetail> {
    assertSafeTeamName(team);
    const { summary, manifest, manifestYaml, manifestPath } = await this.load(team);
    const runtime = readRuntimeFrom(this.rootDir, team);
    const topics = await this.memoryFor(team).list();
    return {
      ...summary,
      manifestYaml,
      manifestPath,
      trustPolicy: manifest.trust_policy ?? null,
      kanban: {
        staleMs: manifest.kanban?.stale_ms ?? DEFAULT_STALE_MS,
        pollMs: manifest.kanban?.poll_ms ?? DEFAULT_POLL_MS,
        stalenessThresholdMs:
          manifest.kanban?.staleness_threshold_ms ?? DEFAULT_STALENESS_THRESHOLD_MS,
      },
      memoryTopics: topics,
      runtime: runtime
        ? {
            supervisorPid: runtime.supervisorPid,
            startedAt: runtime.startedAt,
            members: runtime.members.map((m) => ({
              personality: m.personality,
              port: m.port,
              pid: m.pid,
              status: m.status,
              failureCount: m.failureCount,
            })),
          }
        : null,
    };
  }

  /** Supervisor ledger, newest first (§7). */
  async ledger(opts: {
    team: string;
    limit?: number | undefined;
    personalityId?: string | undefined;
  }): Promise<{ items: LedgerEvent[] }> {
    assertSafeTeamName(opts.team);
    const limit = opts.limit ?? 50;
    const { board } = await this.kanban.getBoard(opts.team);
    const tasksById = new Map(board.tasks.map((t) => [t.id, t]));
    const events = await this.kanban.getRecentEvents(opts.team, LEDGER_SCAN_WINDOW);
    const items: LedgerEvent[] = [];
    // getRecentEvents is ascending; walk from the newest end.
    for (let i = events.length - 1; i >= 0 && items.length < limit; i--) {
      const event = events[i];
      if (!event) continue;
      const line = describeLedgerEvent(event, tasksById.get(event.taskId));
      if (!line) continue;
      if (opts.personalityId !== undefined && line.personalityId !== opts.personalityId) continue;
      items.push(line);
    }
    return { items };
  }

  async memoryList(team: string): Promise<{ items: Array<{ key: string }> }> {
    assertSafeTeamName(team);
    this.requireManifest(team);
    const keys = await this.memoryFor(team).list();
    return { items: keys.map((key) => ({ key })) };
  }

  async memoryRead(team: string, key: string): Promise<{ key: string; content: string }> {
    assertSafeTeamName(team);
    assertSafeTopicKey(key);
    this.requireManifest(team);
    const content = await this.memoryFor(team).read(key);
    return { key, content };
  }

  async memoryWrite(opts: {
    team: string;
    key: string;
    action: 'add' | 'replace' | 'delete';
    content?: string | undefined;
  }): Promise<{ ok: true }> {
    assertSafeTeamName(opts.team);
    assertSafeTopicKey(opts.key);
    this.requireManifest(opts.team);
    const memory = this.memoryFor(opts.team);
    if (opts.action === 'delete') {
      await memory.delete(opts.key);
    } else {
      if (opts.content === undefined) {
        throw new Error(`content is required for action "${opts.action}"`);
      }
      await memory.write(opts.key, opts.action, opts.content);
    }
    return { ok: true };
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private requireManifest(team: string): string {
    const manifestPath = join(this.rootDir, `${team}.yaml`);
    if (!existsSync(manifestPath)) throw new Error(`team not found: ${team}`);
    return manifestPath;
  }

  private async load(team: string): Promise<{
    summary: TeamSummary;
    manifest: TeamManifest;
    manifestYaml: string;
    manifestPath: string;
  }> {
    const manifestPath = this.requireManifest(team);
    const manifestYaml = await readFile(manifestPath, 'utf-8');
    const manifest = parseTeamManifest(manifestYaml);
    const runtime = readRuntimeFrom(this.rootDir, team);
    // The kanban snapshot carries the summary fields and the member stats the
    // tier derives from. It re-reads manifest + runtime; cheap, and it keeps
    // `KanbanTeamSummary` with one owner.
    const { board } = await this.kanban.getBoard(team);
    const hasBoard = board.team.boardModifiedAt !== null;
    const statsByMember = new Map<string, KanbanMemberStats>(
      board.memberStats.map((s) => [s.memberId, s]),
    );
    const runtimeByMember = new Map(runtime?.members.map((m) => [m.personality, m]) ?? []);

    // Mirrors createTeamAgentLoop's resolution minus its config.personality
    // fallback (D4): the UI must not invent a coordinator the manifest lacks.
    const coordinator = manifest.coordinator ?? manifest.members[0]?.personality ?? null;

    const members: TeamMemberSummary[] = manifest.members.map((m) => {
      const stats = statsByMember.get(m.personality);
      return {
        personalityId: m.personality,
        role: m.role ?? 'member',
        tier: hasBoard
          ? autonomyTier(
              stats ?? { ticketsCompleted: 0, ticketsFailed: 0, ticketsOrphaned: 0 },
              manifest.trust_policy,
            )
          : null,
        status: runtimeByMember.get(m.personality)?.status ?? 'offline',
        capabilities: m.capabilities ?? [],
      };
    });

    return {
      summary: {
        ...board.team,
        coordinator,
        members,
        channels: (manifest.channels ?? []).map((c) => ({
          platform: c.platform,
          botKey: c.botKey,
        })),
        startedAt: runtime?.startedAt ?? null,
      },
      manifest,
      manifestYaml,
      manifestPath,
    };
  }

  private memoryFor(team: string): TeamMemory {
    return new TeamMemory(
      new MarkdownFileMemoryProvider({
        dir: join(this.rootDir, team, 'memory'),
        storage: this.storage,
      }),
      { scopeId: `team:${team}`, sessionId: '', sessionKey: '', platform: 'web', workingDir: '' },
    );
  }
}

/** Topic-keyed view over the team-scoped provider: `<key>` ⇄ `<key>.md`. */
class TeamMemory {
  constructor(
    private readonly provider: MarkdownFileMemoryProvider,
    private readonly ctx: MemoryContext,
  ) {}

  async list(): Promise<string[]> {
    const refs = await this.provider.list(this.ctx);
    return refs
      .filter((r) => r.key.endsWith('.md'))
      .map((r) => r.key.slice(0, -'.md'.length))
      .filter((k) => TOPIC_KEY_PATTERN.test(k));
  }

  async read(key: string): Promise<string> {
    const entry = await this.provider.read(`${key}.md`, this.ctx);
    return entry?.content ?? '';
  }

  async write(key: string, action: 'add' | 'replace', content: string): Promise<void> {
    await this.provider.sync([{ action, key: `${key}.md`, content }], this.ctx);
  }

  async delete(key: string): Promise<void> {
    await this.provider.sync([{ action: 'delete', key: `${key}.md` }], this.ctx);
  }
}

function assertSafeTopicKey(key: string): void {
  if (!TOPIC_KEY_PATTERN.test(key)) throw new Error(`invalid memory key: ${key}`);
}

// ---------------------------------------------------------------------------
// Ledger derivation (§7) — the supervisor-voiced sibling of the web's
// `describeEvent`. Pure: one `task_events` row (+ its task, when the board
// still lists it) → one line, or null for rows the ledger does not show.
// ---------------------------------------------------------------------------

const RECLAIM_REASONS = new Set(['orphan_stale', 'orphan_no_owner']);

function isHuman(actor: string): boolean {
  return actor.startsWith('human:');
}

/** The actor when it names a member; null for `dispatcher`, `system`, `human:*`. */
function agentActor(actor: string): string | null {
  if (actor === 'dispatcher' || actor === 'system' || isHuman(actor)) return null;
  return actor;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function describeLedgerEvent(
  event: KanbanEvent,
  task: KanbanTask | undefined,
): LedgerEvent | null {
  const base = (
    kind: string,
    headline: string,
    detail: string,
    severity: LedgerSeverity,
    personalityId: string | null,
  ): LedgerEvent => ({
    id: event.id,
    at: event.createdAt,
    kind,
    taskId: event.taskId,
    taskTitle: task?.title ?? null,
    personalityId,
    headline,
    detail,
    severity,
  });
  const assignee = task?.assignee ?? null;

  switch (event.kind) {
    case 'created':
      return base('created', 'Created', `by ${event.actor}`, 'info', agentActor(event.actor));

    case 'status_changed': {
      const to = str(event.data.to);
      const reason = str(event.data.reason);
      if (to === 'running' && event.actor === 'dispatcher') {
        return base(
          'dispatched',
          'Dispatch tick',
          `claimed for ${assignee ?? 'unassigned'}`,
          'ok',
          assignee,
        );
      }
      if (to === 'ready' && reason !== null && RECLAIM_REASONS.has(reason)) {
        const why = reason === 'orphan_stale' ? 'heartbeat went stale' : 'owner process is gone';
        return base(
          'stale_reclaim',
          'Stale reclaim',
          `${assignee ?? 'unassigned'} ${why} · back to ready`,
          'err',
          assignee,
        );
      }
      if (to === 'needs_revision' && !isHuman(event.actor)) {
        const retry =
          task !== undefined ? ` · retry ${task.retryCount} of ${task.maxRetries ?? '∞'}` : '';
        return base(
          'verifier_rejected',
          'Verifier rejected',
          `${reason ?? 'no reason recorded'}${retry}`,
          'warn',
          agentActor(event.actor) ?? assignee,
        );
      }
      if (to === 'ready' && isHuman(event.actor) && reason === 'unblocked by operator') {
        // The block reason is on the earlier `run_completed` row, not this one
        // or the task, so the detail names where the ticket went instead.
        return base(
          'operator_unblocked',
          'Operator unblocked',
          `back to ready for ${assignee ?? 'unassigned'}`,
          'ok',
          assignee,
        );
      }
      // Deliberately null: the web's reassign writes a `kanban.assign` first,
      // whose `assigned` row already yields "Operator assigned" — do not add a line.
      if (to === 'ready' && isHuman(event.actor) && reason === 'reassigned by operator') {
        return null;
      }
      if (to === 'done' && isHuman(event.actor) && (reason ?? '').includes('verifier bypassed')) {
        return base('operator_approved', 'Operator approved', reason ?? '', 'ok', assignee);
      }
      if (to === 'archived' && isHuman(event.actor)) {
        return base('operator_archived', 'Operator archived', '', 'dim', assignee);
      }
      return null;
    }

    case 'run_completed': {
      const outcome = str(event.data.outcome);
      const summary = str(event.data.summary) ?? '';
      const who = agentActor(event.actor) ?? assignee;
      if (outcome === 'completed') {
        const headline = task?.acceptanceCriteria ? 'Verifier passed' : 'Completed';
        const detail = who ? (summary ? `${who} · ${summary}` : who) : summary;
        return base('completed', headline, detail, 'ok', who);
      }
      if (outcome === 'blocked') {
        return base('blocked', 'Blocked', summary, 'err', who);
      }
      // cancelled / stalled rows ride along with a status_changed that is
      // (or is not) shown on its own.
      return null;
    }

    case 'assigned': {
      if (!isHuman(event.actor)) return null;
      const to = str(event.data.assignee);
      return base(
        'operator_assigned',
        'Operator assigned',
        to ? `to ${to}${task ? ` · ${task.status}` : ''}` : 'unassigned',
        'ok',
        to,
      );
    }

    // `store.archive()` writes `status_changed → archived` AND `archived` for
    // one call; the status row is the one line, so this kind is skipped
    // rather than shown twice (same spirit as "one line per block, not three").
    case 'archived':
      return null;

    // heartbeat, run_started, commented, linked, unlinked — not ledger material.
    default:
      return null;
  }
}
