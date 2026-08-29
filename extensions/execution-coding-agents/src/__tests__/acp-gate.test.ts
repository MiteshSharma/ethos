// The ACP end of the interaction chain: a gated tool call reaches the SAME
// worker router `execution-pi`'s gate uses, carrying its `jobId`, and the
// human's answer comes back translated into ACP's own
// `RequestPermissionOutcome` shape. Mirrors
// `execution-pi/src/__tests__/router-gate.test.ts`'s harness style.
//
// No Docker, no container, no real agent process — this is the gate/router
// wiring only.

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
import { type AcpGateRequest, createAutoApproveGate, createRouterGate } from '../acp-gate';
import type { AcpPermissionOption } from '../acp-protocol';

const JOB = {
  id: 'job-1',
  childSessionKey: 'cli:test:job:refactor:job-1',
} as unknown as BackgroundJob;

/** The kind of `options` array a real ACP agent sends alongside its request. */
const STANDARD_OPTIONS: AcpPermissionOption[] = [
  { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'opt-allow-always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'opt-reject-once', name: 'Reject', kind: 'reject_once' },
];

function gateRequest(overrides: Partial<AcpGateRequest> = {}): AcpGateRequest {
  return {
    requestId: 'tc-1',
    jobId: 'job-1',
    sessionId: 'sess-1',
    toolCallId: 'tc-1',
    toolName: 'bash',
    digest: '{"command":"rm -rf build"}',
    options: STANDARD_OPTIONS,
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

describe('createRouterGate — allow path', () => {
  it("carries the run's jobId and the tool digest into the question, and selects an allow option", async () => {
    const { request, gate } = harness('Allow once');

    await expect(gate(gateRequest())).resolves.toEqual({
      outcome: 'selected',
      optionId: 'opt-allow-once',
    });

    const input = request.mock.calls[0]?.[0];
    expect(input?.jobId).toBe('job-1');
    expect(input?.sessionId).toBe(JOB.childSessionKey);
    expect(input?.question).toContain('bash');
    expect(input?.options).toEqual(['Allow once', RUN_SCOPE_ANSWER, 'Deny']);
  });

  it("prefers 'allow_always' when the router's answer carries the run/always scope", async () => {
    const { gate } = harness(RUN_SCOPE_ANSWER);
    await expect(gate(gateRequest())).resolves.toEqual({
      outcome: 'selected',
      optionId: 'opt-allow-always',
    });
  });

  it('falls back to the other allow kind when the agent only offered one', async () => {
    const { gate } = harness('Allow once');
    const onlyAlways: AcpPermissionOption[] = [
      { optionId: 'opt-a', name: 'Always allow', kind: 'allow_always' },
      { optionId: 'opt-r', name: 'Reject', kind: 'reject_once' },
    ];
    await expect(gate(gateRequest({ options: onlyAlways }))).resolves.toEqual({
      outcome: 'selected',
      optionId: 'opt-a',
    });
  });
});

describe('createRouterGate — deny path', () => {
  it('denies on anything that is not an affirmative, and selects a reject option', async () => {
    const { gate } = harness('Deny');
    await expect(gate(gateRequest())).resolves.toEqual({
      outcome: 'selected',
      optionId: 'opt-reject-once',
    });
  });

  it('denies a cancelled question rather than reading silence as consent', async () => {
    const { gate } = harness('', 'cancel');
    await expect(gate(gateRequest())).resolves.toEqual({
      outcome: 'selected',
      optionId: 'opt-reject-once',
    });
  });

  it('propagates a policy failure instead of allowing — the host cancels on a throw', async () => {
    const { request, gate } = harness('hunter2');
    await expect(gate(gateRequest({ kind: SECRET_KIND }))).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );
    expect(request).not.toHaveBeenCalled();
  });
});

describe('createRouterGate — malformed/impoverished request_permission', () => {
  it('cancels rather than guessing an optionId when the agent offered no allow-shaped option', async () => {
    const { gate } = harness('Allow once');
    const onlyReject: AcpPermissionOption[] = [
      { optionId: 'opt-r', name: 'Reject', kind: 'reject_once' },
    ];
    await expect(gate(gateRequest({ options: onlyReject }))).resolves.toEqual({
      outcome: 'cancelled',
    });
  });

  it('cancels rather than crashing when the agent sent an empty options array', async () => {
    const { gate } = harness('Deny');
    await expect(gate(gateRequest({ options: [] }))).resolves.toEqual({ outcome: 'cancelled' });
  });
});

describe('createAutoApproveGate', () => {
  it('approves everything, preferring allow_always when offered', async () => {
    const gate = createAutoApproveGate();
    await expect(gate(gateRequest())).resolves.toEqual({
      outcome: 'selected',
      optionId: 'opt-allow-always',
    });
  });

  it('cancels rather than guessing when nothing allow-shaped was offered', async () => {
    const gate = createAutoApproveGate();
    const onlyReject: AcpPermissionOption[] = [
      { optionId: 'opt-r', name: 'Reject', kind: 'reject_once' },
    ];
    await expect(gate(gateRequest({ options: onlyReject }))).resolves.toEqual({
      outcome: 'cancelled',
    });
  });
});

// D-ACP3's degrade-when-unsupported path — "the job runs to completion
// without ever asking, never hangs" — is a property of the HOST (nothing
// polls or blocks waiting for a `session/request_permission` that never
// arrives; the connection is purely request-driven), not of the gate
// function itself, which is never invoked when the agent never asks. See
// `host.test.ts`'s "an agent that never requests permission" test for the
// full end-to-end proof.
