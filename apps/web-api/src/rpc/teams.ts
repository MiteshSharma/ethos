import { os } from './context';

// Thin RPC shells for the teams namespace — every procedure passes straight
// through to `TeamsService`; the service owns validation and path containment.

export const teamsRouter = {
  list: os.teams.list.handler(({ context }) => context.teams.list()),

  get: os.teams.get.handler(({ input, context }) => context.teams.get(input.team)),

  ledger: os.teams.ledger.handler(({ input, context }) =>
    context.teams.ledger({
      team: input.team,
      limit: input.limit,
      personalityId: input.personalityId,
    }),
  ),

  memoryList: os.teams.memoryList.handler(({ input, context }) =>
    context.teams.memoryList(input.team),
  ),

  memoryRead: os.teams.memoryRead.handler(({ input, context }) =>
    context.teams.memoryRead(input.team, input.key),
  ),

  memoryWrite: os.teams.memoryWrite.handler(({ input, context }) =>
    context.teams.memoryWrite({
      team: input.team,
      key: input.key,
      action: input.action,
      content: input.content,
    }),
  ),
};
