/**
 * Cron firings and the personality-binding invariant.
 *
 * A cron job reuses the originating web chat's session so the firing shows up
 * there. A session's personality is bound at creation and immutable, so that
 * reuse is only valid while the job's personality matches. When it doesn't, the
 * firing must not run against the bound session (the turn would be refused and
 * the job would record an empty output with no diagnostic).
 */

import type { AgentEvent } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { runCronTurn } from '../commands/cron-turn';

function makeLoop(events: (sessionKey: string) => AgentEvent[]) {
  const calls: { sessionKey: string; personalityId: string }[] = [];
  return {
    calls,
    run(_text: string, opts: { sessionKey: string; personalityId: string }) {
      calls.push({ sessionKey: opts.sessionKey, personalityId: opts.personalityId });
      return (async function* () {
        for (const e of events(opts.sessionKey)) yield e;
      })();
    },
  };
}

function makeSessions(bound: Record<string, string>) {
  return {
    async getSessionByKey(key: string) {
      const personalityId = bound[key];
      return personalityId ? { personalityId } : null;
    },
  };
}

const okEvents = (): AgentEvent[] => [
  { type: 'text_delta', text: 'output' },
  { type: 'done', text: 'output', turnCount: 1 },
];

describe('runCronTurn session routing', () => {
  it('reuses the web-origin session when the personalities agree', async () => {
    const loop = makeLoop(okEvents);
    const result = await runCronTurn({
      loop,
      sessions: makeSessions({ 'web:chat-1': 'researcher' }),
      jobId: 'job-1',
      prompt: 'go',
      personalityId: 'researcher',
      webOrigin: 'web:chat-1',
    });

    expect(result.sessionKey).toBe('web:chat-1');
    expect(result.reusedWebOrigin).toBe(true);
    expect(result.output).toBe('output');
    expect(loop.calls[0]?.sessionKey).toBe('web:chat-1');
  });

  it('reuses the web-origin session when it does not exist yet', async () => {
    const loop = makeLoop(okEvents);
    const result = await runCronTurn({
      loop,
      sessions: makeSessions({}),
      jobId: 'job-1',
      prompt: 'go',
      personalityId: 'researcher',
      webOrigin: 'web:chat-new',
    });

    expect(result.sessionKey).toBe('web:chat-new');
    expect(result.reusedWebOrigin).toBe(true);
  });

  it('routes to its own session when the web-origin session is bound elsewhere', async () => {
    const loop = makeLoop(okEvents);
    const result = await runCronTurn({
      loop,
      sessions: makeSessions({ 'web:chat-1': 'engineer' }),
      jobId: 'job-1',
      prompt: 'go',
      personalityId: 'researcher',
      webOrigin: 'web:chat-1',
    });

    // Not the bound key — so the turn is never refused, and it produces output.
    expect(result.sessionKey).not.toBe('web:chat-1');
    expect(result.sessionKey.startsWith('cron:job-1:')).toBe(true);
    expect(result.reusedWebOrigin).toBe(false);
    expect(result.output).toBe('output');
    expect(loop.calls[0]).toEqual({
      sessionKey: result.sessionKey,
      personalityId: 'researcher',
    });
  });

  it('uses its own session when the job has no web origin', async () => {
    const loop = makeLoop(okEvents);
    const result = await runCronTurn({
      loop,
      sessions: makeSessions({}),
      jobId: 'job-2',
      prompt: 'go',
      personalityId: 'researcher',
    });

    expect(result.sessionKey.startsWith('cron:job-2:')).toBe(true);
    expect(result.reusedWebOrigin).toBe(false);
  });
});

describe('runCronTurn failure reporting', () => {
  it('throws with the refusal reason instead of recording an empty output', async () => {
    const loop = makeLoop(() => [
      {
        type: 'error',
        error: 'Session web:chat-1 is bound to personality "engineer".',
        code: 'personality_locked',
      },
      { type: 'done', text: '', turnCount: 0 },
    ]);

    await expect(
      runCronTurn({
        loop,
        sessions: makeSessions({}),
        jobId: 'job-3',
        prompt: 'go',
        personalityId: 'researcher',
        webOrigin: 'web:chat-1',
      }),
    ).rejects.toThrow(/personality_locked/);
  });

  it('throws on any errored turn, not just refusals', async () => {
    const loop = makeLoop(() => [
      { type: 'error', error: 'provider exploded', code: 'PROVIDER_ERROR' },
      { type: 'done', text: '', turnCount: 0 },
    ]);

    await expect(
      runCronTurn({
        loop,
        sessions: makeSessions({}),
        jobId: 'job-4',
        prompt: 'go',
        personalityId: 'researcher',
      }),
    ).rejects.toThrow(/provider exploded/);
  });
});
