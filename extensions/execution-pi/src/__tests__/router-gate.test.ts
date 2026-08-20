// I19 (Phase 4) — the Pi end of the interaction chain: a gated tool call
// reaches the worker router carrying its `jobId`, and the human's answer comes
// back as an allow/deny.
//
// No docker and no Pi process: this is the gate/router wiring, not the
// sandboxed run (that is `live.test.ts`, credential-gated). The `ClarifyBridge`
// is a two-line fake for the same reason.

import type { ClarifyRequestInput } from '@ethosagent/core';
import type { BackgroundJob, ClarifyResponse } from '@ethosagent/types';
import {
  createClarifyEscalator,
  createSecretHandler,
  InteractionRouter,
  RUN_SCOPE_ANSWER,
  SECRET_KIND,
  SecretUnavailableError,
} from '@ethosagent/worker-router';
import { describe, expect, it, vi } from 'vitest';
import type { PiGateRequest } from '../gate';
import { createRouterGate } from '../router-gate';

const JOB = {
  id: 'job-1',
  childSessionKey: 'cli:test:job:refactor:job-1',
} as unknown as BackgroundJob;

function gateRequest(overrides: Partial<PiGateRequest> = {}): PiGateRequest {
  return {
    requestId: 'ui-1',
    jobId: 'job-1',
    kind: 'select',
    toolName: 'bash',
    digest: '{"command":"rm -rf build"}',
    ...overrides,
  };
}

/** A router wired exactly as production wires it, over a fake clarify surface. */
function harness(answer: string, source: ClarifyResponse['source'] = 'user') {
  const request = vi.fn(async (_input: ClarifyRequestInput) => ({
    requestId: 'x',
    answer,
    source,
  }));
  const router = new InteractionRouter({
    escalate: createClarifyEscalator({
      bridge: { request },
      jobs: { get: async () => JOB },
      fallbackSurfaceType: 'cli',
    }),
  });
  router.registry.register(SECRET_KIND, createSecretHandler());
  return { request, router, gate: createRouterGate(router) };
}

describe('createRouterGate', () => {
  it("carries the run's jobId and the tool digest into the question", async () => {
    const { request, gate } = harness('Allow once');

    await expect(gate(gateRequest())).resolves.toEqual({ allow: true });

    const input = request.mock.calls[0]?.[0];
    expect(input?.jobId).toBe('job-1');
    expect(input?.sessionId).toBe(JOB.childSessionKey);
    expect(input?.question).toBe('Pi wants to run `bash`: {"command":"rm -rf build"}. Allow?');
    expect(input?.options).toEqual(['Allow once', RUN_SCOPE_ANSWER, 'Deny']);
  });

  it('denies on anything that is not an affirmative, and says why', async () => {
    const { gate } = harness('Deny');
    await expect(gate(gateRequest())).resolves.toEqual({ allow: false, reason: 'Deny' });
  });

  it('denies a cancelled question rather than reading silence as consent', async () => {
    const { gate } = harness('', 'cancel');
    await expect(gate(gateRequest())).resolves.toEqual({ allow: false, reason: 'Deny' });
  });

  it('asks once per run when the human allows for the run, and again for the next run', async () => {
    const { request, gate } = harness(RUN_SCOPE_ANSWER);

    await expect(gate(gateRequest({ requestId: 'ui-1' }))).resolves.toEqual({ allow: true });
    await expect(gate(gateRequest({ requestId: 'ui-2' }))).resolves.toEqual({ allow: true });
    expect(request).toHaveBeenCalledTimes(1);

    await expect(gate(gateRequest({ requestId: 'ui-3', jobId: 'job-2' }))).resolves.toEqual({
      allow: true,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('propagates a policy failure instead of allowing — the host denies on a throw', async () => {
    const { request, gate } = harness('hunter2');
    await expect(gate(gateRequest({ kind: SECRET_KIND }))).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );
    expect(request).not.toHaveBeenCalled();
  });
});
