import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { BeforeToolCallPayload } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { AllowlistRepository } from '../../repositories/allowlist.repository';
import { createWebApprovalHook, type DangerPredicate } from '../../services/approval-hook';
import { ApprovalsService } from '../../services/approvals.service';

// Verifies the inversion contract end-to-end at the hook layer:
// 1. Safe call → hook returns null instantly (no approvals state touched).
// 2. Dangerous call + approve → hook returns null (allowed) only AFTER
//    the approval resolves.
// 3. Dangerous call + deny → hook returns { error } with the deny reason.

const DATA = '/data';

describe('createWebApprovalHook', () => {
  let approvals: ApprovalsService;

  beforeEach(() => {
    const storage = new InMemoryStorage();
    approvals = new ApprovalsService({ allowlist: new AllowlistRepository({ dataDir: DATA, storage }) });
  });

  function payload(over: Partial<BeforeToolCallPayload> = {}): BeforeToolCallPayload {
    return {
      sessionId: 'sess_1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
      ...over,
    };
  }

  it('passes safe calls through with no approvals work', async () => {
    const isDangerous: DangerPredicate = () => null;
    const hook = createWebApprovalHook({ approvals, isDangerous });

    const result = await hook(payload());
    expect(result).toBeNull();
    expect(approvals.pendingCount()).toBe(0);
  });

  it('dangerous + approve resolves the hook with null (= allow)', async () => {
    const isDangerous: DangerPredicate = () => 'destructive command';
    const hook = createWebApprovalHook({ approvals, isDangerous });

    let approvalId = '';
    approvals.onPending((_, req) => {
      approvalId = req.approvalId;
    });

    const hookPromise = hook(payload());

    // Hook is suspended on the Promise. Drive the resolver from the side.
    await tickUntil(() => approvalId !== '');
    await approvals.approve(approvalId, 'once', 'tab-A');

    expect(await hookPromise).toBeNull();
  });

  it('dangerous + deny resolves the hook with { error } carrying the reason', async () => {
    const isDangerous: DangerPredicate = () => 'destructive command';
    const hook = createWebApprovalHook({ approvals, isDangerous });

    let approvalId = '';
    approvals.onPending((_, req) => {
      approvalId = req.approvalId;
    });

    const hookPromise = hook(payload());
    await tickUntil(() => approvalId !== '');
    await approvals.deny(approvalId, 'no thanks', 'tab-A');

    const result = await hookPromise;
    expect(result).toEqual({ error: 'no thanks' });
  });

  it('passes the danger reason through to the SSE pending payload', async () => {
    const isDangerous: DangerPredicate = (p) =>
      p.toolName === 'terminal' ? 'recursive force-delete of root' : null;
    const hook = createWebApprovalHook({ approvals, isDangerous });

    let pendingReason: string | null | undefined;
    approvals.onPending((_, req) => {
      pendingReason = req.reason;
    });

    const hookPromise = hook(payload());
    await tickUntil(() => pendingReason !== undefined);
    expect(pendingReason).toBe('recursive force-delete of root');

    // Clean up so the test exits.
    approvals.cancelForSession('sess_1');
    await hookPromise;
  });

  it('an allowlist hit auto-allows without surfacing pending', async () => {
    // Pre-record an exact-args allowlist entry; matching calls bypass.
    const storage = new InMemoryStorage();
    const allowlist = new AllowlistRepository({ dataDir: DATA, storage });
    await allowlist.add({
      toolName: 'terminal',
      scope: 'exact-args',
      args: { command: 'rm -rf /' },
    });
    approvals = new ApprovalsService({ allowlist });

    const isDangerous: DangerPredicate = () => 'force-delete';
    const hook = createWebApprovalHook({ approvals, isDangerous });

    let pending = false;
    approvals.onPending(() => {
      pending = true;
    });

    expect(await hook(payload())).toBeNull();
    expect(pending).toBe(false);
  });
});

async function tickUntil(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('tickUntil timed out');
    await new Promise((r) => setImmediate(r));
  }
}
