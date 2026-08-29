// I19 — escalation to a human rides the EXISTING clarify chain (G1/D2/D7),
// so what this proves is the mapping in both directions: an
// `InteractionRequest` into a `ClarifyRequestInput`, and a `ClarifyResponse`
// back into an `InteractionAnswer` carrying D17's scope.

import type { ClarifyRequestInput } from '@ethosagent/core';
import type { BackgroundJob, ClarifyResponse, InteractionRequest } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  type ClarifyEscalatorDeps,
  createClarifyEscalator,
  DEFAULT_ESCALATION_TIMEOUT_MS,
  DEFAULT_PARK_TIMEOUT_MS,
  RUN_SCOPE_ANSWER,
} from '../clarify-escalator';
import { SecretUnavailableError } from '../secret';

const JOB = {
  id: 'job-1',
  childSessionKey: 'cli:test:job:refactor:job-1',
} as unknown as BackgroundJob;

/**
 * Stands in for the executor's side of the `blocking` pair
 * (`BackgroundExecutor.markJobBlocked` / `resumeJob`), modelled through the row
 * they write. A fake and not the real executor on purpose: this package sits
 * below extensions and cannot import one (ARCHITECTURE.md §II) — the real
 * pair's own behaviour is covered in `extensions/job-runner`'s executor tests.
 */
function fakeRun() {
  const calls: string[] = [];
  const run = { status: 'running', blockedRequestId: undefined as string | undefined };
  const blocking: NonNullable<ClarifyEscalatorDeps['blocking']> = {
    block: async (jobId, requestId) => {
      calls.push(`block:${jobId}:${requestId}`);
      run.status = 'blocked';
      run.blockedRequestId = requestId;
    },
    resume: async (jobId) => {
      calls.push(`resume:${jobId}`);
      run.status = 'running';
      run.blockedRequestId = undefined;
    },
  };
  return { run, calls, blocking };
}

function harness(
  response: ClarifyResponse | Error,
  extra: {
    blocking?: ClarifyEscalatorDeps['blocking'];
    /** Runs inside the pending window, so a test can observe the parked state. */
    whileAsking?: () => void;
  } = {},
) {
  const request = vi.fn(async (_input: ClarifyRequestInput) => {
    extra.whileAsking?.();
    if (response instanceof Error) throw response;
    return response;
  });
  const escalate = createClarifyEscalator({
    bridge: { request },
    jobs: { get: async (id) => (id === JOB.id ? JOB : null) },
    fallbackSurfaceType: 'cli',
    ...(extra.blocking ? { blocking: extra.blocking } : {}),
  });
  return { request, escalate };
}

function ask(overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    requestId: 'rq-1',
    kind: 'select',
    prompt: 'Pi wants to run `bash`: {"command":"ls"}. Allow?',
    toolName: 'bash',
    options: [
      { value: 'Allow once', label: 'Allow once' },
      { value: RUN_SCOPE_ANSWER, label: RUN_SCOPE_ANSWER },
      { value: 'Deny', label: 'Deny' },
    ],
    ...overrides,
  };
}

