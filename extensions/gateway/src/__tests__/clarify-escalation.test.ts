// I20 / §4.6 rung 3, gateway wiring — the sweep that turns "a run has been
// waiting on you for a minute" into a message in the lane the run came from.
//
// The sweep's own decision table is tested in `@ethosagent/core`
// (`clarify-escalation.test.ts`, including T4's two-process case). What is
// proven HERE is the wiring the core function cannot see: the notice goes
// through the gateway's durable outbound path to the ORIGIN lane, a job
// belonging to another bot in a shared store is left alone, and a spent claim
// keeps the next sweep quiet.

import type { AgentLoop } from '@ethosagent/core';
import { ClarifyBridge } from '@ethosagent/core';
import type {
  BackgroundJob,
  ClarifyStore,
  PendingClarify,
  PlatformAdapter,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';

const T0 = Date.parse('2026-08-20T12:00:00.000Z');

function stubAdapter(): PlatformAdapter {
  return {
    id: 'test',
    displayName: 'Test',
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue({ ok: true, messageId: '1' }),
    onMessage: vi.fn(),
    health: vi.fn().mockResolvedValue({ ok: true }),
  };
}

function sentTexts(adapter: PlatformAdapter): string[] {
  return (adapter.send as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[1]?.text)
    .filter((t): t is string => typeof t === 'string');
}

/** Just enough `ClarifyStore` for the sweep's `list()`. */
function memoryClarifyStore(rows: PendingClarify[]): ClarifyStore {
  return {
    list: async () => rows,
    add: async () => {},
    get: async () => null,
    remove: async () => {},
    update: async () => {},
    expired: async () => [],
  };
}

function pendingRow(overrides: Partial<PendingClarify> = {}): PendingClarify {
  return {
    requestId: 'rq-1',
    sessionId: 'child:job-1',
    jobId: 'job-1',
    surfaceType: 'telegram',
    surfaceContext: {},
    question: 'Which migration path?',
    answerableBy: 'anyone',
    createdAt: new Date(T0).toISOString(),
    defaultDeadlineAt: null,
    presentedAt: new Date(T0).toISOString(),
    ...overrides,
  };
}

function blockedJob(overrides: Partial<BackgroundJob> = {}): BackgroundJob {
  return {
    id: 'job-1',
    owner: 'proc-1',
    parentSessionKey: 'parent',
    rootSessionKey: 'root',
    childSessionKey: 'child:job-1',
    depth: 1,
    status: 'blocked',
    label: 'migrate',
    prompt: 'do a thing',
    spendUsd: 0,
    createdAt: T0,
    originPlatform: 'test',
    originBotKey: 'b1',
    originChatId: 'chat-1',
    ...overrides,
  };
}

/** The two `JobStore` members the sweep touches, plus an insert-wins claim. */
function fakeJobStore(jobs: BackgroundJob[]) {
  const claims = new Set<string>();
  return {
    claims,
    store: {
      get: async (id: string) => jobs.find((j) => j.id === id) ?? null,
      claimNotice: async (requestId: string) => {
        if (claims.has(requestId)) return false;
        claims.add(requestId);
        return true;
      },
      releaseNotice: async (requestId: string) => {
        claims.delete(requestId);
      },
    } as unknown as import('@ethosagent/types').JobStore,
  };
}

function makeGateway(opts: {
  rows: PendingClarify[];
  jobs: BackgroundJob[];
  adapter: PlatformAdapter;
  botKey?: string;
}) {
  const bridge = new ClarifyBridge(memoryClarifyStore(opts.rows));
  const loop = { clarifyBridge: bridge, hooks: { registerVoid: vi.fn(() => () => {}) } };
  const jobs = fakeJobStore(opts.jobs);
  const gw = new Gateway({
    bots: [
      {
        botKey: opts.botKey ?? 'b1',
        loop: loop as unknown as AgentLoop,
        binding: { type: 'personality', name: 'default' },
        jobStore: jobs.store,
      },
    ],
    adapters: new Map([['test', opts.adapter]]),
    clarifySweepIntervalMs: 0,
  });
  return { gw, claims: jobs.claims };
}

describe('Gateway.sweepClarifyEscalations (§4.6 rung 3)', () => {
  it('pushes the notice to the run’s origin lane once the silence passes 60s, then stays quiet', async () => {
    const adapter = stubAdapter();
    const { gw } = makeGateway({ rows: [pendingRow()], jobs: [blockedJob()], adapter });

    expect(await gw.sweepClarifyEscalations(T0 + 59_000)).toEqual({ pushed: 0, failed: 0 });
    expect(sentTexts(adapter)).toHaveLength(0);

    expect(await gw.sweepClarifyEscalations(T0 + 60_000)).toEqual({ pushed: 1, failed: 0 });
    const sent = (adapter.send as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(sent?.[0]).toBe('chat-1');
    expect(sent?.[1]?.text).toContain('migrate');
    expect(sent?.[1]?.text).toContain('Which migration path?');

    // The claim is spent: a later sweep over the same still-unanswered row is
    // a no-op, which is what stops a 5-second poll becoming a 5-second nag.
    expect(await gw.sweepClarifyEscalations(T0 + 600_000)).toEqual({ pushed: 0, failed: 0 });
    expect(sentTexts(adapter)).toHaveLength(1);

    await gw.shutdown();
  });

  it('never pushes a job whose origin lane belongs to another bot in a shared store', async () => {
    const adapter = stubAdapter();
    const { gw, claims } = makeGateway({
      rows: [pendingRow()],
      jobs: [blockedJob({ originBotKey: 'someone-else' })],
      adapter,
    });

    expect(await gw.sweepClarifyEscalations(T0 + 600_000)).toEqual({ pushed: 0, failed: 0 });
    expect(sentTexts(adapter)).toHaveLength(0);
    // Skipped, not consumed — the owning process must still be able to claim it.
    expect(claims.size).toBe(0);

    await gw.shutdown();
  });

  it('hands the claim back when the platform does not confirm and no ledger is wired', async () => {
    const adapter = stubAdapter();
    (adapter.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, error: 'down' });
    const { gw, claims } = makeGateway({ rows: [pendingRow()], jobs: [blockedJob()], adapter });

    expect(await gw.sweepClarifyEscalations(T0 + 600_000)).toEqual({ pushed: 0, failed: 1 });
    expect(claims.size).toBe(0);

    // With the platform back, the next sweep gets its chance.
    (adapter.send as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, messageId: '2' });
    expect(await gw.sweepClarifyEscalations(T0 + 600_000)).toEqual({ pushed: 1, failed: 0 });

    await gw.shutdown();
  });
});
