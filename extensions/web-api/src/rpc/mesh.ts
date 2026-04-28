import { os } from './context';

// Thin RPC shells for the mesh namespace. Both methods are reads;
// neither mutates state.

export const meshRouter = {
  list: os.mesh.list.handler(({ context }) => context.mesh.list()),

  routeTest: os.mesh.routeTest.handler(({ input, context }) =>
    context.mesh.routeTest(input.capability),
  ),
};
