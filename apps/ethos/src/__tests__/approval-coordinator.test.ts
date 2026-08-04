import type { BeforeToolCallPayload } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import {
  ApprovalCoordinator,
  createSlackApprovalHook,
  type PendingApproval,
} from '../approval-coordinator';

function toolCall(overrides: Partial<BeforeToolCallPayload> = {}): BeforeToolCallPayload {
  return {
    sessionId: 'sid-1',
    toolCallId: 'tc-1',
    toolName: 'terminal',
    args: { command: 'rm -rf /' },
    ...overrides,
  };
}

describe('ApprovalCoordinator', () => {
  it('emits a pending approval with a stable id and resolves on approve', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending: PendingApproval[] = [];
    coordinator.onPending((p) => pending.push(p));

    const decision = coordinator.requestApproval({
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
      reason: 'danger',
    });

    expect(pending).toHaveLength(1);
    expect(pending[0].sessionId).toBe('sid-1');
    expect(pending[0].toolName).toBe('terminal');
    expect(pending[0].reason).toBe('danger');
    expect(typeof pending[0].approvalId).toBe('string');

    await coordinator.approve(pending[0].approvalId, 'U1');
    expect(await decision).toEqual({ decision: 'allow' });
  });

  it('resolves with a deny decision and reason on deny', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending: PendingApproval[] = [];
    coordinator.onPending((p) => pending.push(p));

    const decision = coordinator.requestApproval({
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: {},
      reason: 'danger',
    });

    await coordinator.deny(pending[0].approvalId, 'U1');
    const resolved = await decision;
    expect(resolved.decision).toBe('deny');
  });

  it('emits resolved with the decider once a decision lands', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending: PendingApproval[] = [];
    const resolved: Array<{ approvalId: string; decision: string; decidedBy: string }> = [];
    coordinator.onPending((p) => pending.push(p));
    coordinator.onResolved((approvalId, decision, decidedBy) =>
      resolved.push({ approvalId, decision, decidedBy }),
    );

    const decision = coordinator.requestApproval({
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: {},
      reason: null,
    });
    await coordinator.approve(pending[0].approvalId, 'U7');
    await decision;

    expect(resolved).toEqual([
      { approvalId: pending[0].approvalId, decision: 'allow', decidedBy: 'U7' },
    ]);
  });

  it('is idempotent — a second decision on the same approval is a no-op', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending: PendingApproval[] = [];
    coordinator.onPending((p) => pending.push(p));

    const decision = coordinator.requestApproval({
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: {},
      reason: null,
    });
    await coordinator.approve(pending[0].approvalId, 'U1');
    // A stale Deny click arriving after the Allow must not throw or flip it.
    await expect(coordinator.deny(pending[0].approvalId, 'U2')).resolves.toBeUndefined();
    expect(await decision).toEqual({ decision: 'allow' });
  });

  it('auto-denies a pending approval once its timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ApprovalCoordinator({ timeoutMs: 1000 });
      const resolved: string[] = [];
      coordinator.onResolved((approvalId) => resolved.push(approvalId));

      const decision = coordinator.requestApproval({
        sessionId: 'sid-1',
        toolCallId: 'tc-1',
        toolName: 'terminal',
        args: {},
        reason: null,
      });

      await vi.advanceTimersByTimeAsync(1000);
      const settled = await decision;
      expect(settled.decision).toBe('deny');
      expect(resolved).toHaveLength(1);
      expect(coordinator.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not fire the timeout once a decision has landed', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ApprovalCoordinator({ timeoutMs: 1000 });
      const pending: PendingApproval[] = [];
      coordinator.onPending((p) => pending.push(p));
      const resolved: Array<{ decision: string }> = [];
      coordinator.onResolved((_id, decision) => resolved.push({ decision }));

      const decision = coordinator.requestApproval({
        sessionId: 'sid-1',
        toolCallId: 'tc-1',
        toolName: 'terminal',
        args: {},
        reason: null,
      });
      await coordinator.approve(pending[0].approvalId, 'U1');
      await vi.advanceTimersByTimeAsync(5000);

      expect(await decision).toEqual({ decision: 'allow' });
      // Exactly one resolved event — the timeout must not double-fire.
      expect(resolved).toEqual([{ decision: 'allow' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only the original requester may resolve an approval bound to one', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending: PendingApproval[] = [];
    coordinator.onPending((p) => pending.push(p));

    const decision = coordinator.requestApproval({
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: {},
      reason: null,
      requesterUserId: 'U-owner',
    });

    // A bystander's click is rejected — the approval stays pending.
    await coordinator.approve(pending[0].approvalId, 'U-bystander');
    expect(coordinator.pendingCount()).toBe(1);

    // The requester's click resolves it.
    await coordinator.approve(pending[0].approvalId, 'U-owner');
    expect(await decision).toEqual({ decision: 'allow' });
  });

  it('system resolutions (timeout, cancel) bypass the requester check', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending: PendingApproval[] = [];
    coordinator.onPending((p) => pending.push(p));

    const decision = coordinator.requestApproval({
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: {},
      reason: null,
      requesterUserId: 'U-owner',
    });

    coordinator.cancelForSession('sid-1');
    expect((await decision).decision).toBe('deny');
  });

  it('cancelForSession denies every pending approval for that session', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending: PendingApproval[] = [];
    coordinator.onPending((p) => pending.push(p));

    const d1 = coordinator.requestApproval({
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: {},
      reason: null,
    });
    const d2 = coordinator.requestApproval({
      sessionId: 'sid-2',
      toolCallId: 'tc-2',
      toolName: 'terminal',
      args: {},
      reason: null,
    });

    coordinator.cancelForSession('sid-1');
    expect((await d1).decision).toBe('deny');

    // sid-2 is untouched and still resolvable.
    await coordinator.approve(pending[1].approvalId, 'U1');
    expect((await d2).decision).toBe('allow');
  });
});

