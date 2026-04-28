import { describe, expect, it } from 'vitest';
import {
  applyEvent,
  type DrawerStreamState,
  emptyDrawerState,
  NOTIFICATIONS_CAP,
  TOOL_STREAM_CAP,
} from '../drawer-reducer';

describe('drawer-reducer', () => {
  const initial: DrawerStreamState = emptyDrawerState('s1');
  const NOW = 1_700_000_000_000;

  describe('tool_start', () => {
    it('prepends a running entry', () => {
      const next = applyEvent(
        initial,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'read_file', args: {} },
        NOW,
      );
      expect(next.toolStream).toEqual([
        { toolCallId: 'c1', toolName: 'read_file', startedAt: NOW, status: 'running' },
      ]);
    });

    it('caps the stream at TOOL_STREAM_CAP', () => {
      let state = initial;
      for (let i = 0; i < TOOL_STREAM_CAP + 5; i++) {
        state = applyEvent(
          state,
          { type: 'tool_start', toolCallId: `c${i}`, toolName: 'x', args: {} },
          NOW + i,
        );
      }
      expect(state.toolStream).toHaveLength(TOOL_STREAM_CAP);
      // Newest first → the last-inserted id is at index 0.
      expect(state.toolStream[0]?.toolCallId).toBe(`c${TOOL_STREAM_CAP + 4}`);
    });
  });

  describe('tool_end', () => {
    it('promotes a running entry to ok with duration', () => {
      const started = applyEvent(
        initial,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
        NOW,
      );
      const ended = applyEvent(
        started,
        { type: 'tool_end', toolCallId: 'c1', toolName: 'bash', ok: true, durationMs: 320 },
        NOW + 320,
      );
      expect(ended.toolStream[0]).toMatchObject({
        toolCallId: 'c1',
        status: 'ok',
        durationMs: 320,
      });
    });

    it('marks failed tools as error', () => {
      const started = applyEvent(
        initial,
        { type: 'tool_start', toolCallId: 'c1', toolName: 'bash', args: {} },
        NOW,
      );
      const ended = applyEvent(
        started,
        { type: 'tool_end', toolCallId: 'c1', toolName: 'bash', ok: false, durationMs: 50 },
        NOW + 50,
      );
      expect(ended.toolStream[0]?.status).toBe('error');
    });

    it('is a no-op for unknown toolCallIds', () => {
      const next = applyEvent(
        initial,
        { type: 'tool_end', toolCallId: 'unknown', toolName: 'bash', ok: true, durationMs: 10 },
        NOW,
      );
      expect(next.toolStream).toEqual([]);
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

  describe('untouched events', () => {
    it('returns prev unchanged for unrelated events (text_delta etc)', () => {
      const next = applyEvent(initial, { type: 'text_delta', text: 'hi' }, NOW);
      expect(next).toBe(initial); // referential equality — no churn
    });
  });
});
