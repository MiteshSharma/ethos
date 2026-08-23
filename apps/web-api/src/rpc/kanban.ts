import { os } from './context';

// Thin RPC shells for the kanban namespace. Reads (`list`, `getBoard`) pass
// straight through; mutations (`updateStatus`, `createTask`, `assign`) thread
// an explicit actor label so the audit trail can distinguish UI edits from
// agent calls. `listAgents` delegates to mesh-backed discovery.

export const kanbanRouter = {
  list: os.kanban.list.handler(({ context }) => context.kanban.list()),

  getBoard: os.kanban.getBoard.handler(({ input, context }) => context.kanban.getBoard(input.team)),

  updateStatus: os.kanban.updateStatus.handler(({ input, context }) =>
    context.kanban.updateStatus({
      team: input.team,
      taskId: input.taskId,
      status: input.status,
      ...(input.reason !== undefined ? { reason: input.reason } : {}),
      actor: 'human:control-center',
    }),
  ),

  bulkUpdateStatus: os.kanban.bulkUpdateStatus.handler(({ input, context }) =>
    context.kanban.bulkUpdateStatus({
      team: input.team,
      taskIds: input.taskIds,
      status: input.status,
      actor: 'human:control-center',
    }),
  ),

  createTask: os.kanban.createTask.handler(({ input, context }) =>
    context.kanban.createTask({
      ...input,
      actor: 'human:control-center',
    }),
  ),

  listAgents: os.kanban.listAgents.handler(async ({ input, context }) => {
    // Get online agents from mesh
    const meshResult = await context.kanban.listAgents({ team: input.team });
    const onlineIds = new Set(meshResult.agents.map((a) => a.personalityId));

    // Get all personalities from disk
    const allPersonalities = (await context.personalities.list()).items;

    // Add offline personalities that aren't already in the mesh list
    const offlineAgents = allPersonalities
      .filter((p) => !onlineIds.has(p.id))
      .map((p) => ({
        personalityId: p.id,
        displayName: p.name,
        agentId: p.id,
        online: false,
      }));

    return { agents: [...meshResult.agents, ...offlineAgents] };
  }),

  assign: os.kanban.assign.handler(({ input, context }) =>
    context.kanban.assign({
      team: input.team,
      taskId: input.taskId,
      assignee: input.assignee,
      actor: 'human:control-center',
    }),
  ),

  bulkAssign: os.kanban.bulkAssign.handler(({ input, context }) =>
    context.kanban.bulkAssign({
      team: input.team,
      taskIds: input.taskIds,
      assignee: input.assignee,
      actor: 'human:control-center',
    }),
  ),

  getTask: os.kanban.getTask.handler(({ input, context }) =>
    context.kanban.getTask({ team: input.team, taskId: input.taskId }),
  ),

  addComment: os.kanban.addComment.handler(({ input, context }) =>
    context.kanban.addComment({ team: input.team, taskId: input.taskId, body: input.body }),
  ),
};
