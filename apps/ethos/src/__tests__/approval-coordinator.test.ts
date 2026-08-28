import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DefaultHookRegistry } from '@ethosagent/core';
import type { Gateway, GatewayBotConfig } from '@ethosagent/gateway';
import type {
  BeforeToolCallPayload,
  BeforeToolCallResult,
  PersonalityRegistry,
  PlatformAdapter,
} from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  ApprovalCoordinator,
  type ApprovalObservability,
  createSlackApprovalHook,
  type PendingApproval,
} from '../approval-coordinator';
import { wireApprovalFlow } from '../commands/gateway';

type AuditRow = Parameters<ApprovalObservability['recordSafetyApproval']>[0];

/** Mirrors the module-private `SYSTEM_DECIDER` in `../approval-coordinator`
 *  (and its twin in web-api's `approvals.service.ts`). */
const SYSTEM_DECIDER = '__ethos_system__';

/** Collecting audit sink — stands in for wiring's EthosObservability. */
function recordingSink(): { rows: AuditRow[]; observability: ApprovalObservability } {
  const rows: AuditRow[] = [];
  return { rows, observability: { recordSafetyApproval: (o) => rows.push(o) } };
}

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

describe('ApprovalCoordinator — safety audit trail', () => {
  it('records an approval decision under audit.approval', async () => {
    const { rows, observability } = recordingSink();
    const coordinator = new ApprovalCoordinator({ observability });
    const pending: PendingApproval[] = [];
    coordinator.onPending((p) => pending.push(p));

    const decision = coordinator.requestApproval({
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
      reason: 'recursive force-delete',
    });
    await coordinator.approve(pending[0].approvalId, 'U7');
    await decision;

    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('approved');
    expect(rows[0].code).toBe('approval.allow');
    expect(rows[0].cause).toContain('recursive force-delete');
    expect(rows[0].details).toMatchObject({
      approvalId: pending[0].approvalId,
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      decidedBy: 'U7',
    });
  });

  it('records a denial with warn severity', async () => {
    const { rows, observability } = recordingSink();
    const coordinator = new ApprovalCoordinator({ observability });
    const pending: PendingApproval[] = [];
    coordinator.onPending((p) => pending.push(p));

    const decision = coordinator.requestApproval({
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: {},
      reason: 'recursive force-delete',
    });
    await coordinator.deny(pending[0].approvalId, 'U7');
    await decision;

    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('denied');
    expect(rows[0].code).toBe('approval.deny');
    expect(rows[0].severity).toBe('warn');
    expect(rows[0].cause).toContain('denied by user');
  });

  it('records the timeout auto-deny — the trail must not hide unattended denials', async () => {
    vi.useFakeTimers();
    try {
      const { rows, observability } = recordingSink();
      const coordinator = new ApprovalCoordinator({ timeoutMs: 1000, observability });
      const decision = coordinator.requestApproval({
        sessionId: 'sid-1',
        toolCallId: 'tc-1',
        toolName: 'terminal',
        args: {},
        reason: null,
      });

      await vi.advanceTimersByTimeAsync(1000);
      await decision;

      expect(rows).toHaveLength(1);
      expect(rows[0].decision).toBe('denied');
      expect(rows[0].cause).toContain('approval timed out');
      // The trail must name the SYSTEM as the decider, so an audit reader can
      // tell an unattended auto-deny from a human one.
      expect(rows[0].details).toMatchObject({ decidedBy: SYSTEM_DECIDER });
    } finally {
      vi.useRealTimers();
    }
  });

  it('a throwing observability sink does not break the approval flow', async () => {
    const observability: ApprovalObservability = {
      recordSafetyApproval: () => {
        throw new Error('observability.db is locked');
      },
    };
    const coordinator = new ApprovalCoordinator({ observability });
    const pending: PendingApproval[] = [];
    const resolved: string[] = [];
    coordinator.onPending((p) => pending.push(p));
    coordinator.onResolved((_id, d) => resolved.push(d));

    const decision = coordinator.requestApproval({
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: {},
      reason: null,
    });
    await expect(coordinator.approve(pending[0].approvalId, 'U1')).resolves.toBeUndefined();

    expect(await decision).toEqual({ decision: 'allow' });
    expect(resolved).toEqual(['allow']);
    expect(coordinator.pendingCount()).toBe(0);
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
    // Generic decision reason + the specific danger reason, so the agent can
    // course-correct instead of retrying blindly.
    expect(result?.error).toBe('denied by user — recursive force-delete');
  });
});

