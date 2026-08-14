// Artifact retention rides the ledger lifecycle (voice V2, eng-review D9).
//
// Three mechanisms, and each one has to be shown separately because each one
// covers what the previous cannot: delivery releases the artifact it discharged;
// abandonment releases the artifacts of obligations that were never delivered;
// and the total-size cap is the backstop for everything neither caught — an
// artifact whose row vanished, or a burst that outran the abandon window.

import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Gateway } from '../index';
import { createVoiceArtifactStore } from '../voice-artifacts';
import { fakeAdapter, inbound, recordingTts, SizedInMemoryStorage, stubLoop } from './voice-fakes';

const ARTIFACT_DIR = '/ethos/voice/artifacts';
const DAY_MS = 86_400_000;

async function harness(opts: { voiceOk?: boolean } = {}) {
  const ledger = new SQLiteDeliveryLedger(':memory:');
  const storage = new SizedInMemoryStorage();
  await storage.mkdir('/ethos');
  const artifacts = createVoiceArtifactStore({ storage, dir: ARTIFACT_DIR });
  const adapter = fakeAdapter(opts.voiceOk === false ? { voiceOk: false } : {});
  const tts = recordingTts('wav');
  const gateway = new Gateway({
    bots: [
      { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
    ],
    ttsProviderRegistry: tts.registry,
    ttsProviderName: 'local-tts',
    defaultVoiceMode: 'all',
    deliveryLedger: ledger,
    voiceArtifacts: artifacts,
    clarifySweepIntervalMs: 0,
  });
  return { ledger, storage, artifacts, adapter, gateway };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('voice artifact retention — delivery releases', () => {
  it('a confirmed voice send deletes its artifact', async () => {
    const { ledger, storage, adapter, gateway } = await harness();

    await gateway.handleMessage(inbound(), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(1);
    expect(await storage.list(ARTIFACT_DIR)).toEqual([]);
    ledger.close();
  });

  it('an UNconfirmed voice send keeps its artifact for the sweep', async () => {
    const { ledger, storage, adapter, gateway } = await harness({ voiceOk: false });

    await gateway.handleMessage(inbound(), adapter.adapter);

    expect(await storage.list(ARTIFACT_DIR)).toHaveLength(1);
    ledger.close();
  });
});

describe('voice artifact retention — abandonment releases', () => {
  it('abandons an aged obligation and deletes its artifact, leaving a fresh one alone', async () => {
    const { ledger, storage, artifacts, gateway } = await harness();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const staleRef = (await artifacts.put(Uint8Array.from([1, 2]), 'wav')) ?? '';
    const staleId = await ledger.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'chat-1',
      sessionId: 's',
      content: 'never arrived',
      kind: 'voice',
      artifactRef: staleRef,
      mediaFormat: 'wav',
    });

    vi.setSystemTime(new Date('2026-01-20T00:00:00Z'));
    const freshRef = (await artifacts.put(Uint8Array.from([3, 4]), 'wav')) ?? '';
    const freshId = await ledger.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'chat-1',
      sessionId: 's',
      content: 'in flight',
      kind: 'voice',
      artifactRef: freshRef,
      mediaFormat: 'wav',
    });

    const result = await gateway.pruneVoiceArtifacts({ abandonAfterDays: 7, maxTotalMb: 1_024 });

    expect(result.abandoned).toBe(1);
    expect((await ledger.get(staleId))?.status).toBe('abandoned');
    expect(await artifacts.read(staleRef)).toBeNull();
    // A pending obligation younger than the window is a LIVE one — it may
    // belong to a peer mid-send — and neither it nor its bytes are touched.
    expect((await ledger.get(freshId))?.status).toBe('pending');
    expect(await artifacts.read(freshRef)).not.toBeNull();
    expect(await storage.list(ARTIFACT_DIR)).toHaveLength(1);

    ledger.close();
  });

  it('a stale obligation older than the window is abandoned even mid-redelivery', async () => {
    // A process that claimed a row and then died leaves it `redelivering`
    // forever. That is exactly the state the backstop exists for.
    const { ledger, artifacts, gateway } = await harness();

    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const ref = (await artifacts.put(Uint8Array.from([1]), 'wav')) ?? '';
    const id = await ledger.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'chat-1',
      sessionId: 's',
      content: 'claimed by a dead process',
      kind: 'voice',
      artifactRef: ref,
      mediaFormat: 'wav',
    });
    expect(await ledger.claim(id)).toBe(true);

    vi.setSystemTime(Date.now() + 30 * DAY_MS);
    expect(
      (await gateway.pruneVoiceArtifacts({ abandonAfterDays: 7, maxTotalMb: 1_024 })).abandoned,
    ).toBe(1);
    expect((await ledger.get(id))?.status).toBe('abandoned');
    expect(await artifacts.read(ref)).toBeNull();

    ledger.close();
  });
});

describe('voice artifact retention — the size cap is the backstop', () => {
  it('evicts oldest-first until the directory is under the cap', async () => {
    const { ledger, artifacts, gateway } = await harness();

    // No ledger rows at all: these are the orphans neither delivery nor
    // abandonment can reach, which is precisely what the cap is for.
    const oldest = (await artifacts.put(new Uint8Array(600_000), 'wav')) ?? '';
    const middle = (await artifacts.put(new Uint8Array(600_000), 'wav')) ?? '';
    const newest = (await artifacts.put(new Uint8Array(600_000), 'wav')) ?? '';

    const result = await gateway.pruneVoiceArtifacts({ abandonAfterDays: 7, maxTotalMb: 1 });

    expect(result.bytesFreed).toBe(1_200_000);
    expect(await artifacts.read(oldest)).toBeNull();
    expect(await artifacts.read(middle)).toBeNull();
    expect(await artifacts.read(newest)).not.toBeNull();

    ledger.close();
  });

  it('is a no-op without a ledger or without a store', async () => {
    const adapter = fakeAdapter();
    const gw = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
      ],
      clarifySweepIntervalMs: 0,
    });
    await gw.handleMessage(inbound(), adapter.adapter);
    expect(await gw.pruneVoiceArtifacts({ abandonAfterDays: 7, maxTotalMb: 1 })).toEqual({
      abandoned: 0,
      bytesFreed: 0,
    });
  });
});
