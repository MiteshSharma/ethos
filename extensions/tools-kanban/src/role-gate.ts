import type { KanbanStore } from '@ethosagent/kanban-store';
import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';

/**
 * Role-based authorization for kanban tools — Plan B's policy layer.
 *
 * Four tiers:
 *   - coordinator-only:       kanban_create_goal, kanban_create, kanban_assign,
 *                             kanban_link, kanban_archive
 *   - coordinator-or-assignee: kanban_update_status
 *                             (coordinator drives the board for orchestration —
 *                             e.g. wiring `blocked` dependencies, marking tasks
 *                             `ready`; assignee may also self-drive)
 *   - assignee-only:          kanban_complete, kanban_block, kanban_unblock,
 *                             kanban_heartbeat (first-person closer tools —
 *                             only the assignee can speak for their own task)
 *   - any member:             kanban_comment, kanban_show, kanban_list
 *
 * Why `kanban_update_status` is not strictly assignee-only:
 *   Treating it as any-member would let any member bypass the closer-tool
 *   checks below. Treating it as strict-assignee blocked the coordinator from
 *   doing legitimate board orchestration (the bug fix that landed this tier).
 *   Coordinator-or-assignee threads the needle: coordinator wires dependencies,
 *   assignee may self-drive, no other member can move someone else's status.
 *
 * Wiring registers this hook with `registerModifying('before_tool_call', ...)`
 * when both a team manifest and a role are active. Solo personalities never
 * see the hook, so Plan A behavior is unchanged.
 *
 * Rejections come back as `{ error }`; AgentLoop translates that into a
 * `tool_result` with `is_error: true` so the LLM contract stays intact.
 */
export type TeamRole = 'coordinator' | 'member';

export interface KanbanRoleGateOptions {
  /** Role of the caller, fixed at boot time per `ethos serve --role`. Used as
   *  the caller's role when `coordinatorId` is not supplied. */
  role: TeamRole;
  /** Personality id the loop was constructed with. Used as the caller when the
   *  payload carries no per-turn `personalityId`. */
  personalityId: string;
  /** Shared team board — assignee-only checks read it to compare current assignee. */
  store: KanbanStore;
  /**
   * The team manifest's coordinator personality. When set, the caller's role
   * is resolved PER TURN from the caller's identity — `coordinator` iff the
   * turn's personality is this id, else `member` — so one loop shared by a
   * whole team (teams-as-a-scope D4) authorises each personality as itself.
   * Absent → the boot-time `role` is used unchanged.
   */
  coordinatorId?: string;
}

const COORDINATOR_ONLY = new Set([
  'kanban_create_goal',
  'kanban_create',
  'kanban_assign',
  'kanban_link',
  'kanban_archive',
]);

const COORDINATOR_OR_ASSIGNEE = new Set(['kanban_update_status']);

const ASSIGNEE_ONLY = new Set([
  'kanban_complete',
  'kanban_block',
  'kanban_unblock',
  'kanban_heartbeat',
]);

const KANBAN_PREFIX = 'kanban_';

export function createKanbanRoleGateHook(
  opts: KanbanRoleGateOptions,
): (payload: BeforeToolCallPayload) => Promise<BeforeToolCallResult> {
  const { store, coordinatorId } = opts;

  return async (payload: BeforeToolCallPayload): Promise<BeforeToolCallResult> => {
    const { toolName, args } = payload;

    // Non-kanban tools: this hook has no opinion.
    if (!toolName.startsWith(KANBAN_PREFIX)) return {};

    // The caller is the TURN's personality when the loop reports one (a
    // team-scoped loop runs a different personality per turn); otherwise the
    // personality the loop was built with. Role follows identity when the
    // manifest's coordinator is known, else it is the boot-time role.
    const personalityId = payload.personalityId ?? opts.personalityId;
    const role: TeamRole =
      coordinatorId === undefined
        ? opts.role
        : personalityId === coordinatorId
          ? 'coordinator'
          : 'member';

    if (COORDINATOR_ONLY.has(toolName) && role !== 'coordinator') {
      return {
        error: `kanban-role-gate: ${toolName} requires role=coordinator (caller role=${role}). Ask the coordinator to do this.`,
      };
    }

    // Coordinator drives orchestration status changes; otherwise fall through
    // to the assignee check below.
    if (COORDINATOR_OR_ASSIGNEE.has(toolName) && role === 'coordinator') return {};

    if (ASSIGNEE_ONLY.has(toolName) || COORDINATOR_OR_ASSIGNEE.has(toolName)) {
      const taskId = extractTaskId(args);
      if (typeof taskId !== 'string') {
        // The tool will reject this in its own arg validation; let it through.
        return {};
      }
      const task = store.getTask(taskId);
      if (!task) {
        // Unknown task — let the tool surface the not-found error.
        return {};
      }
      if (task.assignee !== personalityId) {
        return {
          error: `kanban-role-gate: ${toolName} on ${taskId} requires you to be the assignee (current assignee=${task.assignee ?? 'unassigned'}, you=${personalityId}).`,
        };
      }
    }

    // Any-member tools: no restriction beyond being in the team.
    return {};
  };
}

function extractTaskId(args: unknown): string | undefined {
  if (typeof args !== 'object' || args === null) return undefined;
  const id = (args as { task_id?: unknown }).task_id;
  return typeof id === 'string' ? id : undefined;
}
