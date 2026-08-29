import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteSessionStore } from '@ethosagent/session-sqlite';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { BeforeToolCallPayload, BeforeToolCallResult } from '@ethosagent/types';
import { isEthosError } from '@ethosagent/types';
import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWebApi } from '../../index';
import { AllowlistRepository } from '../../repositories/allowlist.repository';
import {
  type ApprovalDecision,
  type ApprovalObservability,
  ApprovalsService,
} from '../../services/approvals.service';
import {
  makeStubAgentLoop,
  makeStubMemoryProvider,
  makeStubPersonalityRegistry,
} from '../test-helpers';

// The hard test case is the event-loop inversion: a coroutine awaits a
// Promise that only resolves when an unrelated HTTP handler later flips a
// flag. These tests drive that contract.

const DATA = '/data';

describe('ApprovalsService', () => {
  let allowlist: AllowlistRepository;
  let approvals: ApprovalsService;

  beforeEach(() => {
    const storage = new InMemoryStorage();
    allowlist = new AllowlistRepository({ dataDir: DATA, storage });
    approvals = new ApprovalsService({ allowlist });
  });

  /**
   * Wait for the next `pending` event and return its approvalId. Uses a
   * Promise instead of a polling loop so the test doesn't race the
   * `allowlist.matches` async file read inside `requestApproval`.
   */
  function nextPending(): Promise<ApprovalRequest> {
    return new Promise<ApprovalRequest>((resolve) => {
      const off = approvals.onPending((_, req) => {
        off();
        resolve(req);
      });
    });
  }

  it('requestApproval emits pending with a generated approvalId + reason', async () => {
    const pending = nextPending();
    void approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'rm -rf /tmp/x' },
      reason: 'force-delete',
    });

    const req = await pending;
    expect(req.toolName).toBe('terminal');
    expect(req.reason).toBe('force-delete');
    expect(req.approvalId).toMatch(/^.+/);
  });

  it('approve resolves the awaiting request as allow', async () => {
    const pending = nextPending();
    const decision = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'ls' },
    });

    const { approvalId } = await pending;
    await approvals.approve(approvalId, 'once', 'tab-A');
    expect(await decision).toEqual({ decision: 'allow' });
  });

  it('deny resolves with the supplied reason', async () => {
    const pending = nextPending();
    const decision = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    const { approvalId } = await pending;
    await approvals.deny(approvalId, 'too risky', 'tab-A');
    expect(await decision).toEqual({ decision: 'deny', reason: 'too risky' });
  });

  it('deny falls back to "denied by user" when reason is omitted', async () => {
    const pending = nextPending();
    const decision = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    const { approvalId } = await pending;
    await approvals.deny(approvalId, undefined, 'tab-A');
    expect(await decision).toEqual({ decision: 'deny', reason: 'denied by user' });
  });

  it('approve with exact-args persists the entry and matches future calls', async () => {
    const args = { command: 'systemctl restart nginx' };

    const pending = nextPending();
    const first = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args,
    });
    const { approvalId } = await pending;
    await approvals.approve(approvalId, 'exact-args', 'tab-A');
    expect(await first).toEqual({ decision: 'allow' });

    // Second call with the same args bypasses the modal entirely.
    const second = await approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_2',
      toolName: 'terminal',
      args,
    });
    expect(second).toEqual({ decision: 'allow' });

    // …and a different command still hangs (we cancel via deny so the test
    // doesn't block).
    const nextReq = nextPending();
    const third = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_3',
      toolName: 'terminal',
      args: { command: 'echo hi' },
    });
    const { approvalId: nextId } = await nextReq;
    await approvals.deny(nextId, undefined, 'tab-A');
    await third;
  });

  it('approve with any-args persists a wildcard entry', async () => {
    const pending = nextPending();
    const first = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'web_fetch',
      args: { url: 'https://a' },
    });
    const { approvalId } = await pending;
    await approvals.approve(approvalId, 'any-args', 'tab-A');
    await first;

    const second = await approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_2',
      toolName: 'web_fetch',
      args: { url: 'https://different' },
    });
    expect(second).toEqual({ decision: 'allow' });
  });

  it('approve with once does NOT persist to the allowlist', async () => {
    const pending = nextPending();
    const first = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'ls' },
    });
    const { approvalId } = await pending;
    await approvals.approve(approvalId, 'once', 'tab-A');
    await first;
    expect(await allowlist.list()).toEqual([]);
  });

  it('approve emits resolved with the resolving tab id', async () => {
    const events: Array<{ approvalId: string; decision: 'allow' | 'deny'; decidedBy: string }> = [];
    approvals.onResolved((_, approvalId, decision, decidedBy) => {
      events.push({ approvalId, decision, decidedBy });
    });

    const pending = nextPending();
    const decision = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    const { approvalId } = await pending;
    await approvals.approve(approvalId, 'once', 'tab-B');
    await decision;
    expect(events).toEqual([{ approvalId, decision: 'allow', decidedBy: 'tab-B' }]);
  });

  it('approving an unknown approvalId throws INVALID_INPUT', async () => {
    try {
      await approvals.approve('nope', 'once', 'tab-A');
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
      if (isEthosError(err)) expect(err.code).toBe('INVALID_INPUT');
    }
  });

  it('the second decision on the same approvalId throws (one-shot resolution)', async () => {
    const pending = nextPending();
    const decision = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    const { approvalId } = await pending;
    await approvals.approve(approvalId, 'once', 'tab-A');
    await decision;

    try {
      await approvals.deny(approvalId, undefined, 'tab-B');
      throw new Error('expected throw');
    } catch (err) {
      expect(isEthosError(err)).toBe(true);
    }
  });

  it('cancelForSession resolves every pending approval as deny', async () => {
    const decisions: ApprovalDecision[] = [];
    let pendingCount = 0;
    approvals.onPending(() => {
      pendingCount += 1;
    });

    void approvals
      .requestApproval({ sessionId: 'sess_1', toolCallId: 'tc_1', toolName: 'terminal', args: {} })
      .then((d) => decisions.push(d));
    void approvals
      .requestApproval({ sessionId: 'sess_1', toolCallId: 'tc_2', toolName: 'terminal', args: {} })
      .then((d) => decisions.push(d));
    // Different session — should NOT be cancelled.
    void approvals
      .requestApproval({ sessionId: 'sess_2', toolCallId: 'tc_3', toolName: 'terminal', args: {} })
      .then((d) => decisions.push(d));

    // Wait for all three to register before cancelling.
    await tickUntil(() => pendingCount === 3);

    approvals.cancelForSession('sess_1', 'tab closed');
    await tickUntil(() => decisions.length === 2);

    expect(decisions.every((d) => d.decision === 'deny')).toBe(true);
    // The sess_2 approval is still hanging — pending count proves it.
    expect(approvals.pendingCount()).toBe(1);
  });
});

