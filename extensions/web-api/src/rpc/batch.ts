import { os } from './context';

// Thin RPC shells for the batch namespace. State lives on LabService.

export const batchRouter = {
  list: os.batch.list.handler(({ context }) => context.lab.batchList()),

  start: os.batch.start.handler(({ input, context }) =>
    context.lab.batchStart({
      tasksJsonl: input.tasksJsonl,
      ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
      ...(input.defaultPersonalityId !== undefined
        ? { defaultPersonalityId: input.defaultPersonalityId }
        : {}),
    }),
  ),

  get: os.batch.get.handler(({ input, context }) => context.lab.batchGet(input.id)),

  output: os.batch.output.handler(({ input, context }) => context.lab.batchOutput(input.id)),
};
