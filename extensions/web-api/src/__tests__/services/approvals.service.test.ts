import { InMemoryStorage } from '@ethosagent/storage-fs';
import { isEthosError } from '@ethosagent/types';
import type { ApprovalRequest } from '@ethosagent/web-contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { AllowlistRepository } from '../../repositories/allowlist.repository';
import { type ApprovalDecision, ApprovalsService } from '../../services/approvals.service';

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

async function tickUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('tickUntil timed out');
    await new Promise((r) => setImmediate(r));
  }
}