describe('ApprovalsService — safety audit trail', () => {
  type AuditRow = Parameters<ApprovalObservability['recordSafetyApproval']>[0];

  let allowlist: AllowlistRepository;
  let approvals: ApprovalsService;
  let rows: AuditRow[];

  beforeEach(() => {
    const storage = new InMemoryStorage();
    allowlist = new AllowlistRepository({ dataDir: DATA, storage });
    rows = [];
    approvals = new ApprovalsService({
      allowlist,
      observability: { recordSafetyApproval: (o) => rows.push(o) },
    });
  });

  function nextPending(): Promise<ApprovalRequest> {
    return new Promise<ApprovalRequest>((resolve) => {
      const off = approvals.onPending((_, req) => {
        off();
        resolve(req);
      });
    });
  }

  it('records an approval decision', async () => {
    const pending = nextPending();
    const decision = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'rm -rf /tmp/x' },
      reason: 'force-delete',
    });
    const { approvalId } = await pending;
    await approvals.approve(approvalId, 'once', 'tab-A');
    await decision;

    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('approved');
    expect(rows[0].code).toBe('approval.allow');
    expect(rows[0].cause).toContain('force-delete');
    expect(rows[0].details).toMatchObject({
      approvalId,
      sessionId: 'sess_1',
      toolName: 'terminal',
      decidedBy: 'tab-A',
      scope: 'once',
    });
  });

  it('records a denial with warn severity', async () => {
    const pending = nextPending();
    const decision = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    const { approvalId } = await pending;
    await approvals.deny(approvalId, 'too risky', 'tab-A');
    await decision;

    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('denied');
    expect(rows[0].code).toBe('approval.deny');
    expect(rows[0].severity).toBe('warn');
    expect(rows[0].cause).toContain('too risky');
  });

  it('records an allowlist auto-allow — no human decided, so the trail must say so', async () => {
    const args = { command: 'systemctl restart nginx' };
    const pending = nextPending();
    const first = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args,
    });
    const { approvalId } = await pending;
    await approvals.approve(approvalId, 'exact-args', 'tab-A');
    await first;

    await approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_2',
      toolName: 'terminal',
      args,
    });

    expect(rows).toHaveLength(2);
    expect(rows[1].decision).toBe('auto');
    expect(rows[1].code).toBe('approval.auto_allow');
    expect(rows[1].details).toMatchObject({ toolCallId: 'tc_2', decidedBy: 'allowlist' });
  });

  it('records the session-cancel denial', async () => {
    const pending = nextPending();
    const decision = approvals.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    await pending;
    approvals.cancelForSession('sess_1', 'tab closed');
    await decision;

    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('denied');
    expect(rows[0].cause).toContain('tab closed');
    expect(rows[0].details).toMatchObject({ decidedBy: 'system' });
  });

  it('a throwing observability sink does not break the approval flow', async () => {
    const throwing = new ApprovalsService({
      allowlist,
      observability: {
        recordSafetyApproval: () => {
          throw new Error('observability.db is locked');
        },
      },
    });
    const pending = new Promise<ApprovalRequest>((resolve) => {
      const off = throwing.onPending((_, req) => {
        off();
        resolve(req);
      });
    });
    const decision = throwing.requestApproval({
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    const { approvalId } = await pending;

    await expect(throwing.approve(approvalId, 'once', 'tab-A')).resolves.toBeUndefined();
    expect(await decision).toEqual({ decision: 'allow' });
    expect(throwing.pendingCount()).toBe(0);
  });
});

