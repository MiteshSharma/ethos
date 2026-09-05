import type { SseEvent } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  applyAction as applyChatAction,
  applyEvent as applyChatEvent,
  type ChatState,
  initialChatState,
} from '../chat-reducer';
import {
  applyEvent,
  applyTurnAborted,
  type DrawerStreamState,
  ENTRIES_PER_TURN_CAP,
  emptyDrawerState,
  NOTIFICATIONS_CAP,
  RESULT_CHARS_CAP,
  TURNS_CAP,
} from '../drawer-reducer';
import { summariseTrail, type TrailEntry } from '../trail';

describe('drawer-reducer', () => {
  const initial: DrawerStreamState = emptyDrawerState('s1');
  const NOW = 1_700_000_000_000;

  const runStart = {
    type: 'run_start' as const,
    provider: 'anthropic',
    model: 'claude',
    source: 'personality' as const,
  };

  /** Entries of the newest turn — what the drawer's top group renders. */
  function newestEntries(state: DrawerStreamState): TrailEntry[] {
    const turnId = state.turns[0]?.turnId;
    return turnId === undefined ? [] : (state.trail[turnId] ?? []);
  }

  describe('turn boundaries', () => {
    it('opens a turn on run_start and groups tool calls under it', () => {
      let state = applyEvent(initial, runStart, NOW);
      state = applyEvent(
        state,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'read_file', args: { path: '/a' } },
        NOW + 5,
      );
      state = applyEvent(
        state,
        { type: 'tool_start', toolCallId: 'c2', toolName: 'bash', args: {} },
        NOW + 6,
      );

      expect(state.turns).toHaveLength(1);
      expect(state.turns[0]).toMatchObject({ ordinal: 1, startedAt: NOW, closed: false });
      expect(newestEntries(state)).toEqual([
        {
          kind: 'action',
          toolCallId: 'c1',
          toolName: 'read_file',
          args: { path: '/a' },
          status: 'running',
        },
        { kind: 'action', toolCallId: 'c2', toolName: 'bash', args: {}, status: 'running' },
      ]);
    });

    it('starts a second turn on the next run_start, newest first', () => {
      let state = applyEvent(initial, runStart, NOW);
      state = applyEvent(
        state,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
        NOW + 1,
      );
      state = applyEvent(state, { type: 'done', text: '', turnCount: 1 }, NOW + 2);
      state = applyEvent(state, runStart, NOW + 3);
      state = applyEvent(
        state,
        { type: 'tool_start', toolCallId: 'c2', toolName: 'web_search', args: {} },
        NOW + 4,
      );

      expect(state.turns.map((t) => t.ordinal)).toEqual([2, 1]);
      expect(newestEntries(state).map((e) => (e.kind === 'action' ? e.toolCallId : e.id))).toEqual([
        'c2',
      ]);
    });

    it('closes the open turn on done', () => {
      const state = applyEvent(
        applyEvent(initial, runStart, NOW),
        { type: 'done', text: 'hi', turnCount: 1 },
        NOW + 1,
      );
      expect(state.turns[0]?.closed).toBe(true);
    });

    it('closes the open turn on error', () => {
      const state = applyEvent(
        applyEvent(initial, runStart, NOW),
        { type: 'error', error: 'boom', code: 'x' },
        NOW + 1,
      );
      expect(state.turns[0]?.closed).toBe(true);
    });

    it('opens an implicit turn when tool_start arrives with no open turn', () => {
      // A reconnect can deliver tool events before any run_start — nothing is
      // dropped.
      const state = applyEvent(
        initial,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
        NOW,
      );
      expect(state.turns).toHaveLength(1);
      expect(state.turns[0]).toMatchObject({ ordinal: 1, startedAt: NOW });
      expect(newestEntries(state)).toHaveLength(1);
    });

    it('opens an implicit turn when the newest turn is already closed', () => {
      let state = applyEvent(initial, runStart, NOW);
      state = applyEvent(state, { type: 'done', text: '', turnCount: 1 }, NOW + 1);
      state = applyEvent(
        state,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
        NOW + 2,
      );
      expect(state.turns.map((t) => t.ordinal)).toEqual([2, 1]);
      expect(newestEntries(state)).toHaveLength(1);
    });

    it('evicts the oldest turns past TURNS_CAP, entries and all', () => {
      let state = initial;
      for (let i = 0; i < TURNS_CAP + 5; i++) {
        state = applyEvent(state, runStart, NOW + i);
        state = applyEvent(
          state,
          { type: 'tool_start', toolCallId: `c${i}`, toolName: 'bash', args: {} },
          NOW + i,
        );
      }
      expect(state.turns).toHaveLength(TURNS_CAP);
      expect(state.turns[0]?.ordinal).toBe(TURNS_CAP + 5);
      // The trail never outlives the turns it belongs to.
      expect(Object.keys(state.trail)).toHaveLength(TURNS_CAP);
      expect(state.trail['turn-1']).toBeUndefined();
    });

    it('bounds ONE turn too — a long agentic turn cannot grow without limit', () => {
      // `TURNS_CAP` alone bounds nothing: a single turn can make hundreds of
      // calls, and every entry now retains a result string.
      let state = applyEvent(initial, runStart, NOW);
      for (let i = 0; i < ENTRIES_PER_TURN_CAP + 3; i++) {
        state = applyEvent(
          state,
          { type: 'tool_start', toolCallId: `c${i}`, toolName: 'bash', args: {} },
          NOW + i,
        );
      }
      expect(newestEntries(state)).toHaveLength(ENTRIES_PER_TURN_CAP);
      // Oldest out, newest kept.
      const ids = newestEntries(state).map((e) => (e.kind === 'action' ? e.toolCallId : e.id));
      expect(ids[0]).toBe('c3');
      expect(ids[ids.length - 1]).toBe(`c${ENTRIES_PER_TURN_CAP + 2}`);
      // And the loss is COUNTED, not silent — the drawer says what it dropped.
      expect(state.turns[0]?.droppedEntries).toBe(3);
    });

    it('counts nothing dropped while a turn stays under the cap', () => {
      const state = applyEvent(
        applyEvent(initial, runStart, NOW),
        { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
        NOW + 1,
      );
      expect(state.turns[0]?.droppedEntries).toBe(0);
    });

    it('clears turns and trail when the session changes', () => {
      expect(emptyDrawerState('s2')).toEqual({
        sessionId: 's2',
        turns: [],
        trail: {},
        notifications: [],
        usage: null,
      });
    });
  });

  describe('audience boundary', () => {
    it('surfaces nothing for internal tool calls', () => {
      const started = applyEvent(
        applyEvent(initial, runStart, NOW),
        {
          type: 'tool_start',
          toolCallId: 'c1',
          toolName: 'inner',
          args: {},
          audience: 'internal',
        },
        NOW + 1,
      );
      expect(newestEntries(started)).toEqual([]);

      const ended = applyEvent(
        started,
        {
          type: 'tool_end',
          toolCallId: 'c1',
          toolName: 'inner',
          ok: true,
          durationMs: 5,
          audience: 'internal',
        },
        NOW + 2,
      );
      expect(ended).toBe(started); // referential equality — no churn
    });
  });

  describe('tool_end', () => {
    it('flips the matching action to ok with its duration', () => {
      let state = applyEvent(initial, runStart, NOW);
      state = applyEvent(
        state,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
        NOW + 1,
      );
      state = applyEvent(
        state,
        {
          type: 'tool_end',
          toolCallId: 'c1',
          toolName: 'bash',
          ok: true,
          durationMs: 320,
          result: 'ok!',
        },
        NOW + 321,
      );
      expect(newestEntries(state)[0]).toMatchObject({
        toolCallId: 'c1',
        status: 'ok',
        durationMs: 320,
        result: 'ok!',
      });
    });

    it('caps a retained result and SAYS it was cut', () => {
      let state = applyEvent(initial, runStart, NOW);
      state = applyEvent(
        state,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
        NOW + 1,
      );
      const huge = 'x'.repeat(RESULT_CHARS_CAP * 3);
      state = applyEvent(
        state,
        {
          type: 'tool_end',
          toolCallId: 'c1',
          toolName: 'bash',
          ok: true,
          durationMs: 1,
          result: huge,
        },
        NOW + 2,
      );
      const entry = newestEntries(state)[0];
      const result = entry?.kind === 'action' ? (entry.result ?? '') : '';
      expect(result.length).toBeLessThan(huge.length);
      expect(result).toContain(`[truncated — ${huge.length} chars total]`);
    });

    it('marks a failed tool `failed`, not `error`', () => {
      let state = applyEvent(initial, runStart, NOW);
      state = applyEvent(
        state,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
        NOW + 1,
      );
      state = applyEvent(
        state,
        { type: 'tool_end', toolCallId: 'c1', toolName: 'bash', ok: false, durationMs: 50 },
        NOW + 51,
      );
      expect(newestEntries(state)[0]).toMatchObject({ status: 'failed', durationMs: 50 });
    });

    it('resolves a call whose turn has already closed', () => {
      let state = applyEvent(initial, runStart, NOW);
      state = applyEvent(
        state,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
        NOW + 1,
      );
      state = applyEvent(state, { type: 'done', text: '', turnCount: 1 }, NOW + 2);
      state = applyEvent(state, runStart, NOW + 3);
      state = applyEvent(
        state,
        { type: 'tool_end', toolCallId: 'c1', toolName: 'bash', ok: true, durationMs: 12 },
        NOW + 4,
      );
      expect(state.trail['turn-1']?.[0]).toMatchObject({ status: 'ok', durationMs: 12 });
    });

    it('is a no-op for unknown toolCallIds', () => {
      const next = applyEvent(
        initial,
        { type: 'tool_end', toolCallId: 'unknown', toolName: 'bash', ok: true, durationMs: 10 },
        NOW,
      );
      expect(next).toBe(initial);
    });
  });

  describe('usage', () => {
    it('replaces the usage block (latest wins)', () => {
      const first = applyEvent(
        initial,
        { type: 'usage', inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 },
        NOW,
      );
      const second = applyEvent(
        first,
        { type: 'usage', inputTokens: 250, outputTokens: 80, estimatedCostUsd: 0.0025 },
        NOW + 1000,
      );
      expect(second.usage).toEqual({
        inputTokens: 250,
        outputTokens: 80,
        estimatedCostUsd: 0.0025,
      });
    });
  });

  describe('push notifications', () => {
    it('appends cron.fired with deep-link to /cron', () => {
      const next = applyEvent(
        initial,
        {
          type: 'cron.fired',
          jobId: 'morning-brief',
          ranAt: '2026-04-28T10:00:00Z',
          outputPath: null,
        },
        NOW,
      );
      expect(next.notifications).toHaveLength(1);
      expect(next.notifications[0]).toMatchObject({
        kind: 'cron.fired',
        deepLink: '/cron',
        summary: expect.stringContaining('morning-brief'),
      });
    });

    it('appends mesh.changed with deep-link to /mesh', () => {
      const next = applyEvent(
        initial,
        {
          type: 'mesh.changed',
          agents: [{ agentId: 'a', capabilities: ['x'], activeSessions: 0 }],
        },
        NOW,
      );
      expect(next.notifications[0]).toMatchObject({ kind: 'mesh.changed', deepLink: '/mesh' });
    });

    it('appends evolve.skill_pending with deep-link to /skills', () => {
      const next = applyEvent(
        initial,
        {
          type: 'evolve.skill_pending',
          skillId: 'tighten-prose',
          personalityId: 'reviewer',
          proposedAt: '2026-04-28T10:00:00Z',
        },
        NOW,
      );
      expect(next.notifications[0]).toMatchObject({
        kind: 'evolve.skill_pending',
        deepLink: '/skills',
      });
    });

    it('dedupes by id (Last-Event-ID replay safety)', () => {
      const event = {
        type: 'cron.fired' as const,
        jobId: 'morning-brief',
        ranAt: '2026-04-28T10:00:00Z',
        outputPath: null,
      };
      const once = applyEvent(initial, event, NOW);
      const twice = applyEvent(once, event, NOW + 1);
      expect(twice.notifications).toHaveLength(1);
    });

    it('caps notifications at NOTIFICATIONS_CAP', () => {
      let state = initial;
      for (let i = 0; i < NOTIFICATIONS_CAP + 5; i++) {
        state = applyEvent(
          state,
          {
            type: 'cron.fired',
            jobId: `job-${i}`,
            ranAt: `2026-04-28T10:00:0${i % 10}Z`,
            outputPath: null,
          },
          NOW + i,
        );
      }
      expect(state.notifications).toHaveLength(NOTIFICATIONS_CAP);
    });
  });

  describe('parity with the chat footer', () => {
    // Contract §4: "one trail, two renderers … they cannot disagree". Sharing
    // the TYPES was not enough — each reducer used to hand-roll its own
    // event→trail transition, and the drawer's ignored `tool_progress` and
    // `tool.approval_required` entirely. This drives the SAME events through
    // both and compares the rows.
    const stream: SseEvent[] = [
      runStart,
      {
        type: 'tool.approval_required',
        request: {
          approvalId: 'ap1',
          sessionId: 's1',
          toolCallId: 'c1',
          toolName: 'terminal',
          args: { command: 'rm -rf /' },
          reason: 'recursive force-delete',
        },
      },
      { type: 'tool_start', toolCallId: 'c1', toolName: 'terminal', args: { command: 'ls' } },
      {
        type: 'tool_end',
        toolCallId: 'c1',
        toolName: 'terminal',
        ok: true,
        durationMs: 12,
        result: 'out',
      },
      {
        type: 'tool_progress',
        toolName: '_grounding',
        // The full wire format: claim, evidence and the call it cites. Parsing
        // lives in the shared transition, so neither surface can parse it
        // differently — or, as before, only one of them parse it at all.
        message: '"tests pass" — terminal exited 1 [ref:c1]',
        audience: 'user',
      },
      { type: 'tool_progress', toolName: 'terminal', message: 'reading', audience: 'user' },
      { type: 'tool_progress', toolName: 'inner', message: 'quiet', audience: 'internal' },
      // A second call that never reports back, and the stream dying under it —
      // the terminal path. Divergence here was the whole bug: the drawer marked
      // the turn closed and left `c2` running for ever while the footer had
      // already settled it `failed`.
      { type: 'tool_start', toolCallId: 'c2', toolName: 'read_file', args: { path: '/a' } },
      { type: 'error', error: 'stream died', code: 'x' },
    ];

    /** Rows minus the ids the two surfaces mint differently. */
    function rows(entries: TrailEntry[]) {
      return entries.map((e) =>
        e.kind === 'action'
          ? { kind: e.kind, toolName: e.toolName, status: e.status, durationMs: e.durationMs }
          : {
              kind: e.kind,
              claim: e.claim,
              evidence: e.evidence,
              citesToolCallId: e.citesToolCallId,
            },
      );
    }

    it('the drawer and the chat footer build the same rows from the same events', () => {
      let drawer: DrawerStreamState = initial;
      let chat: ChatState = initialChatState;
      // The terminal event clears `currentTurn`, so keep the last live id.
      let chatTurnId = '';
      for (const event of stream) {
        drawer = applyEvent(drawer, event, NOW);
        chat = applyChatEvent(chat, event, NOW);
        chatTurnId = chat.currentTurn?.id ?? chatTurnId;
      }
      expect(rows(newestEntries(drawer))).toEqual(rows(chat.trail[chatTurnId] ?? []));
      // Not vacuously equal: the approval row, its resolution, the finding and
      // the unfinished call the error settled are all there.
      expect(rows(newestEntries(drawer))).toEqual([
        { kind: 'action', toolName: 'terminal', status: 'ok', durationMs: 12 },
        {
          kind: 'finding',
          claim: 'tests pass',
          evidence: 'terminal exited 1',
          citesToolCallId: 'c1',
        },
        { kind: 'action', toolName: 'read_file', status: 'failed', durationMs: undefined },
      ]);
    });

    /** One running call in both surfaces, ready for whatever ends the turn. */
    function withRunningCall(): { drawer: DrawerStreamState; chat: ChatState; chatTurnId: string } {
      const start: SseEvent = {
        type: 'tool_start',
        toolCallId: 'c1',
        toolName: 'terminal',
        args: { command: 'sleep 60' },
      };
      const drawer = applyEvent(applyEvent(initial, runStart, NOW), start, NOW + 1);
      const chat = applyChatEvent(applyChatEvent(initialChatState, runStart, NOW), start, NOW + 1);
      return { drawer, chat, chatTurnId: chat.currentTurn?.id ?? '' };
    }

    it('settles a running row the same way in both surfaces when the turn errors', () => {
      const { chat, chatTurnId, drawer } = withRunningCall();
      const err: SseEvent = { type: 'error', error: 'boom', code: 'x' };
      const nextDrawer = applyEvent(drawer, err, NOW + 2);
      const nextChat = applyChatEvent(chat, err, NOW + 2);

      expect(rows(newestEntries(nextDrawer))).toEqual(rows(nextChat.trail[chatTurnId] ?? []));
      expect(rows(newestEntries(nextDrawer))).toEqual([
        { kind: 'action', toolName: 'terminal', status: 'failed', durationMs: undefined },
      ]);
      expect(nextDrawer.turns[0]?.closed).toBe(true);
    });

    it('settles a running row the same way in both surfaces when the user stops the turn', () => {
      const { chat, chatTurnId, drawer } = withRunningCall();
      // Stop is a local ChatAction, never an SSE event — the drawer only hears
      // it through the broadcast `useChat` sends.
      const nextDrawer = applyTurnAborted(drawer, 's1');
      const nextChat = applyChatAction(chat, { type: 'abort-turn' });

      expect(rows(newestEntries(nextDrawer))).toEqual(rows(nextChat.trail[chatTurnId] ?? []));
      expect(rows(newestEntries(nextDrawer))).toEqual([
        { kind: 'action', toolName: 'terminal', status: 'failed', durationMs: undefined },
      ]);
      expect(nextDrawer.turns[0]?.closed).toBe(true);
    });

    it('settles a running row the same way in both surfaces when a new question interrupts', () => {
      // The other door to the same ending: `submit-user-message` runs the very
      // `stopTurn` Stop does when a turn is live. It is not on the wire either,
      // so `useChat` broadcasts the same turn-aborted signal and the drawer
      // settles the same rows — otherwise the footer reads `✗ stopped · 1 action`
      // while the drawer still shows that action running (contract §4).
      const { chat, chatTurnId, drawer } = withRunningCall();
      const nextDrawer = applyTurnAborted(drawer, 's1');
      const nextChat = applyChatAction(chat, {
        type: 'submit-user-message',
        id: 'u2',
        text: 'actually, do this instead',
        timestamp: NOW + 2,
      });

      expect(rows(newestEntries(nextDrawer))).toEqual(rows(nextChat.trail[chatTurnId] ?? []));
      expect(rows(newestEntries(nextDrawer))).toEqual([
        { kind: 'action', toolName: 'terminal', status: 'failed', durationMs: undefined },
      ]);
      expect(nextChat.stoppedTurnIds).toEqual([chatTurnId]);
      expect(nextDrawer.turns[0]?.closed).toBe(true);
    });

    it('leaves a running row running on done, exactly as the chat footer does', () => {
      // DECISION: `done` does NOT settle unfinished rows, in EITHER reducer. A
      // `tool_end` can still arrive after `done` on this stream ("resolves a
      // call whose turn has already closed"), so `running` at `done` is not
      // proof the call never reported back, and marking it failed would
      // slander a call that answers a beat later.
      //
      // What closes the honesty gap instead is the SUMMARY both surfaces
      // derive: the row counts as `unsettled`, and `Trail` withholds its ✓
      // while anything is — so a `tool_end` that never comes reads
      // `1 action`, never `✓ 1 action`. Diverging here would re-create the bug.
      const { chat, chatTurnId, drawer } = withRunningCall();
      const done: SseEvent = { type: 'done', text: '', turnCount: 1 };
      const nextDrawer = applyEvent(drawer, done, NOW + 2);
      const nextChat = applyChatEvent(chat, done, NOW + 2);

      expect(rows(newestEntries(nextDrawer))).toEqual(rows(nextChat.trail[chatTurnId] ?? []));
      expect(rows(newestEntries(nextDrawer))).toEqual([
        { kind: 'action', toolName: 'terminal', status: 'running', durationMs: undefined },
      ]);
      expect(nextDrawer.turns[0]?.closed).toBe(true);
      // Both surfaces summarise it the same way, so neither can tick over it.
      const drawerSummary = summariseTrail(newestEntries(nextDrawer));
      expect(drawerSummary).toEqual(summariseTrail(nextChat.trail[chatTurnId] ?? []));
      expect(drawerSummary).toMatchObject({ actions: 1, ok: 0, failed: 0, unsettled: 1 });
    });

    it('a late tool_end settles the row identically in both surfaces', () => {
      // The path `done` must not pre-empt: the call reports back after the turn
      // closed, and both surfaces resolve it wherever it lives — which is what
      // makes withholding the ✓ (rather than painting a ✗) the right call.
      const { chat, chatTurnId, drawer } = withRunningCall();
      const tail: SseEvent[] = [
        { type: 'done', text: '', turnCount: 1 },
        { type: 'tool_end', toolCallId: 'c1', toolName: 'terminal', ok: true, durationMs: 7 },
      ];
      let nextDrawer = drawer;
      let nextChat = chat;
      for (const event of tail) {
        nextDrawer = applyEvent(nextDrawer, event, NOW + 3);
        nextChat = applyChatEvent(nextChat, event, NOW + 3);
      }

      expect(rows(newestEntries(nextDrawer))).toEqual(rows(nextChat.trail[chatTurnId] ?? []));
      expect(rows(newestEntries(nextDrawer))).toEqual([
        { kind: 'action', toolName: 'terminal', status: 'ok', durationMs: 7 },
      ]);
      expect(summariseTrail(newestEntries(nextDrawer))).toMatchObject({ ok: 1, unsettled: 0 });
    });

    it('ignores a stop that happened on a different session', () => {
      // The drawer follows the ACTIVE session, which need not be the one the
      // user stopped; settling a bystander's live rows is the same lie.
      const { drawer } = withRunningCall();
      expect(applyTurnAborted(drawer, 'another-session')).toBe(drawer);
    });
  });

  describe('untouched events', () => {
    it('returns prev unchanged for unrelated events (text_delta etc)', () => {
      const next = applyEvent(initial, { type: 'text_delta', text: 'hi' }, NOW);
      expect(next).toBe(initial); // referential equality — no churn
    });
  });
});