describe('ApprovalCoordinator — shutdown + per-request timeout', () => {
  it('forceSettleAll denies and audits every pending approval, across sessions (T5)', async () => {
    const { rows, observability } = recordingSink();
    const coordinator = new ApprovalCoordinator({ observability, timeoutMs: 60_000 });

    const decisions = ['sid-1', 'sid-1', 'sid-2'].map((sessionId, index) =>
      coordinator.requestApproval({
        sessionId,
        toolCallId: `tc-${index}`,
        toolName: 'terminal',
        args: {},
        reason: null,
      }),
    );
    expect(coordinator.pendingCount()).toBe(3);

    coordinator.forceSettleAll();

    for (const decision of decisions) expect((await decision).decision).toBe('deny');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.decision === 'denied')).toBe(true);
    expect(
      rows.every((r) => (r.details as { decidedBy?: string }).decidedBy === SYSTEM_DECIDER),
    ).toBe(true);
    expect(coordinator.pendingCount()).toBe(0);
  });

  it('timeoutMs: 0 arms no timer — the approval waits for an explicit decision (T7)', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ApprovalCoordinator({ timeoutMs: 0 });
      const pending: PendingApproval[] = [];
      coordinator.onPending((p) => pending.push(p));

      let settled = false;
      const decision = coordinator
        .requestApproval({
          sessionId: 'sid-1',
          toolCallId: 'tc-1',
          toolName: 'terminal',
          args: {},
          reason: null,
        })
        .then((d) => {
          settled = true;
          return d;
        });

      await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
      expect(settled).toBe(false);
      expect(coordinator.pendingCount()).toBe(1);

      await coordinator.deny(pending[0].approvalId, 'U1');
      expect((await decision).decision).toBe('deny');
    } finally {
      vi.useRealTimers();
    }
  });

  it('a per-request timeoutMs overrides the coordinator default', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ApprovalCoordinator({ timeoutMs: 60 * 60 * 1000 });
      const decision = coordinator.requestApproval({
        sessionId: 'sid-1',
        toolCallId: 'tc-1',
        toolName: 'terminal',
        args: {},
        reason: null,
        timeoutMs: 20,
      });

      await vi.advanceTimersByTimeAsync(20);
      expect(await decision).toEqual({ decision: 'deny', reason: 'approval timed out' });
      expect(coordinator.pendingCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a per-request timeoutMs of 0 opts one request out of a short default', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ApprovalCoordinator({ timeoutMs: 20 });
      let settled = false;
      void coordinator
        .requestApproval({
          sessionId: 'sid-1',
          toolCallId: 'tc-1',
          toolName: 'terminal',
          args: {},
          reason: null,
          timeoutMs: 0,
        })
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      expect(coordinator.pendingCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // A delay above the 32-bit signed timer max overflows to ~1ms. Unclamped,
  // an operator reaching for a MORE permissive window would auto-deny every
  // dangerous tool call within milliseconds — a silent total lockout.
  it('a coordinator timeout above the Node timer max is clamped, not overflowed into an instant deny', async () => {
    vi.useFakeTimers();
    try {
      // 30 days — a plausible operator SLA, and well above 2_147_483_647.
      const coordinator = new ApprovalCoordinator({ timeoutMs: 30 * 24 * 60 * 60 * 1000 });
      let settled = false;
      void coordinator
        .requestApproval({
          sessionId: 'sid-1',
          toolCallId: 'tc-1',
          toolName: 'terminal',
          args: {},
          reason: null,
        })
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      expect(coordinator.pendingCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a per-request timeoutMs above the Node timer max is clamped too', async () => {
    vi.useFakeTimers();
    try {
      const coordinator = new ApprovalCoordinator({ timeoutMs: 60_000 });
      let settled = false;
      void coordinator
        .requestApproval({
          sessionId: 'sid-1',
          toolCallId: 'tc-1',
          toolName: 'terminal',
          args: {},
          reason: null,
          timeoutMs: 30 * 24 * 60 * 60 * 1000,
        })
        .then(() => {
          settled = true;
        });

      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe(false);
      expect(coordinator.pendingCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

// T9 — the gateway's config threading and its shutdown handle. `wireApprovalFlow`
// is exercised directly (booting a real gateway in a unit test is impractical),
// following the precedent of `createGatewayMetricsAuthCheck` in
// gateway-metrics-auth.test.ts.
describe('wireApprovalFlow', () => {
  let stateDir: string;
  let previousStateDir: string | undefined;

  beforeAll(async () => {
    // The coordinator's audit sink resolves the process-wide observability
    // store lazily — point it at a throwaway dir so a test never writes to
    // the developer's real ~/.ethos.
    stateDir = await mkdtemp(join(tmpdir(), 'ethos-approval-wiring-'));
    previousStateDir = process.env.ETHOS_STATE_DIR;
    process.env.ETHOS_STATE_DIR = stateDir;
  });

  afterAll(async () => {
    if (previousStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = previousStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });

  /** Approval-capable adapter stub. `posted` resolves once a card is posted,
   *  which is the point the approval is registered with the coordinator. */
  function stubAdapter(
    updateGate?: Promise<void>,
    postGate?: Promise<void>,
  ): {
    adapter: PlatformAdapter;
    posted: Promise<void>;
    calls: { updates: number };
  } {
    let signalPosted = () => {};
    const posted = new Promise<void>((resolve) => {
      signalPosted = resolve;
    });
    const calls = { updates: 0 };
    const adapter = {
      id: 'slack:test',
      botKey: 'bot-1',
      postApprovalCard: async () => {
        signalPosted();
        // `postGate` stands in for a card post still on the wire.
        if (postGate) await postGate;
        return { messageTs: 'ts-1' };
      },
      updateApprovalCard: async () => {
        calls.updates += 1;
        // `updateGate` stands in for a slow Slack/Telegram round trip.
        if (updateGate) await updateGate;
        return { ok: true };
      },
      onApprovalDecision: () => {},
    } as unknown as PlatformAdapter;
    return { adapter, posted, calls };
  }

  function wire(approvalTimeoutMs?: number, updateGate?: Promise<void>, postGate?: Promise<void>) {
    const { adapter, posted, calls } = stubAdapter(updateGate, postGate);
    const hooks = new DefaultHookRegistry();
    const bots = [
      { botKey: 'bot-1', loop: { hooks }, binding: { type: 'personality', name: 'default' } },
    ] as unknown as GatewayBotConfig[];
    const gateway = {
      resolveApprovalRoute: () => ({ adapter, chatId: 'C1', requesterUserId: 'U1' }),
    } as unknown as Gateway;
    const flow = wireApprovalFlow(gateway, bots, [adapter], {
      personalities: { get: () => undefined } as unknown as PersonalityRegistry,
      getProvider: async () => {
        throw new Error('no provider in this test');
      },
      model: 'test-model',
      ...(approvalTimeoutMs !== undefined ? { approvalTimeoutMs } : {}),
    });
    return { flow, hooks, posted, calls };
  }

  function fireDangerousCall(hooks: DefaultHookRegistry): Promise<Partial<BeforeToolCallResult>> {
    return hooks.fireModifying('before_tool_call', {
      sessionId: 'sid-1',
      toolCallId: 'tc-1',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
    } satisfies BeforeToolCallPayload);
  }

  it('threads config.approvalTimeoutMs into the coordinator', async () => {
    const { hooks } = wire(25);
    const result = await fireDangerousCall(hooks);
    // Auto-denied at the configured window, not the coordinator's 10-minute
    // default — which would have hung this test out to its timeout.
    expect(result.error).toContain('approval timed out');
  });

  it('returns a shutdown handle that drains pending approvals', async () => {
    // `0` = no timeout, so only the shutdown handle can settle this call.
    const { flow, hooks, posted } = wire(0);
    const hookResult = fireDangerousCall(hooks);
    await posted;

    await flow.shutdown();

    const result = await hookResult;
    expect(result.error).toContain('gateway shutting down');
  });

  it('shutdown() awaits the in-flight approval card update', async () => {
    // `0` = no timeout, so only the shutdown handle settles this call.
    let releaseUpdate = () => {};
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    const { flow, hooks, posted } = wire(0, updateGate);
    const hookResult = fireDangerousCall(hooks);
    await posted;
    // `posted` fires from inside `postApprovalCard`; let its `.then()` record
    // the card so the settle below takes the normal update path rather than
    // the post-races-resolution one.
    await new Promise((resolve) => setTimeout(resolve, 0));

    let shutdownSettled = false;
    const shutdown = flow.shutdown().then(() => {
      shutdownSettled = true;
    });

    // The deny is already audited, but the card still shows live buttons —
    // `shutdown()` must not resolve (and let the caller stop the adapters)
    // while that update is parked on the gate.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shutdownSettled).toBe(false);

    releaseUpdate();
    await shutdown;
    expect(shutdownSettled).toBe(true);
    await hookResult;
  });

  it('shutdown() awaits a card update created by a post that lands mid-drain', async () => {
    // The gap the single-snapshot drain leaves open: the approval settles while
    // its `postApprovalCard` is STILL in flight, so `onResolved` finds no card
    // and it is the post's own `.then()` — which runs after `shutdown()` would
    // have snapshotted the update set — that fires `updateCard`.
    let releasePost = () => {};
    const postGate = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    let releaseUpdate = () => {};
    const updateGate = new Promise<void>((resolve) => {
      releaseUpdate = resolve;
    });
    // `0` = no timeout, so only the shutdown handle settles this call.
    const { flow, hooks, posted, calls } = wire(0, updateGate, postGate);
    const hookResult = fireDangerousCall(hooks);
    // Inside `postApprovalCard`, parked on `postGate` — the card does not exist yet.
    await posted;

    let shutdownSettled = false;
    const shutdown = flow.shutdown().then(() => {
      shutdownSettled = true;
    });

    // Force-settled and audited, but the post is still on the wire.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(shutdownSettled).toBe(false);
    expect(calls.updates).toBe(0);

    releasePost();
    // The post's `.then()` now drains the raced outcome into `updateCard`.
    // That update was created AFTER shutdown started; it must still be awaited.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(calls.updates).toBe(1);
    expect(shutdownSettled).toBe(false);

    releaseUpdate();
    await shutdown;
    expect(shutdownSettled).toBe(true);
    await hookResult;
  });

  it('shutdown() gives up on a card post that never settles', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A hung adapter must not hold the SIGINT path open forever.
      const neverSettles = new Promise<void>(() => {});
      const { flow, hooks, posted } = wire(0, undefined, neverSettles);
      const hookResult = fireDangerousCall(hooks);
      await posted;

      let shutdownSettled = false;
      const shutdown = flow.shutdown().then(() => {
        shutdownSettled = true;
      });
      // Well past the drain deadline.
      await vi.advanceTimersByTimeAsync(60_000);
      await shutdown;

      expect(shutdownSettled).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('1 card post'));
      await hookResult;
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it('hands back a no-op shutdown handle when no adapter can present approvals', async () => {
    const gateway = { resolveApprovalRoute: () => undefined } as unknown as Gateway;
    const flow = wireApprovalFlow(gateway, [], [], {
      personalities: { get: () => undefined } as unknown as PersonalityRegistry,
      getProvider: async () => {
        throw new Error('no provider in this test');
      },
      model: 'test-model',
    });
    await expect(flow.shutdown()).resolves.toBeUndefined();
  });
});
