import { os } from './context';

// Thin RPC shells for the eval namespace. Mirror of batch — same
// LabService backs both.

export const evalRouter = {
  list: os.eval.list.handler(({ context }) => context.lab.evalList()),

  start: os.eval.start.handler(({ input, context }) =>
    context.lab.evalStart({
      tasksJsonl: input.tasksJsonl,
      expectedJsonl: input.expectedJsonl,
      ...(input.scorer !== undefined ? { scorer: input.scorer } : {}),
      ...(input.concurrency !== undefined ? { concurrency: input.concurrency } : {}),
    }),
  ),

  get: os.eval.get.handler(({ input, context }) => context.lab.evalGet(input.id)),

  output: os.eval.output.handler(({ input, context }) => context.lab.evalOutput(input.id)),
};
