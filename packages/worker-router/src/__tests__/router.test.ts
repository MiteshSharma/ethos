// I19 (pi-delegation Phase 4, §3.5/§4.5, D16/D17) — the routing algorithm.
//
// Fake-driven on purpose: the router's whole value is that it decides without
// knowing what a runner is, so nothing here spawns Pi, docker, or a real
// clarify surface. The escalator is a spy; a capability handler is four lines.

import type { InteractionAnswer, InteractionRequest } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { CapabilityHandler } from '../registry';
import { type InteractionEscalator, InteractionRouter } from '../router';
import { createSecretHandler, SECRET_KIND, SecretUnavailableError } from '../secret';

function ask(overrides: Partial<InteractionRequest> = {}): InteractionRequest {
  return {
    requestId: `rq-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'select',
    prompt: 'Pi wants to run `bash`: {"command":"ls"}. Allow?',
    toolName: 'bash',
    ...overrides,
  };
}

/** An escalator that always answers `value`, with a `once` scope by default. */
function humanAnswers(value: string, scope: InteractionAnswer['scope'] = 'once') {
  return vi.fn<InteractionEscalator>(async (_jobId, req) => ({
    requestId: req.requestId,
    value,
    scope,
    source: 'human',
  }));
}

function autoHandler(value: string, scope: InteractionAnswer['scope'] = 'once'): CapabilityHandler {
  return {
    canAutoResolve: () => true,
    resolve: (req) =>
      Promise.resolve({ requestId: req.requestId, value, scope, source: 'auto' as const }),
  };
}

describe('InteractionRouter — §3.5', () => {
  it('never reaches the human for a kind a capability auto-resolves', async () => {
    const escalate = humanAnswers('Allow once');
    const router = new InteractionRouter({ escalate });
    router.registry.register('image-view', autoHandler('described by the vision tool'));

    const answer = await router.route('job-1', ask({ kind: 'image-view' }));

    expect(answer.source).toBe('auto');
    expect(answer.value).toBe('described by the vision tool');
    expect(escalate).not.toHaveBeenCalled();
  });

  it('escalates a kind no capability claims — an unknown kind degrades, never throws', async () => {
    const escalate = humanAnswers('Allow once');
    const router = new InteractionRouter({ escalate });

    // 'form' is a kind nothing in this repo has ever registered a handler for.
    const answer = await router.route('job-1', ask({ kind: 'form' }));

    expect(answer.source).toBe('human');
    expect(escalate).toHaveBeenCalledTimes(1);
    expect(escalate.mock.calls[0]?.[0]).toBe('job-1');
  });

  it('escalates when the registered handler declines to auto-resolve this request', async () => {
    const escalate = humanAnswers('Allow once');
    const router = new InteractionRouter({ escalate });
    const resolve = vi.fn();
    router.registry.register('confirm', {
      // Tier policy covers some confirms and not others (§4.5).
      canAutoResolve: (req) => req.toolName === 'read',
      resolve,
    });

    await router.route('job-1', ask({ kind: 'confirm', toolName: 'bash' }));

    expect(resolve).not.toHaveBeenCalled();
    expect(escalate).toHaveBeenCalledTimes(1);
  });

  it("suppresses the next identical ask in the same job once an answer is scoped 'run'", async () => {
    const escalate = humanAnswers('Allow for this run', 'run');
    const router = new InteractionRouter({ escalate });

    const first = await router.route('job-1', ask());
    const second = await router.route('job-1', ask());

    expect(escalate).toHaveBeenCalledTimes(1);
    expect(second.value).toBe(first.value);
    // The DECISION is replayed; the correlation id is this ask's, or the
    // answer would land on a request that was already resolved.
    expect(second.requestId).not.toBe(first.requestId);
  });

  it("keeps asking when the answer is scoped 'once'", async () => {
    const escalate = humanAnswers('Allow once');
    const router = new InteractionRouter({ escalate });

    await router.route('job-1', ask());
    await router.route('job-1', ask());

    expect(escalate).toHaveBeenCalledTimes(2);
  });

  it('scopes a remembered answer to its own job — a second run asks again', async () => {
    const escalate = humanAnswers('Allow for this run', 'run');
    const router = new InteractionRouter({ escalate });

    await router.route('job-1', ask());
    await router.route('job-2', ask());

    expect(escalate).toHaveBeenCalledTimes(2);
  });

  it('scopes a remembered answer to its own tool — a different tool asks again', async () => {
    const escalate = humanAnswers('Allow for this run', 'run');
    const router = new InteractionRouter({ escalate });

    await router.route('job-1', ask({ toolName: 'bash' }));
    await router.route('job-1', ask({ toolName: 'write' }));

    expect(escalate).toHaveBeenCalledTimes(2);
  });

  it('forgets a job at its terminal transition', async () => {
    const escalate = humanAnswers('Allow for this run', 'run');
    const router = new InteractionRouter({ escalate });

    await router.route('job-1', ask());
    router.forgetJob('job-1');
    await router.route('job-1', ask());

    expect(escalate).toHaveBeenCalledTimes(2);
  });

  it("never asks a human for a 'secret' — it fails closed", async () => {
    const escalate = humanAnswers('hunter2');
    const router = new InteractionRouter({ escalate });
    router.registry.register(SECRET_KIND, createSecretHandler());

    await expect(
      router.route('job-1', ask({ kind: SECRET_KIND, toolName: 'deploy' })),
    ).rejects.toBeInstanceOf(SecretUnavailableError);
    expect(escalate).not.toHaveBeenCalled();
  });

  it('does not fall back to a human when a claiming handler fails', async () => {
    const escalate = humanAnswers('Allow once');
    const router = new InteractionRouter({ escalate });
    router.registry.register('oauth', {
      canAutoResolve: () => true,
      resolve: () => Promise.reject(new Error('oauth flow refused')),
    });

    await expect(router.route('job-1', ask({ kind: 'oauth' }))).rejects.toThrow(
      'oauth flow refused',
    );
    expect(escalate).not.toHaveBeenCalled();
  });

  it('unregisters a handler, sending its kind back to the human', async () => {
    const escalate = humanAnswers('Allow once');
    const router = new InteractionRouter({ escalate });
    const unregister = router.registry.register('confirm', autoHandler('auto'));

    expect(router.registry.list()).toEqual(['confirm']);
    unregister();
    await router.route('job-1', ask({ kind: 'confirm' }));

    expect(router.registry.list()).toEqual([]);
    expect(escalate).toHaveBeenCalledTimes(1);
  });
});