// The auto-deny timeout: the backstop for a closed tab or a dropped SSE
// stream. Without it the agent loop's hook stays suspended forever, with no
// audit row and no bound. Fail-CLOSED — silence never auto-approves.
describe('ApprovalsService — auto-deny timeout', () => {
  type AuditRow = Parameters<ApprovalObservability['recordSafetyApproval']>[0];

  const SYSTEM_DECIDER = '__ethos_system__';

  let allowlist: AllowlistRepository;
  let rows: AuditRow[];

  beforeEach(() => {
    const storage = new InMemoryStorage();
    allowlist = new AllowlistRepository({ dataDir: DATA, storage });
    rows = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeService(timeoutMs?: number): ApprovalsService {
    return new ApprovalsService({
      allowlist,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      observability: { recordSafetyApproval: (o) => rows.push(o) },
    });
  }

  function firstPending(service: ApprovalsService): Promise<ApprovalRequest> {
    return new Promise<ApprovalRequest>((resolve) => {
      const off = service.onPending((_, req) => {
        off();
        resolve(req);
      });
    });
  }

  function request(
    service: ApprovalsService,
    overrides: Partial<Parameters<ApprovalsService['requestApproval']>[0]> = {},
    timeoutMs?: number,
  ): Promise<ApprovalDecision> {
    return service.requestApproval(
      {
        sessionId: 'sess_1',
        toolCallId: 'tc_1',
        toolName: 'terminal',
        args: { command: 'rm -rf /' },
        ...overrides,
      },
      timeoutMs,
    );
  }

  it('auto-denies a pending approval once its timeout elapses (T1)', async () => {
    const approvals = makeService(10);
    const pending = firstPending(approvals);
    const decision = request(approvals);
    await pending;

    await vi.advanceTimersByTimeAsync(10);

    expect(await decision).toEqual({ decision: 'deny', reason: 'approval timed out' });
    expect(approvals.pendingCount()).toBe(0);
    // The trail must not hide unattended denials, and must name the system as
    // the decider so an audit reader can tell it from a human deny.
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('denied');
    expect(rows[0].cause).toContain('approval timed out');
    expect(rows[0].details).toMatchObject({ decidedBy: SYSTEM_DECIDER });
  });

  it('a human answer wins the race and the timer never settles a second time (T2)', async () => {
    const approvals = makeService(50);
    const pending = firstPending(approvals);
    const decision = request(approvals);
    const { approvalId } = await pending;

    await vi.advanceTimersByTimeAsync(10);
    await approvals.approve(approvalId, 'once', 'tab-A');
    expect(await decision).toEqual({ decision: 'allow' });

    // Well past the timeout — the disarmed timer must produce no second row.
    await vi.advanceTimersByTimeAsync(200);
    expect(rows).toHaveLength(1);
    expect(rows[0].decision).toBe('approved');
  });

  it('a manual deny before the timeout leaves no unhandled rejection (T3)', async () => {
    const approvals = makeService(50);
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const pending = firstPending(approvals);
      const decision = request(approvals);
      const { approvalId } = await pending;

      await approvals.deny(approvalId, 'too risky', 'tab-A');
      await decision;
      // `take()` throws on an already-resolved id; a timer firing after a
      // human decision must swallow that, not crash the process.
      await vi.advanceTimersByTimeAsync(200);

      expect(rejections).toEqual([]);
      expect(rows).toHaveLength(1);
      expect(rows[0].cause).toContain('too risky');
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });

  it('forceSettleAll denies and audits every pending approval (T6)', async () => {
    const approvals = makeService(60_000);
    const decisions: ApprovalDecision[] = [];
    for (const [index, sessionId] of ['sess_1', 'sess_1', 'sess_2'].entries()) {
      const pending = firstPending(approvals);
      void request(approvals, { sessionId, toolCallId: `tc_${index}` }).then((d) =>
        decisions.push(d),
      );
      await pending;
    }
    expect(approvals.pendingCount()).toBe(3);

    approvals.forceSettleAll();
    await vi.advanceTimersByTimeAsync(0);

    expect(decisions).toHaveLength(3);
    expect(decisions.every((d) => d.decision === 'deny')).toBe(true);
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.decision === 'denied')).toBe(true);
    expect(approvals.pendingCount()).toBe(0);

    // Each entry's timer was cleared — no late auto-deny row appears.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(rows).toHaveLength(3);
  });

  it('forceSettleAll emits resolved for every pending approval (T6)', async () => {
    const approvals = makeService(60_000);
    const resolved: [string, string, 'allow' | 'deny', string][] = [];
    approvals.onResolved((sessionId, approvalId, decision, decidedBy) =>
      resolved.push([sessionId, approvalId, decision, decidedBy]),
    );
    const approvalIds: string[] = [];
    for (const [index, sessionId] of ['sess_1', 'sess_1', 'sess_2'].entries()) {
      const pending = firstPending(approvals);
      void request(approvals, { sessionId, toolCallId: `tc_${index}` });
      approvalIds.push((await pending).approvalId);
    }

    approvals.forceSettleAll();
    await vi.advanceTimersByTimeAsync(0);

    // Without this the SSE bridge never fires and an open dashboard tab keeps
    // showing an actionable modal for an approval that was already denied.
    expect(resolved).toEqual([
      ['sess_1', approvalIds[0], 'deny', SYSTEM_DECIDER],
      ['sess_1', approvalIds[1], 'deny', SYSTEM_DECIDER],
      ['sess_2', approvalIds[2], 'deny', SYSTEM_DECIDER],
    ]);
  });

  it('timeoutMs: 0 arms no timer — the approval waits for an explicit decision (T7)', async () => {
    const approvals = makeService(0);
    let settled = false;
    const pending = firstPending(approvals);
    const decision = request(approvals).then((d) => {
      settled = true;
      return d;
    });
    const { approvalId } = await pending;

    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000);
    expect(settled).toBe(false);
    expect(approvals.pendingCount()).toBe(1);

    await approvals.deny(approvalId, undefined, 'tab-A');
    expect((await decision).decision).toBe('deny');
  });

  it('a per-request timeoutMs overrides the store default', async () => {
    const approvals = makeService(60 * 60 * 1000);
    const pending = firstPending(approvals);
    const decision = request(approvals, {}, 20);
    await pending;

    await vi.advanceTimersByTimeAsync(20);
    expect(await decision).toEqual({ decision: 'deny', reason: 'approval timed out' });
    expect(approvals.pendingCount()).toBe(0);
  });

  // A delay above the 32-bit signed timer max overflows to ~1ms. Unclamped,
  // an operator reaching for a MORE permissive window would auto-deny every
  // dangerous tool call within milliseconds — a silent total lockout.
  it('a store timeout above the Node timer max is clamped, not overflowed into an instant deny', async () => {
    // 30 days — a plausible operator SLA, and well above 2_147_483_647.
    const approvals = makeService(30 * 24 * 60 * 60 * 1000);
    let settled = false;
    const pending = firstPending(approvals);
    void request(approvals).then(() => {
      settled = true;
    });
    await pending;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    expect(approvals.pendingCount()).toBe(1);
    expect(rows).toHaveLength(0);
  });

  it('a per-request timeoutMs above the Node timer max is clamped too', async () => {
    const approvals = makeService(60_000);
    let settled = false;
    const pending = firstPending(approvals);
    void request(approvals, {}, 30 * 24 * 60 * 60 * 1000).then(() => {
      settled = true;
    });
    await pending;

    await vi.advanceTimersByTimeAsync(60_000);
    expect(settled).toBe(false);
    expect(approvals.pendingCount()).toBe(1);
    expect(rows).toHaveLength(0);
  });
});

