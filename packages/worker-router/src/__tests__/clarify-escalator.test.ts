// I19 — escalation to a human rides the EXISTING clarify chain (G1/D2/D7),
// so what this proves is the mapping in both directions: an
// `InteractionRequest` into a `ClarifyRequestInput`, and a `ClarifyResponse`
// back into an `InteractionAnswer` carrying D17's scope.

import type { ClarifyRequestInput } from '@ethosagent/core';
import type { BackgroundJob, ClarifyResponse, InteractionRequest } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { createClarifyEscalator, RUN_SCOPE_ANSWER } from '../clarify-escalator';
import { SecretUnavailableError } from '../secret';

const JOB = {
  id: 'job-1',
  childSessionKey: 'cli:test:job:refactor:job-1',
} as unknown as BackgroundJob;

function harness(response: ClarifyResponse | Error) {
  const request = vi.fn(async (_input: ClarifyRequestInput) => {
    if (response instanceof Error) throw response;
    return response;
  });
  const escalate = createClarifyEscalator({
    bridge: { request },
    jobs: { get: async (id) => (id === JOB.id ? JOB : null) },
    fallbackSurfaceType: 'cli',
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
    expect(input?.timeoutMs).toBe(900_000);
    expect(input?.answerableBy).toBe('anyone');
    expect(input?.surfaceType).toBe('cli');
    expect(answer).toEqual({
      requestId: 'rq-1',
      value: 'Allow once',
      scope: 'once',
      source: 'human',
    });
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
