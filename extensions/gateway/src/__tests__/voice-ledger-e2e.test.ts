// Voice obligations join the delivery ledger (voice V2, eng-review D10).
//
// Until now the ledger deliberately excluded voice: the CLAUDE.md channel
// contract said as much. That exclusion is what "synthesized, never delivered"
// looks like from the inside — the tokens are spent, the audio exists, the
// platform call fails, and nothing anywhere records that the user is owed a
// reply.
//
// D10 asks for the whole round trip as ONE test, and it is one test on purpose:
// the pending row, the artifact, the sweep, the redelivered bytes and the
// released artifact are a single property. Split into five, each half could
// pass while the chain between them was broken.

import { SQLiteDeliveryLedger } from '@ethosagent/delivery-ledger';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';
import { createVoiceArtifactStore } from '../voice-artifacts';
import { fakeAdapter, inbound, recordingTts, stubLoop } from './voice-fakes';

const ARTIFACT_DIR = '/ethos/voice/artifacts';

describe('Gateway voice obligations — failed send, sweep, redelivery, release', () => {
  it('redelivers the stored artifact and then deletes it', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const storage = new InMemoryStorage();
    await storage.mkdir('/ethos');
    const artifacts = createVoiceArtifactStore({ storage, dir: ARTIFACT_DIR });

    const adapter = fakeAdapter({ voiceOk: false });
    const tts = recordingTts('wav');
    const gw = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
      ],
      ttsProviderRegistry: tts.registry,
      ttsProviderName: 'local-tts',
      defaultVoiceMode: 'all',
      deliveryLedger: ledger,
      voiceArtifacts: artifacts,
      // The sweep resolves an adapter by platform, not from the turn.
      adapters: new Map([['telegram', adapter.adapter]]),
      clarifySweepIntervalMs: 0,
    });

    // --- The send that fails ----------------------------------------------
    await gw.handleMessage(inbound({ threadId: 'thread-7' }), adapter.adapter);

    const firstAttempt = adapter.voiceSends[0];
    expect(firstAttempt).toBeDefined();
    // The text reply confirmed, so the ONLY pending obligation is the voice one.
    const pending = await ledger.listPending(['bot-a']);
    expect(pending).toHaveLength(1);
    const row = pending[0];
    expect(row?.kind).toBe('voice');
    expect(row?.mediaFormat).toBe('wav');
    expect(row?.threadId).toBe('thread-7');
    // `content` holds the SPOKEN TEXT, so the row stays diagnosable.
    expect(row?.content).toBe('here you go');
    const ref = row?.artifactRef;
    expect(ref).toMatch(/^[0-9a-f-]{36}\.wav$/);
    // The bytes survived the failed send — that is what makes redelivery
    // possible without a second, different TTS pass.
    expect(Array.from((await artifacts.read(ref ?? '')) ?? [])).toEqual(
      Array.from(firstAttempt?.audio ?? []),
    );

    // --- The platform heals, the sweep runs -------------------------------
    adapter.setVoiceOk(true);
    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 1, failed: 0 });

    expect(adapter.voiceSends).toHaveLength(2);
    const redelivered = adapter.voiceSends[1];
    // The SAME recording, not a fresh synthesis: a second TTS pass would hand
    // the user an answer they can hear is not the one that was lost.
    expect(Array.from(redelivered?.audio ?? [])).toEqual(Array.from(firstAttempt?.audio ?? []));
    expect(tts.calls).toHaveLength(1);
    expect(redelivered?.opts.format).toBe('wav');
    expect(redelivered?.opts.threadId).toBe('thread-7');

    // --- The obligation is discharged and the artifact released -----------
    expect((await ledger.get(row?.id ?? ''))?.status).toBe('delivered');
    expect(await artifacts.read(ref ?? '')).toBeNull();
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);

    ledger.close();
  });

  it('a confirmed voice send leaves no pending row and no artifact behind', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const storage = new InMemoryStorage();
    await storage.mkdir('/ethos');
    const artifacts = createVoiceArtifactStore({ storage, dir: ARTIFACT_DIR });

    const adapter = fakeAdapter();
    const tts = recordingTts('wav');
    const gw = new Gateway({
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

    await gw.handleMessage(inbound(), adapter.adapter);

    expect(adapter.voiceSends).toHaveLength(1);
    expect(await ledger.listPending(['bot-a'])).toHaveLength(0);
    expect(await storage.list(ARTIFACT_DIR)).toEqual([]);

    ledger.close();
  });

  it('a pending voice row whose artifact is gone is released, never re-sent as text', async () => {
    // The written reply already went out under its own obligation. Falling back
    // to `row.content` here would deliver the same answer twice — a worse
    // failure than one missing voice note.
    const ledger = new SQLiteDeliveryLedger(':memory:');
    await ledger.record({
      botKey: 'bot-a',
      platform: 'telegram',
      chatId: 'chat-1',
      sessionId: 'telegram:bot-a:chat-1',
      content: 'the spoken text',
      kind: 'voice',
      artifactRef: '00000000-0000-4000-8000-000000000000.wav',
      mediaFormat: 'wav',
    });

    const storage = new InMemoryStorage();
    await storage.mkdir('/ethos');
    const adapter = fakeAdapter();
    const gw = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
      ],
      deliveryLedger: ledger,
      voiceArtifacts: createVoiceArtifactStore({ storage, dir: ARTIFACT_DIR }),
      adapters: new Map([['telegram', adapter.adapter]]),
      clarifySweepIntervalMs: 0,
    });

    expect(await gw.sweepPendingDeliveries()).toEqual({ redelivered: 0, failed: 1 });
    expect(adapter.voiceSends).toHaveLength(0);
    expect(adapter.sent).toHaveLength(0);
    // Released, not burned: the row goes back to the pending pool.
    expect((await ledger.listPending(['bot-a']))[0]?.status).toBe('pending');

    ledger.close();
  });

  it('with no artifact store a failed voice send is still visible as a pending row', async () => {
    const ledger = new SQLiteDeliveryLedger(':memory:');
    const adapter = fakeAdapter({ voiceOk: false });
    const tts = recordingTts('wav');
    const gw = new Gateway({
      bots: [
        { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
      ],
      ttsProviderRegistry: tts.registry,
      ttsProviderName: 'local-tts',
      defaultVoiceMode: 'all',
      deliveryLedger: ledger,
      clarifySweepIntervalMs: 0,
    });

    await gw.handleMessage(inbound(), adapter.adapter);

    const pending = await ledger.listPending(['bot-a']);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.kind).toBe('voice');
    // No store → no ref, so this loss is visible but not repairable. That is
    // the documented trade of leaving `voiceArtifacts` unwired.
    expect(pending[0]?.artifactRef).toBeUndefined();

    ledger.close();
  });
});