// T10 — the config-wiring seam. Asserted through observable behavior (a hook
// that auto-denies at the configured window) rather than by reaching into the
// service `createWebApi` builds internally. Real timers: the window is 30ms.
describe('createWebApi — approvalTimeoutMs threading', () => {
  it('threads the configured window into the approvals store', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ethos-approval-timeout-'));
    const store = new SQLiteSessionStore(':memory:');
    try {
      const loop = makeStubAgentLoop();
      createWebApi({
        dataDir: dir,
        sessionStore: store,
        memoryProvider: makeStubMemoryProvider(),
        agentLoop: loop,
        personalities: makeStubPersonalityRegistry(),
        chatDefaults: { model: 'claude-test', provider: 'anthropic' },
        approvalTimeoutMs: 30,
        dangerPredicate: async () => 'every terminal call requires approval (test rule)',
      });

      const result: Partial<BeforeToolCallResult> = await loop.hooks.fireModifying(
        'before_tool_call',
        {
          sessionId: 'sess_timeout',
          toolCallId: 'tc_timeout',
          toolName: 'terminal',
          args: { command: 'rm -rf /' },
        } satisfies BeforeToolCallPayload,
      );

      expect(result.error).toContain('approval timed out');
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

async function tickUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('tickUntil timed out');
    await new Promise((r) => setImmediate(r));
  }
}
