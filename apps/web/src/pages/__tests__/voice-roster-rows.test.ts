import { describe, expect, it } from 'vitest';
import {
  voiceRealtimeProviderPatchFromRow,
  voiceRealtimeProviderRowsFromConfig,
  voiceSttProviderPatchFromRow,
  voiceSttProviderRowsFromConfig,
  voiceTtsProviderPatchFromRow,
  voiceTtsProviderRowsFromConfig,
} from '../Settings';

// Settings → Voice: the two halves of a roster round trip, without mounting the
// form. `*RowsFromConfig` hydrates rows from what `config.get` returned;
// `*PatchFromRow` turns an edited row back into what `config.update` accepts.
//
// The realtime roster is the third sibling of the STT and TTS ones and runs
// through the SAME row shape and the SAME row component, so it is asserted the
// same way: if the three ever stop agreeing on the blank-key rule or on which
// fields they carry, this file fails.

const blankRow = {
  _id: 1,
  name: 'live',
  provider: 'openai-realtime',
  model: '',
  apiKey: '',
  apiKeyPreview: null,
  voice: '',
  baseUrl: '',
  command: '',
  outputFormat: '',
  timeout: null,
  maxTextLength: null,
  costPerMinuteUsd: null,
};

describe('voiceRealtimeProviderRowsFromConfig', () => {
  it('hydrates every realtime field and never the stored key', () => {
    const rows = voiceRealtimeProviderRowsFromConfig({
      live: {
        provider: 'openai-realtime',
        model: 'gpt-realtime',
        apiKeyPreview: 'sk-…ab12',
        baseUrl: 'https://example.invalid/v1',
        voice: 'cedar',
        costPerMinuteUsd: 0.06,
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      name: 'live',
      provider: 'openai-realtime',
      model: 'gpt-realtime',
      // Write-only: the redacted preview is shown, the key itself never arrives.
      apiKey: '',
      apiKeyPreview: 'sk-…ab12',
      baseUrl: 'https://example.invalid/v1',
      voice: 'cedar',
      costPerMinuteUsd: 0.06,
    });
  });

  it('leaves the pipeline-only fields of the shared row shape empty', () => {
    const rows = voiceRealtimeProviderRowsFromConfig({
      live: {
        provider: 'gemini-live',
        model: null,
        apiKeyPreview: null,
        baseUrl: null,
        voice: null,
        costPerMinuteUsd: null,
      },
    });
    expect(rows[0]).toMatchObject({
      command: '',
      outputFormat: '',
      timeout: null,
      maxTextLength: null,
      costPerMinuteUsd: null,
    });
  });

  it('sorts by name, the way the other two rosters do', () => {
    const entry = {
      provider: 'openai-realtime',
      model: null,
      apiKeyPreview: null,
      baseUrl: null,
      voice: null,
      costPerMinuteUsd: null,
    };
    const rows = voiceRealtimeProviderRowsFromConfig({ zulu: entry, alpha: entry });
    expect(rows.map((r) => r.name)).toEqual(['alpha', 'zulu']);
  });
});

describe('voiceRealtimeProviderPatchFromRow', () => {
  it('carries only the fields the operator filled in', () => {
    expect(
      voiceRealtimeProviderPatchFromRow({
        ...blankRow,
        model: ' gpt-realtime ',
        voice: 'cedar',
        baseUrl: 'https://example.invalid/v1',
        costPerMinuteUsd: 0.06,
      }),
    ).toEqual({
      provider: 'openai-realtime',
      model: 'gpt-realtime',
      baseUrl: 'https://example.invalid/v1',
      voice: 'cedar',
      costPerMinuteUsd: 0.06,
    });
  });

  it('omits apiKey when the field was untouched, so the stored key survives', () => {
    expect(voiceRealtimeProviderPatchFromRow(blankRow)).toEqual({ provider: 'openai-realtime' });
  });

  it('sends a freshly typed apiKey', () => {
    expect(voiceRealtimeProviderPatchFromRow({ ...blankRow, apiKey: 'sk-new' })).toHaveProperty(
      'apiKey',
      'sk-new',
    );
  });

  it('never sends a pipeline-only field, even if the shared row carries one', () => {
    const patch = voiceRealtimeProviderPatchFromRow({
      ...blankRow,
      command: 'say -o {output_path}',
      timeout: 60,
      outputFormat: 'wav',
      maxTextLength: 2048,
    });
    expect(patch).toEqual({ provider: 'openai-realtime' });
  });
});

// The other two rosters, asserted on the shared rules only — enough that a
// change to the blank-key convention or the shared row shape cannot land in one
// roster without the other two noticing.
describe('the TTS and STT rosters keep the same shared rules', () => {
  it('hydrates a TTS entry and round-trips it back to a patch', () => {
    const rows = voiceTtsProviderRowsFromConfig({
      studio: {
        provider: 'openai-tts',
        model: 'tts-1',
        apiKeyPreview: 'sk-…ab12',
        voice: 'nova',
        baseUrl: null,
        command: null,
        outputFormat: 'wav',
        timeout: 60,
        maxTextLength: 2048,
      },
    });
    const row = rows[0];
    if (!row) throw new Error('expected one row');
    expect(row.apiKey).toBe('');
    expect(voiceTtsProviderPatchFromRow(row)).toEqual({
      provider: 'openai-tts',
      model: 'tts-1',
      voice: 'nova',
      outputFormat: 'wav',
      timeout: 60,
      maxTextLength: 2048,
    });
  });

  it('hydrates an STT entry and round-trips it back to a patch', () => {
    const rows = voiceSttProviderRowsFromConfig({
      spanish: {
        provider: 'local-stt',
        model: 'faster-whisper',
        apiKeyPreview: null,
        baseUrl: 'http://localhost:8000/v1',
        command: null,
        timeout: null,
      },
    });
    const row = rows[0];
    if (!row) throw new Error('expected one row');
    expect(row.costPerMinuteUsd).toBeNull();
    expect(voiceSttProviderPatchFromRow(row)).toEqual({
      provider: 'local-stt',
      model: 'faster-whisper',
      baseUrl: 'http://localhost:8000/v1',
    });
  });
});
