import type { ActivityHistoryItemWire, SseEvent } from '@ethosagent/web-contracts';
import { ACTIVITY_EVENT_TYPES } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  type ActivityRow,
  buildGroups,
  convertHistoryItem,
  convertSseEvent,
  groupMatchesFilter,
  mergeRows,
} from '../activityFeed';

const CTX = { sessionId: 'sess-a', personalityId: 'agent-a', seq: 1, timestamp: 5_000 };

function live(event: SseEvent, over: Partial<typeof CTX> = {}): ActivityRow {
  const row = convertSseEvent(event, { ...CTX, ...over });
  if (!row) throw new Error(`expected a row for ${event.type}`);
  return row;
}

function historyItem(over: Partial<ActivityHistoryItemWire>): ActivityHistoryItemWire {
  return {
    id: 'span-1',
    kind: 'tool_call',
    name: 'read_file',
    sessionId: 'sess-a',
    personalityId: 'agent-a',
    startedAt: 1_000,
    endedAt: null,
    status: null,
    details: null,
    ...over,
  };
}

// One schema-shaped sample per handled wire type. The table IS the coverage
// assertion: the old page dropped 18 of 24 types into `default: return null`,
// so every type this feed claims to surface has to be pinned here.
const HANDLED: Array<[string, SseEvent]> = [
  ['tool_start', { type: 'tool_start', toolCallId: 'tc1', toolName: 'bash', args: { cmd: 'ls' } }],
  // A DIFFERENT call id from the `tool_start` above on purpose: the two share
  // a key when they describe the same call, which the dedupe tests pin.
  ['tool_end', { type: 'tool_end', toolCallId: 'tc2', toolName: 'bash', ok: true, durationMs: 12 }],
  [
    'tool_progress',
    { type: 'tool_progress', toolName: 'bash', message: 'half way', percent: 50, audience: 'user' },
  ],
  ['done', { type: 'done', text: 'ok', turnCount: 3 }],
  ['error', { type: 'error', error: 'boom', code: 'E_BOOM' }],
  [
    'run_start',
    { type: 'run_start', provider: 'anthropic', model: 'claude', source: 'personality' },
  ],
  [
    'run.update',
    {
      type: 'run.update',
      jobId: 'job-1',
      runner: 'pi',
      status: 'running',
      now: 'editing a file',
      elapsedMs: 900,
      spendUsd: 0.25,
      toolCount: 4,
    },
  ],
  [
    'tool.approval_required',
    {
      type: 'tool.approval_required',
      request: {
        approvalId: 'ap1',
        sessionId: 'sess-a',
        toolCallId: 'tc1',
        toolName: 'bash',
        args: { cmd: 'rm' },
        reason: 'destructive',
      },
    },
  ],
  [
    'approval.resolved',
    { type: 'approval.resolved', approvalId: 'ap1', decision: 'allow', decidedBy: 'tab-1' },
  ],
  [
    'cron.fired',
    { type: 'cron.fired', jobId: 'cron-1', ranAt: '2026-09-01T00:00:00Z', outputPath: null },
  ],
  [
    'clarify.request',
    {
      type: 'clarify.request',
      requestId: 'q1',
      question: 'which branch?',
      options: ['main', 'dev'],
      defaultDeadlineAt: null,
    },
  ],
  ['clarify.resolved', { type: 'clarify.resolved', requestId: 'q1', source: 'user' }],
  [
    'mesh.changed',
    { type: 'mesh.changed', agents: [{ agentId: 'a', capabilities: [], activeSessions: 1 }] },
  ],
  [
    'evolve.skill_pending',
    {
      type: 'evolve.skill_pending',
      skillId: 'sk1',
      personalityId: 'agent-a',
      proposedAt: '2026-09-01T00:00:00Z',
    },
  ],
  [
    'evolve.skill_applied',
    {
      type: 'evolve.skill_applied',
      skillId: 'sk1',
      personalityId: 'agent-a',
      appliedAt: '2026-09-01T00:00:00Z',
    },
  ],
  ['notification', { type: 'notification', message: 'heads up' }],
  ['memory.captured', { type: 'memory.captured', summary: 'user prefers pnpm' }],
  [
    'dry_run_summary',
    {
      type: 'dry_run_summary',
      plan: [{ toolCallId: 'tc1', toolName: 'bash', args: {} }],
      capped: 0,
    },
  ],
  ['message_persisted', { type: 'message_persisted', messageId: 'm1', role: 'assistant' }],
];

