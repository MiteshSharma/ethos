import { LaneVoiceModeStore, laneVoiceModePath } from '@ethosagent/core';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { VoiceLaneModeService } from '../../services/voice-lane-mode.service';

const DATA = '/data';

describe('VoiceLaneModeService', () => {
  let storage: InMemoryStorage;

  beforeEach(() => {
    storage = new InMemoryStorage();
  });

  it('round-trips a mode for one conversation', async () => {
    const service = new VoiceLaneModeService({ storage, dataDir: DATA });
    expect(await service.set('sess-1', 'all')).toEqual({ mode: 'all' });
    expect(await service.get('sess-1')).toEqual({ mode: 'all', default: 'mirror_inbound' });
  });

  it('reports the deployment default for a conversation that has none', async () => {
    const service = new VoiceLaneModeService({ storage, dataDir: DATA, defaultMode: 'off' });
    // Both fields say `off`, and they say it for different reasons: nothing was
    // ever set, so the effective mode IS the default.
    expect(await service.get('never-touched')).toEqual({ mode: 'off', default: 'off' });
  });

  it('a set on one conversation does not move another', async () => {
    const service = new VoiceLaneModeService({ storage, dataDir: DATA, defaultMode: 'off' });
    await service.set('sess-1', 'all');
    expect((await service.get('sess-2')).mode).toBe('off');
  });

  it('persists under the web: prefix, in the document the gateway shares', async () => {
    const service = new VoiceLaneModeService({ storage, dataDir: DATA });
    await service.set('telegram:bot-a:chat-1', 'all');

    // Read the SAME document back through the store the gateway uses. Without
    // the prefix this session id would land on a real gateway lane key and the
    // two conversations would share one mode.
    const shared = new LaneVoiceModeStore({ storage, path: laneVoiceModePath(DATA) });
    expect(await shared.entries()).toEqual({ 'web:telegram:bot-a:chat-1': 'all' });
    // The bare gateway lane key is untouched.
    expect(await shared.get('telegram:bot-a:chat-1')).toBe('mirror_inbound');
  });

  it('survives a fresh service over the same storage', async () => {
    await new VoiceLaneModeService({ storage, dataDir: DATA }).set('sess-1', 'off');
    const reopened = new VoiceLaneModeService({ storage, dataDir: DATA });
    expect((await reopened.get('sess-1')).mode).toBe('off');
  });
});
