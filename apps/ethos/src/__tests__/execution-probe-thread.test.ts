// Settings › Execution probe — the composition roots' half of the registry
// thread (plan `remote-execution-routing.md`, T7 follow-up).
//
// T7 built `execution.probeSsh` and gave `createWebApi` an `executionBackends`
// option, but nothing handed it one: `CreateAgentLoopResult` did not expose the
// loop's registry, so every deployment answered `backend_unresolved` and the
// `Test connection` button could not reach a backend at all.
//
// The property is INSTANCE IDENTITY, not "a backend came back". A probe against
// a second, look-alike backend built for the occasion would answer about an
// object nothing executes on — worse than no probe, because it reads as
// reassurance. The chain has three links:
//
//   1. the compose path resolves the tools' backend on `infra.executionBackends`
//      and the loop hands THAT registry out, which memoises so `get('ssh')` is
//      that same instance — packages/wiring/src/__tests__/
//      execution-registry-thread.test.ts;
//   2. `ExecutionService.probeSsh` calls `get('ssh')` before `resolve` —
//      apps/web-api/src/services/__tests__/execution.service.test.ts, pinned
//      below so a rewrite of that order does not pass silently;
//   3. the commands that host a web API pass the loop's registry — this file.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');

describe('the probe asks the registry for the loop instance', () => {
  it('the service tries get() before resolving one of its own', async () => {
    const src = await readFile(
      join(ROOT, 'apps/web-api/src/services/execution.service.ts'),
      'utf8',
    );
    expect(src).toContain("const existing = registry.get('ssh');");
    expect(src).toContain('if (existing) return { backend: existing };');
  });
});

describe('the composition roots thread the LOOP registry, not a fresh one', () => {
  it('createAgentLoop hands out the registry compose-tools resolves on', async () => {
    const build = await readFile(join(ROOT, 'packages/wiring/src/build-agent-loop.ts'), 'utf8');
    const compose = await readFile(join(ROOT, 'packages/wiring/src/compose-tools.ts'), 'utf8');
    // One `infra`, one registry: the tools resolve on it, the result hands it
    // out. Two different expressions here would be two different objects.
    expect(build).toContain('executionBackends: infra.executionBackends,');
    expect(compose).toContain('registry: infra.executionBackends,');
  });

  // `commands/serve.ts` is not importable from a vitest run (it pulls in
  // `@ethosagent/acp-server`), which is why every test covering it asserts
  // against its source — see boot-profile-extraction.test.ts.
  it('serve assigns the loop result and forwards it to createWebApi', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/serve.ts'), 'utf8');
    expect(src).toContain('executionBackends = result.executionBackends;');
    // Spread, not `executionBackends: undefined`: absent means the service is
    // built without a registry and answers `backend_unresolved` with the
    // reason — never a fabricated `unreachable`, and never a throw.
    expect(src).toContain('...(executionBackends ? { executionBackends } : {}),');
  });

  it('boot forwards the system loop registry through the same seam', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/boot.ts'), 'utf8');
    expect(src).toContain('executionBackends: shared.executionBackends,');
  });

  // `ethos gateway` hosts no in-process web API, so there is nothing to thread
  // there — the distinction that matters, and the one this keeps true.
  it('gateway hosts no web API, so it needs no registry thread', async () => {
    const src = await readFile(join(ROOT, 'apps/ethos/src/commands/gateway.ts'), 'utf8');
    expect(src).not.toContain('createWebApi');
  });
});