// Per-token / per-connection plumbing. Surfacing these would bury every real
// action under streaming noise, so they must stay dropped.
const EXCLUDED: Array<[string, SseEvent]> = [
  ['text_delta', { type: 'text_delta', text: 'hel' }],
  ['thinking_delta', { type: 'thinking_delta', thinking: 'hmm' }],
  ['usage', { type: 'usage', inputTokens: 1, outputTokens: 2, estimatedCostUsd: 0 }],
  ['context_meta', { type: 'context_meta', data: {} }],
  ['stream_meta', { type: 'stream_meta', requestId: 'req-1' }],
  [
    'protocol.upgrade_required',
    { type: 'protocol.upgrade_required', serverVersion: '2', clientVersionExpected: '1' },
  ],
];

describe('convertSseEvent', () => {
  it.each(HANDLED)('surfaces %s as a row with a summary and details', (_name, event) => {
    const row = live(event);
    expect(row.summary.length).toBeGreaterThan(0);
    expect(row.details.length).toBeGreaterThan(0);
    expect(row.live).toBe(true);
    expect(row.personalityId).toBe('agent-a');
  });

  it.each(EXCLUDED)('drops %s', (_name, event) => {
    expect(convertSseEvent(event, CTX)).toBeNull();
  });

  // The allowlist lives in `@ethosagent/web-contracts` and gates BOTH ends —
  // the server's `ChatService.append` and this converter. If the set admits a
  // type this switch has no case for, the server fans it out and the UI throws
  // it away; this pins the two tables to each other.
  it('renders exactly the types ACTIVITY_EVENT_TYPES admits', () => {
    expect(HANDLED.map(([name]) => name).sort()).toEqual([...ACTIVITY_EVENT_TYPES].sort());
    for (const [, event] of EXCLUDED) {
      expect(ACTIVITY_EVENT_TYPES.has(event.type)).toBe(false);
    }
  });

  it('gives every handled type a distinct key within one frame batch', () => {
    const keys = HANDLED.map(([, e], i) => live(e, { seq: i + 1 }).key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keys tool_start and tool_end for the same call identically', () => {
    const start = live({
      type: 'tool_start',
      toolCallId: 'tc9',
      toolName: 'bash',
      args: {},
    });
    const end = live({
      type: 'tool_end',
      toolCallId: 'tc9',
      toolName: 'bash',
      ok: true,
      durationMs: 7,
    });
    expect(start.key).toBe(end.key);
    expect(start.endedAt).toBeNull();
    expect(end.endedAt).toBe(5_000);
  });

  it('collapses successive run.update digests onto one row', () => {
    const a = live({
      type: 'run.update',
      jobId: 'job-7',
      runner: 'pi',
      status: 'running',
      now: 'step 1',
      elapsedMs: 1,
      spendUsd: 0,
      toolCount: 0,
    });
    const b = live({
      type: 'run.update',
      jobId: 'job-7',
      runner: 'pi',
      status: 'done',
      now: 'finished',
      elapsedMs: 9,
      spendUsd: 1,
      toolCount: 3,
    });
    expect(a.key).toBe(b.key);
    const merged = mergeRows(mergeRows(new Map(), [a]), [b]);
    expect(merged.size).toBe(1);
    expect(merged.get(a.key)?.summary).toContain('finished');
  });
});

describe('convertHistoryItem', () => {
  it('reads the tool call id out of the span attrs for a dedupe key', () => {
    const row = convertHistoryItem(
      historyItem({ endedAt: 1_120, status: 'ok', details: { tool_call_id: 'tc1', args: '{}' } }),
    );
    expect(row.key).toBe('tool:sess-a:tc1');
    expect(row.label).toBe('tool_end');
    expect(row.live).toBe(false);
    expect(row.summary).toContain('120ms');
  });

  it('falls back to the span id when no tool_call_id was recorded', () => {
    const row = convertHistoryItem(historyItem({ details: { args: '{}' } }));
    expect(row.key).toBe('span:span-1');
  });

  it('marks a failed tool call as an error', () => {
    const row = convertHistoryItem(historyItem({ endedAt: 1_050, status: 'error' }));
    expect(row.kind).toBe('error');
  });

  it('maps an llm_call span to its own label', () => {
    const row = convertHistoryItem(
      historyItem({ id: 'span-llm', kind: 'llm_call', name: 'claude', endedAt: 1_500 }),
    );
    expect(row.label).toBe('llm_call');
    expect(row.key).toBe('span:span-llm');
  });

  it('opens a group from a turn trace', () => {
    const row = convertHistoryItem(
      historyItem({ id: 'trace-a', kind: 'turn', name: 'turn', endedAt: 1_900, status: 'ok' }),
    );
    expect(row.role).toBe('open');
    expect(row.kind).toBe('done');
    expect(row.key).toBe('turn:trace-a');
  });

  it('stands an untraced event alone and grades it by severity', () => {
    const row = convertHistoryItem(
      historyItem({
        id: 'ev-1',
        kind: 'event',
        name: 'safety.block',
        sessionId: null,
        personalityId: null,
        status: 'error',
        details: { code: 'tool_blocked' },
      }),
    );
    expect(row.role).toBe('standalone');
    expect(row.kind).toBe('error');
    expect(row.summary).toBe('safety.block: tool_blocked');
  });
});

describe('mergeRows', () => {
  it('renders a tool call present in BOTH history and the live stream once', () => {
    const fromHistory = convertHistoryItem(
      historyItem({ endedAt: 1_120, status: 'ok', details: { tool_call_id: 'tc1' } }),
    );
    const liveStart = live({
      type: 'tool_start',
      toolCallId: 'tc1',
      toolName: 'read_file',
      args: {},
    });
    const liveEnd = live({
      type: 'tool_end',
      toolCallId: 'tc1',
      toolName: 'read_file',
      ok: true,
      durationMs: 120,
    });

    const merged = mergeRows(new Map(), [fromHistory, liveStart, liveEnd]);
    expect(merged.size).toBe(1);
    expect(buildGroups(merged.values()).flatMap((g) => g.rows)).toHaveLength(1);
  });

  it('never regresses a finished row back to started', () => {
    const start = live({ type: 'tool_start', toolCallId: 'tc1', toolName: 'bash', args: {} });
    const end = live({
      type: 'tool_end',
      toolCallId: 'tc1',
      toolName: 'bash',
      ok: false,
      durationMs: 5,
    });
    const merged = mergeRows(mergeRows(new Map(), [end]), [start]);
    expect(merged.get(end.key)?.kind).toBe('error');
  });

  it('keeps the earliest timestamp so a closing row does not jump position', () => {
    const start = live(
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'bash', args: {} },
      { timestamp: 100 },
    );
    const end = live(
      { type: 'tool_end', toolCallId: 'tc1', toolName: 'bash', ok: true, durationMs: 5 },
      { timestamp: 900 },
    );
    const merged = mergeRows(mergeRows(new Map(), [start]), [end]);
    expect(merged.get(end.key)?.timestamp).toBe(100);
  });
});

