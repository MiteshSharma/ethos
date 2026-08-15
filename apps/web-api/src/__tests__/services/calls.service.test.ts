import { InMemoryCallLog, type StartCallInput } from '@ethosagent/call-log';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { CallDetailSchema, CallSummarySchema } from '@ethosagent/web-contracts';
import { beforeEach, describe, expect, it } from 'vitest';
import { CallsService } from '../../services/calls.service';

// The Communications call list, read over the `CallLog` INTERFACE — the fake is
// injected, so nothing here touches SQLite.

const DATA = '/data';
const DB = '/data/calls.db';

function call(overrides: Partial<StartCallInput> & { id: string }): StartCallInput {
  return {
    botKey: 'bot-a',
    laneKey: `voice:bot-a:sip:${overrides.id}`,
    direction: 'inbound',
    fromNumber: '+15551234567',
    toNumber: '+15559999999',
    ...overrides,
  };
}

describe('CallsService', () => {
  let storage: InMemoryStorage;
  let log: InMemoryCallLog;
  let service: CallsService;

  beforeEach(async () => {
    storage = new InMemoryStorage();
    log = new InMemoryCallLog();
    await storage.mkdir(DATA);
    await storage.write(DB, '');
    service = new CallsService({ dataDir: DATA, storage, openLog: () => log });
  });

  it('reports an empty list when no call log exists', async () => {
    const empty = new CallsService({
      dataDir: DATA,
      storage: new InMemoryStorage(),
      openLog: () => {
        throw new Error('must not open a log that does not exist');
      },
    });
    expect(await empty.list()).toEqual([]);
    expect(await empty.active()).toEqual([]);
    expect(await empty.get('nope')).toBeNull();
  });

  it('returns rows newest first, without transcripts', async () => {
    await log.start(call({ id: 'a', startedAt: 1_000 }));
    await log.start(call({ id: 'b', startedAt: 2_000 }));
    await log.update('b', {
      status: 'completed',
      endedAt: 2_500,
      summary: 'Booked a table for four.',
      transcript: 'caller: hello…',
      costUsd: 0.42,
    });

    const rows = await service.list();
    expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
    const first = rows[0];
    expect(first?.summaryPreview).toBe('Booked a table for four.');
    expect(first?.hasTranscript).toBe(true);
    expect(first?.costUsd).toBe(0.42);
    // The list shape carries no transcript at all — not even an empty one.
    expect('transcript' in (first ?? {})).toBe(false);
  });

  it('truncates the summary preview at 200 characters', async () => {
    await log.start(call({ id: 'a' }));
    await log.update('a', { summary: 'x'.repeat(500) });
    expect((await service.list())[0]?.summaryPreview).toHaveLength(200);
  });

  it('nulls the preview when a call has no summary', async () => {
    await log.start(call({ id: 'a' }));
    const row = (await service.list())[0];
    expect(row?.summaryPreview).toBeNull();
    expect(row?.hasTranscript).toBe(false);
  });

  it('filters by direction and status across the whole window, not just the page', async () => {
    // 30 outbound calls, then one inbound underneath them. Filtering AFTER a
    // limited read would return nothing for a limit of 5.
    for (let i = 0; i < 30; i++) {
      await log.start(call({ id: `out-${i}`, direction: 'outbound', startedAt: 1_000 + i }));
    }
    await log.start(call({ id: 'in-1', direction: 'inbound', startedAt: 500 }));

    const inbound = await service.list({ limit: 5, direction: 'inbound' });
    expect(inbound.map((r) => r.id)).toEqual(['in-1']);

    await log.update('out-3', { status: 'refused', reason: 'not_allowlisted' });
    const refused = await service.list({ status: 'refused' });
    expect(refused.map((r) => r.id)).toEqual(['out-3']);
    expect(refused[0]?.reason).toBe('not_allowlisted');
  });

  it('honours the limit after filtering', async () => {
    for (let i = 0; i < 10; i++) {
      await log.start(call({ id: `in-${i}`, startedAt: 1_000 + i }));
    }
    expect(await service.list({ limit: 3 })).toHaveLength(3);
    expect(await service.list({ limit: 3, direction: 'inbound' })).toHaveLength(3);
  });

  it('lists live calls oldest first', async () => {
    await log.start(call({ id: 'a', startedAt: 2_000, status: 'live' }));
    await log.start(call({ id: 'b', startedAt: 1_000, status: 'ringing' }));
    await log.start(call({ id: 'c', startedAt: 500, status: 'completed', endedAt: 600 }));

    expect((await service.active()).map((r) => r.id)).toEqual(['b', 'a']);
  });

  it('returns the full summary and transcript from get', async () => {
    await log.start(call({ id: 'a' }));
    await log.update('a', { summary: 'y'.repeat(500), transcript: 'caller: hello…' });

    const detail = await service.get('a');
    expect(detail?.summary).toHaveLength(500);
    expect(detail?.summaryPreview).toHaveLength(200);
    expect(detail?.transcript).toBe('caller: hello…');
  });

  it('returns null for an unknown id rather than throwing', async () => {
    expect(await service.get('missing')).toBeNull();
  });

  // The service is what the RPC handler returns verbatim, so what it produces
  // has to satisfy the contract the UI parses against — a field this layer
  // leaves `undefined` where the wire says `nullable` is a runtime failure the
  // types alone would not catch.
  it('produces rows the wire schemas accept', async () => {
    await log.start(call({ id: 'a', personalityId: 'receptionist', tier: 'realtime' }));
    await log.update('a', {
      status: 'completed',
      endedAt: 2_500,
      summary: 'Booked a table.',
      transcript: 'caller: hello…',
      costUsd: 0.42,
    });
    // …and a row that learned none of the optional facts.
    await log.start(call({ id: 'b', status: 'ringing' }));

    for (const row of await service.list()) {
      expect(CallSummarySchema.safeParse(row).success).toBe(true);
    }
    for (const row of await service.active()) {
      expect(CallSummarySchema.safeParse(row).success).toBe(true);
    }
    expect(CallDetailSchema.safeParse(await service.get('a')).success).toBe(true);
    expect(CallDetailSchema.safeParse(await service.get('b')).success).toBe(true);
  });
});
