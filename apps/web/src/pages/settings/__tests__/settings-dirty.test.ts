import { describe, expect, it } from 'vitest';
import type { SettingsRows } from '../lib/build-config-patch';
import type { FormShape } from '../lib/form-shape';
import { computeDirty, type DirtySnapshot } from '../lib/settings-dirty';

// T3 — plan/phases/settings-navigation.md D9. Dirty state is DERIVED, and the
// property worth pinning is that deriving it makes it category-blind for free:
// an edit made in Voice is still counted while Memory is the pane on screen,
// because nothing in `computeDirty` knows which pane that is.
//
// Pure function, so this needs no form instance and no DOM.

function rows(over: Partial<SettingsRows> = {}): SettingsRows {
  return {
    providerRows: [],
    quickCommandRows: [],
    channelToolsetRows: [],
    voiceTtsProviderRows: [],
    voiceSttProviderRows: [],
    voiceRealtimeProviderRows: [],
    retentionRows: [],
    voiceBotRows: [],
    ...over,
  };
}

/**
 * A store slice, not a whole `FormShape`: `computeDirty` diffs the paths it is
 * given, and a hundred untouched fields would say nothing this file does not.
 */
function values(over: Record<string, unknown> = {}): FormShape {
  return {
    personality: 'engineer',
    voiceTrunkWebhookPath: '/voice/inbound',
    memoryApproval: { mode: 'off', cap: 200, ttlDays: 30 },
    voiceBargeIn: { call: { energyThreshold: 0.05, minSpeechMs: 120, silenceMs: 400 } },
    voiceTrustedPlugins: ['openai-tts'],
    ...over,
  } as unknown as FormShape;
}

function snapshot(over: Partial<DirtySnapshot> = {}): DirtySnapshot {
  return { values: values(), rows: rows(), ...over };
}

describe('computeDirty', () => {
  it('reports nothing on a pristine hydrate', () => {
    expect(computeDirty(snapshot(), values(), rows())).toEqual({ count: 0, categories: [] });
  });

  it('reports nothing before the first hydrate', () => {
    // No snapshot means nothing has been read from the server yet, so nothing
    // can have diverged from it. A count here would be a lie on first paint.
    expect(computeDirty(null, values(), rows())).toEqual({ count: 0, categories: [] });
  });

  it('counts an edit in a category OTHER than the one you are looking at', () => {
    // The whole point of D9. You are standing in Memory; the edit was in Voice.
    const dirty = computeDirty(
      snapshot(),
      values({ voiceTrunkWebhookPath: '/hooks/voice' }),
      rows(),
    );
    expect(dirty.count).toBe(1);
    expect(dirty.categories).toEqual(['voice']);
  });

  it('names every affected category when the changes span three of them', () => {
    const dirty = computeDirty(
      snapshot(),
      values({
        personality: 'analyst',
        voiceTrunkWebhookPath: '/hooks/voice',
        memoryApproval: { mode: 'all', cap: 200, ttlDays: 30 },
      }),
      rows(),
    );
    expect(dirty.count).toBe(3);
    expect([...dirty.categories].sort()).toEqual(['general', 'memory', 'voice']);
  });

  it('reaches into nested blocks, so a barge-in cell resolves to Voice', () => {
    const dirty = computeDirty(
      snapshot(),
      values({
        voiceBargeIn: { call: { energyThreshold: 0.09, minSpeechMs: 120, silenceMs: 400 } },
      }),
      rows(),
    );
    expect(dirty.count).toBe(1);
    expect(dirty.categories).toEqual(['voice']);
  });

  it('compares array fields by content, not identity', () => {
    expect(
      computeDirty(snapshot(), values({ voiceTrustedPlugins: ['openai-tts'] }), rows()).count,
    ).toBe(0);
    expect(
      computeDirty(snapshot(), values({ voiceTrustedPlugins: ['elevenlabs'] }), rows()).count,
    ).toBe(1);
  });

  it('counts a row-array edit, and attributes it to the row set owner', () => {
    const before = rows({
      retentionRows: [{ _id: 1, personalityId: '', subkey: 'messages', duration: '90d' }],
    });
    const after = rows({
      retentionRows: [{ _id: 1, personalityId: '', subkey: 'messages', duration: '30d' }],
    });
    const dirty = computeDirty({ values: values(), rows: before }, values(), after);
    expect(dirty.count).toBe(1);
    expect(dirty.categories).toEqual(['data']);
  });

  it('counts an added row', () => {
    const after = rows({
      quickCommandRows: [
        {
          _id: 7,
          name: 'standup',
          type: 'reply',
          command: '',
          reply: 'summarise yesterday',
          gateway: false,
          channels: [],
        },
      ],
    });
    const dirty = computeDirty(snapshot(), values(), after);
    expect(dirty.count).toBe(1);
    expect(dirty.categories).toEqual(['automation']);
  });

  it('ignores the row fields that are UI state rather than config', () => {
    // Clicking Test on a provider row must not read as an unsaved edit.
    const row = {
      _id: 1,
      provider: 'anthropic',
      model: 'claude',
      apiKey: '',
      apiKeyPreview: 'sk-…',
      baseUrl: '',
      testStatus: 'idle' as const,
    };
    const dirty = computeDirty(
      { values: values(), rows: rows({ providerRows: [row] }) },
      values(),
      rows({ providerRows: [{ ...row, _id: 99, testStatus: 'success', testError: undefined }] }),
    );
    expect(dirty.count).toBe(0);
  });

  it('adds form changes and row changes into one count', () => {
    const dirty = computeDirty(
      snapshot(),
      values({ personality: 'analyst' }),
      rows({
        voiceBotRows: [
          {
            _id: 3,
            id: 'main',
            match: '+15550000',
            bindType: 'personality',
            bindName: 'engineer',
            allowSlashSwitch: true,
          },
        ],
      }),
    );
    expect(dirty.count).toBe(2);
    expect([...dirty.categories].sort()).toEqual(['general', 'voice']);
  });
});