describe('createSlackApprovalHook', () => {
  it('passes through non-dangerous tool calls without prompting', async () => {
    const coordinator = new ApprovalCoordinator();
    const requestSpy = vi.spyOn(coordinator, 'requestApproval');
    const hook = createSlackApprovalHook({
      coordinator,
      isDangerous: async () => null,
      resolveApprovalTarget: () => ({ requesterUserId: 'U1' }),
    });

    const result = await hook(toolCall());
    expect(result).toBeNull();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('passes a dangerous call through untouched when the turn has no Slack surface', async () => {
    // A Discord/Email turn sharing a Slack-bound loop: `resolveApprovalTarget`
    // returns undefined (no approval-capable route). The hook must NOT
    // suspend or deny — it passes through so the loop's other guards (the
    // synchronous terminal hard-block) decide. Registering the hook on a
    // shared loop must not change behavior for non-Slack channels.
    const coordinator = new ApprovalCoordinator();
    const requestSpy = vi.spyOn(coordinator, 'requestApproval');
    const hook = createSlackApprovalHook({
      coordinator,
      isDangerous: async () => 'recursive force-delete',
      resolveApprovalTarget: () => undefined,
    });

    const result = await hook(toolCall());
    expect(result).toBeNull();
    expect(requestSpy).not.toHaveBeenCalled();
  });

  it('prompts for a dangerous call and returns null when allowed', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending: PendingApproval[] = [];
    coordinator.onPending((p) => pending.push(p));
    const hook = createSlackApprovalHook({
      coordinator,
      isDangerous: async () => 'recursive force-delete',
      resolveApprovalTarget: () => ({ requesterUserId: 'U1' }),
    });

    const hookPromise = hook(toolCall());
    // Hook is suspended waiting on the decision.
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await coordinator.approve(pending[0].approvalId, 'U1');

    expect(await hookPromise).toBeNull();
  });

  it('returns an { error } for a denied dangerous call', async () => {
    const coordinator = new ApprovalCoordinator();
    const pending: PendingApproval[] = [];
    coordinator.onPending((p) => pending.push(p));
    const hook = createSlackApprovalHook({
      coordinator,
      isDangerous: async () => 'recursive force-delete',
      resolveApprovalTarget: () => ({ requesterUserId: 'U1' }),
    });

    const hookPromise = hook(toolCall());
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    await coordinator.deny(pending[0].approvalId, 'U1');

    const result = await hookPromise;
    expect(result).not.toBeNull();
    expect(result?.error).toBeTruthy();
  });
});