describe('buildGroups', () => {
  it('collects a session turn under the trace that opened it, newest group first', () => {
    const rows = [
      convertHistoryItem(
        historyItem({
          id: 'trace-1',
          kind: 'turn',
          name: 'turn',
          startedAt: 1_000,
          endedAt: 1_800,
        }),
      ),
      convertHistoryItem(historyItem({ id: 'span-1', startedAt: 1_100, endedAt: 1_200 })),
      convertHistoryItem(
        historyItem({ id: 'trace-2', kind: 'turn', name: 'turn', startedAt: 2_000 }),
      ),
      convertHistoryItem(historyItem({ id: 'span-2', startedAt: 2_100 })),
    ];
    const groups = buildGroups(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.startedAt).toBe(2_000);
    expect(groups[0]?.rows.map((r) => r.key)).toEqual(['turn:trace-2', 'span:span-2']);
    expect(groups[1]?.rows.map((r) => r.key)).toEqual(['turn:trace-1', 'span:span-1']);
    expect(groups[1]?.completedAt).toBe(1_800);
  });

  it('closes a group on a live done and records its turn count', () => {
    const rows = [
      live(
        { type: 'run_start', provider: 'p', model: 'm', source: 'personality' },
        { seq: 1, timestamp: 10 },
      ),
      live(
        { type: 'tool_start', toolCallId: 'tc1', toolName: 'bash', args: {} },
        { seq: 2, timestamp: 20 },
      ),
      live({ type: 'done', text: 'x', turnCount: 4 }, { seq: 3, timestamp: 30 }),
    ];
    const [group] = buildGroups(rows);
    expect(group?.rows).toHaveLength(3);
    expect(group?.turnCount).toBe(4);
    expect(group?.isLive).toBe(false);
  });

  it('marks an unfinished group live only when a live row is in it', () => {
    const liveGroup = buildGroups([
      live({ type: 'tool_start', toolCallId: 'tc1', toolName: 'bash', args: {} }),
    ]);
    expect(liveGroup[0]?.isLive).toBe(true);

    const historyGroup = buildGroups([convertHistoryItem(historyItem({ id: 'span-9' }))]);
    expect(historyGroup[0]?.isLive).toBe(false);
  });

  it('keeps two sessions in separate groups', () => {
    const rows = [
      live({ type: 'tool_start', toolCallId: 'a', toolName: 'bash', args: {} }, { seq: 1 }),
      live(
        { type: 'tool_start', toolCallId: 'b', toolName: 'bash', args: {} },
        { seq: 2, sessionId: 'sess-b' },
      ),
    ];
    const groups = buildGroups(rows);
    expect(groups).toHaveLength(2);
    expect(new Set(groups.map((g) => g.sessionId))).toEqual(new Set(['sess-a', 'sess-b']));
  });

  it('stands cron firings alone rather than folding them into a turn', () => {
    const rows = [
      live(
        { type: 'tool_start', toolCallId: 'a', toolName: 'bash', args: {} },
        { seq: 1, timestamp: 10 },
      ),
      live(
        { type: 'cron.fired', jobId: 'c1', ranAt: '2026-09-01T00:00:00Z', outputPath: null },
        { seq: 2, timestamp: 20 },
      ),
    ];
    const groups = buildGroups(rows);
    expect(groups).toHaveLength(2);
    expect(groups[0]?.rows[0]?.label).toBe('cron.fired');
  });

  it('caps the timeline at maxGroups, keeping the newest', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      live(
        { type: 'cron.fired', jobId: `c${i}`, ranAt: `t${i}`, outputPath: null },
        { seq: i + 1, timestamp: i * 10 },
      ),
    );
    const groups = buildGroups(rows, 2);
    expect(groups.map((g) => g.rows[0]?.summary)).toEqual([
      'Cron job fired: c4',
      'Cron job fired: c3',
    ]);
  });
});

describe('groupMatchesFilter', () => {
  const toolGroup = buildGroups([
    live({ type: 'tool_start', toolCallId: 'a', toolName: 'bash', args: {} }),
  ])[0];
  const errorGroup = buildGroups([live({ type: 'error', error: 'boom', code: 'E' })])[0];
  const cronGroup = buildGroups([
    live({ type: 'cron.fired', jobId: 'c1', ranAt: 't', outputPath: null }),
  ])[0];

  it('passes everything under "all"', () => {
    for (const g of [toolGroup, errorGroup, cronGroup]) {
      expect(g && groupMatchesFilter(g, 'all')).toBe(true);
    }
  });

  it('narrows to the matching family', () => {
    expect(toolGroup && groupMatchesFilter(toolGroup, 'tools')).toBe(true);
    expect(toolGroup && groupMatchesFilter(toolGroup, 'errors')).toBe(false);
    expect(errorGroup && groupMatchesFilter(errorGroup, 'errors')).toBe(true);
    expect(cronGroup && groupMatchesFilter(cronGroup, 'cron')).toBe(true);
    expect(cronGroup && groupMatchesFilter(cronGroup, 'tools')).toBe(false);
  });
});
