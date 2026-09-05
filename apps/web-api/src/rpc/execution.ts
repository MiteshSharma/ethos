import { os } from './context';

// Execution namespace — one procedure, the uncached ssh reachability probe
// behind Settings › Execution's `Test connection`
// (plan/phases/remote-execution-routing.md §6, T7).
//
// Auth posture: deliberately ABSENT from `dual-auth.ts`'s `SCOPE_MAP`, like
// `backup` and `recipes`. A probe opens an outbound connection from the host,
// so a third-party API key has no business firing it; with no entry, `dualAuth`
// refuses the whole namespace to a Bearer caller before a handler runs.
//
// No input, and no `force` flag: the procedure is uncached by construction (the
// service calls `probe()`, not `isAvailable()`), so there is nothing to bypass.

export const executionRouter = {
  probeSsh: os.execution.probeSsh.handler(({ context }) => context.execution.probeSsh()),
};
