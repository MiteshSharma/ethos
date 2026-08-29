// `/voice` survives a restart (voice V2 acceptance criterion).
//
// The mode used to live in a `Map` on the Gateway instance, which meant the
// answer to "does this chat speak?" was reset by every deploy, every crash, and
// — less obviously — by `/new` and by LRU lane eviction. A preference with that
// lifetime is not a preference; it is a setting the user has to keep retyping.
//
// The observable throughout is what `/voice` with no argument REPLIES, because
// that is the only thing the user can actually see.

import { LaneVoiceModeStore, laneVoiceModePath } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { Gateway } from '../index';
import { fakeAdapter, inbound, stubLoop } from './voice-fakes';

const ETHOS_DIR = '/ethos';

function gatewayWith(store: LaneVoiceModeStore, extra: Record<string, unknown> = {}) {
  return new Gateway({
    bots: [
      { botKey: 'bot-a', loop: stubLoop(), binding: { type: 'personality', name: 'default' } },
    ],
    voiceModeStore: store,
    clarifySweepIntervalMs: 0,
    ...extra,
  });
}

/** The text `/voice` (no argument) replied with. */
async function reportedMode(gw: Gateway, adapter: ReturnType<typeof fakeAdapter>): Promise<string> {
  const before = adapter.sent.length;
  await gw.handleMessage(inbound({ text: '/voice' }), adapter.adapter);
  return adapter.sent[before]?.message.text ?? '';
}

describe('per-lane voice mode — durability', () => {
  it('survives a restart: a second Gateway over the same storage reads the mode back', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ETHOS_DIR);
    const path = laneVoiceModePath(ETHOS_DIR);

    const first = gatewayWith(new LaneVoiceModeStore({ storage, path }));
    const adapter = fakeAdapter();
    await first.handleMessage(inbound({ text: '/voice all' }), adapter.adapter);
    expect(adapter.sent.at(-1)?.message.text).toBe('✓ Voice mode: all');

    // A genuinely fresh process: new Gateway, new store, cold cache — only the
    // document on disk connects them.
    const rebooted = gatewayWith(new LaneVoiceModeStore({ storage, path }));
    const rebootedAdapter = fakeAdapter();
    expect(await reportedMode(rebooted, rebootedAdapter)).toContain('Voice mode: all');
  });

  it('a lane with no override reports the configured default', async () => {
    const gw = gatewayWith(new LaneVoiceModeStore({ defaultMode: 'off' }), {
      defaultVoiceMode: 'off',
    });
    expect(await reportedMode(gw, fakeAdapter())).toContain('Voice mode: off');
  });

  it('/new does NOT reset it — it is a preference, not session state', async () => {
    const gw = gatewayWith(new LaneVoiceModeStore());
    const adapter = fakeAdapter();

    await gw.handleMessage(inbound({ text: '/voice all' }), adapter.adapter);
    await gw.handleMessage(inbound({ text: '/new' }), adapter.adapter);
    expect(adapter.sent.at(-1)?.message.text).toBe('✓ New session started.');

    expect(await reportedMode(gw, adapter)).toContain('Voice mode: all');
  });

  it('LRU lane eviction does not destroy it either', async () => {
    // Eviction is a memory-pressure decision about in-process state. Dropping
    // the mode with the lane would silently un-set what the user typed the
    // moment a busy deployment crossed `maxChats`.
    const gw = gatewayWith(new LaneVoiceModeStore(), { maxChats: 1 });
    const adapter = fakeAdapter();

    await gw.handleMessage(inbound({ chatId: 'chat-1', text: '/voice all' }), adapter.adapter);
    // A second chat pushes the first lane past the cap and out.
    await gw.handleMessage(inbound({ chatId: 'chat-2', text: 'hello' }), adapter.adapter);

    const before = adapter.sent.length;
    await gw.handleMessage(inbound({ chatId: 'chat-1', text: '/voice' }), adapter.adapter);
    expect(adapter.sent[before]?.message.text).toContain('Voice mode: all');
  });

  it('an unknown mode changes nothing', async () => {
    const gw = gatewayWith(new LaneVoiceModeStore({ defaultMode: 'mirror_inbound' }));
    const adapter = fakeAdapter();

    await gw.handleMessage(inbound({ text: '/voice shout' }), adapter.adapter);
    expect(adapter.sent.at(-1)?.message.text).toContain('Unknown voice mode');
    expect(await reportedMode(gw, adapter)).toContain('Voice mode: mirror_inbound');
  });
});