describe('createClarifyEscalator', () => {
  it("asks in the job's own lane and session, with the harness's options", async () => {
    const { request, escalate } = harness({ requestId: 'x', answer: 'Allow once', source: 'user' });

    const answer = await escalate('job-1', ask());

    const input = request.mock.calls[0]?.[0];
    expect(input?.jobId).toBe('job-1');
    expect(input?.sessionId).toBe(JOB.childSessionKey);
    expect(input?.question).toContain('Pi wants to run');
    expect(input?.options).toEqual(['Allow once', RUN_SCOPE_ANSWER, 'Deny']);
    // No default was supplied, so this question PARKS rather than guessing
    // (§4.5 / §4.6 rung 4) — see the two-clocks test below.
    expect(input?.timeoutMs).toBe(DEFAULT_PARK_TIMEOUT_MS);
    expect(input?.answerableBy).toBe('anyone');
    expect(input?.surfaceType).toBe('cli');
    expect(answer).toEqual({
      requestId: 'rq-1',
      value: 'Allow once',
      scope: 'once',
      source: 'human',
    });
  });

  // §4.5's default policy, §4.6 rung 4: the window a question gets is decided
  // by whether there is a safe answer to fall back on, not by the question's
  // kind. A defaultable question keeps the 15-minute clock and then applies its
  // default; a no-default question parks for hours so "resumable an hour later
  // from the paused step" is actually reachable.
  it('runs two clocks: 15 min for a defaultable question, a long park for one with no default', async () => {
    const withDefault = harness({ requestId: 'x', answer: 'Deny', source: 'timeout-default' });
    await withDefault.escalate('job-1', ask({ defaultValue: 'Deny' }));
    expect(withDefault.request.mock.calls[0]?.[0]?.timeoutMs).toBe(DEFAULT_ESCALATION_TIMEOUT_MS);
    expect(withDefault.request.mock.calls[0]?.[0]?.default).toBe('Deny');

    const noDefault = harness({ requestId: 'x', answer: 'Deny', source: 'user' });
    await noDefault.escalate('job-1', ask());
    expect(noDefault.request.mock.calls[0]?.[0]?.timeoutMs).toBe(DEFAULT_PARK_TIMEOUT_MS);
    expect(noDefault.request.mock.calls[0]?.[0]?.default).toBeUndefined();
  });

  it("reads D17's scope off the answer text", async () => {
    const { escalate } = harness({ requestId: 'x', answer: RUN_SCOPE_ANSWER, source: 'user' });
    await expect(escalate('job-1', ask())).resolves.toMatchObject({ scope: 'run' });
  });

  it('treats a timeout default as a one-shot answer, not a standing one', async () => {
    const { escalate } = harness({ requestId: 'x', answer: 'Deny', source: 'timeout-default' });
    await expect(escalate('job-1', ask())).resolves.toMatchObject({
      scope: 'once',
      source: 'timeout-default',
    });
  });

  it('reports a cancelled question as cancelled', async () => {
    const { escalate } = harness({ requestId: 'x', answer: '', source: 'cancel' });
    await expect(escalate('job-1', ask())).resolves.toMatchObject({ source: 'cancel' });
  });

  it('never writes sensitive material into a persisted clarify row', async () => {
    const { request, escalate } = harness({ requestId: 'x', answer: 'nope', source: 'user' });

    await expect(escalate('job-1', ask({ kind: 'input', sensitive: true }))).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );
    expect(request).not.toHaveBeenCalled();
  });

  it('falls back to the job id as the session when the row is gone', async () => {
    const { request, escalate } = harness({ requestId: 'x', answer: 'Deny', source: 'user' });
    await escalate('job-unknown', ask());
    expect(request.mock.calls[0]?.[0].sessionId).toBe('job-unknown');
  });
});

// I11 — a run waiting on a human is `blocked`, not `running`. What matters is
// the ORDER: parked before the question goes out, un-parked once it settles,
// whichever way it settled.
describe('createClarifyEscalator — blocked status', () => {
  it('parks the run for the whole time the human is being asked', async () => {
    const { run, calls, blocking } = fakeRun();
    const observed: { status: string; requestId: string | undefined }[] = [];
    const { escalate } = harness(
      { requestId: 'x', answer: 'Allow once', source: 'user' },
      {
        blocking,
        whileAsking: () => observed.push({ status: run.status, requestId: run.blockedRequestId }),
      },
    );

    await escalate('job-1', ask());

    // Parked before `bridge.request` was even entered...
    expect(observed).toEqual([{ status: 'blocked', requestId: 'rq-1' }]);
    // ...and released once the answer came back.
    expect(run).toEqual({ status: 'running', blockedRequestId: undefined });
    expect(calls).toEqual(['block:job-1:rq-1', 'resume:job-1']);
  });

  it('un-parks a run whose question died, so a denial does not strand it', async () => {
    const { run, calls, blocking } = fakeRun();
    const { escalate } = harness(new Error('clarify timed out and no default was provided'), {
      blocking,
    });

    await expect(escalate('job-1', ask())).rejects.toThrow('clarify timed out');

    expect(run.status).toBe('running');
    expect(calls).toEqual(['block:job-1:rq-1', 'resume:job-1']);
  });

  it('never parks a run on a question it refuses to ask', async () => {
    const { run, calls, blocking } = fakeRun();
    const { escalate } = harness({ requestId: 'x', answer: 'nope', source: 'user' }, { blocking });

    await expect(escalate('job-1', ask({ kind: 'input', sensitive: true }))).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );

    expect(run.status).toBe('running');
    expect(calls).toEqual([]);
  });
});
