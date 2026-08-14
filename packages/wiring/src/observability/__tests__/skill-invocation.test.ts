import { describe, expect, it, vi } from 'vitest';
import { EthosObservability } from '../ethos-observability';

// AN-C1 — exposure and invocation are separate categories because they are
// separate costs: exposure is a token bill paid every turn, invocation is a
// choice the model made once.

function writer() {
  const recordEvent = vi.fn();
  return {
    writer: { recordEvent, recordTrace: vi.fn(), recordSpan: vi.fn(), flush: vi.fn() } as never,
    events: () => recordEvent.mock.calls.map((c) => c[0]),
  };
}

describe('recordSkillInvocation', () => {
  it('maps invoked and exposed to distinct categories', () => {
    const w = writer();
    const obs = new EthosObservability(w.writer);

    obs.recordSkillInvocation({ traceId: 't1', skill: 'deploy', mode: 'invoked' });
    obs.recordSkillInvocation({ traceId: 't1', skill: 'review', mode: 'exposed' });

    const [invoked, exposed] = w.events();
    expect(invoked.category).toBe('skill.invoked');
    expect(exposed.category).toBe('skill.exposed');
  });

  it('carries the skill name in details and the turn traceId', () => {
    const w = writer();
    const obs = new EthosObservability(w.writer);

    obs.recordSkillInvocation({ traceId: 't42', skill: 'deploy', mode: 'invoked' });

    const [event] = w.events();
    expect(event.traceId).toBe('t42');
    expect(event.details).toMatchObject({ skill: 'deploy' });
    // Info, not warn: a skill being used is not a safety signal.
    expect(event.severity).toBe('info');
  });

  it('preserves caller-supplied details alongside the skill name', () => {
    const w = writer();
    const obs = new EthosObservability(w.writer);

    obs.recordSkillInvocation({
      skill: 'deploy',
      mode: 'exposed',
      details: { personalityId: 'ops' },
    });

    expect(w.events()[0].details).toMatchObject({ skill: 'deploy', personalityId: 'ops' });
  });
});
