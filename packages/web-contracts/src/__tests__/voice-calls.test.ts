import { describe, expect, it } from 'vitest';
import { CallDetailSchema, CallSummarySchema, contract } from '../index';

// The telephony call surface the Communications UI builds against.
//
// The one shape rule worth a test of its own: a LIST row carries no transcript.
// The list is where 200 rows arrive at once, and a transcript on each of them is
// a slow response and a pile of conversation sitting in a browser network log
// for a pane that renders none of it.

const row = {
  id: 'CA123',
  botKey: 'bot-a',
  laneKey: 'voice:bot-a:sip:+15551234567',
  direction: 'inbound' as const,
  fromNumber: '+15551234567',
  toNumber: '+15559999999',
  personalityId: 'receptionist',
  tier: 'realtime' as const,
  status: 'completed' as const,
  startedAt: 1_700_000_000_000,
  endedAt: 1_700_000_060_000,
  reason: null,
  summaryPreview: 'Booked a table for four.',
  hasTranscript: true,
  costUsd: 0.42,
};

describe('voice.calls contract', () => {
  it('exposes list, active and get', () => {
    expect(Object.keys(contract.voice.calls).sort()).toEqual(['active', 'get', 'list']);
  });

  it('sits under voice, alongside the other voice sub-namespaces', () => {
    expect(Object.keys(contract.voice)).toContain('calls');
    expect(Object.keys(contract.voice)).toContain('satellites');
    expect(Object.keys(contract.voice)).toContain('wakeRoutes');
  });

  it('accepts a list row', () => {
    expect(CallSummarySchema.parse(row)).toEqual(row);
  });

  it('accepts a row that never ended, was never summarized, and cost nothing known', () => {
    const ringing = {
      ...row,
      status: 'ringing' as const,
      personalityId: null,
      tier: null,
      endedAt: null,
      summaryPreview: null,
      hasTranscript: false,
      costUsd: null,
    };
    expect(CallSummarySchema.parse(ringing)).toEqual(ringing);
  });

  it('strips a transcript from a list row — only get returns one', () => {
    const parsed = CallSummarySchema.parse({ ...row, transcript: 'caller: hello…' });
    expect('transcript' in parsed).toBe(false);
  });

  it('requires the full summary and transcript on a detail row', () => {
    expect(CallDetailSchema.safeParse(row).success).toBe(false);
    const detail = { ...row, summary: 'Booked a table for four.', transcript: 'caller: hello…' };
    expect(CallDetailSchema.parse(detail)).toEqual(detail);
  });

  it('rejects a status outside the closed set', () => {
    expect(CallSummarySchema.safeParse({ ...row, status: 'voicemail' }).success).toBe(false);
  });

  it('keeps screened and refused distinct from failed', () => {
    for (const status of ['screened', 'refused', 'failed']) {
      expect(CallSummarySchema.safeParse({ ...row, status }).success).toBe(true);
    }
  });
});
