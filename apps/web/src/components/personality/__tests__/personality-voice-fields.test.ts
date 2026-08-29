import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type PersonalityVoice,
  PersonalityVoiceFields,
  voiceCreateInput,
  voiceLanguageMap,
  voiceLanguageRows,
  voiceUpdateInput,
} from '../PersonalityVoiceFields';

// The personality voice editor exposed five of the block's eight sub-keys;
// `tier`, `model` and `languages` were yaml-only. They are SUB-KEYS of the
// frozen `voice` block, so nothing here touches the top-level field count —
// `packages/types/src/__tests__/personality-field-count.test.ts` stays at 28.
//
// `renderToStaticMarkup` needs no DOM (apps/web has none); the three provider
// queries are seeded into the cache so the form renders as it does against a
// configured deployment.

function blank(over: Partial<PersonalityVoice> = {}): PersonalityVoice {
  return {
    ttsProvider: '',
    ttsVoice: '',
    sttProvider: '',
    realtimeProvider: '',
    callStyle: '',
    tier: '',
    model: '',
    languages: [],
    ...over,
  };
}

function markup(value: PersonalityVoice): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(['voice', 'ttsEntries'], {
    default: { providerId: 'local-tts', voices: null },
    roster: {},
  });
  queryClient.setQueryData(['voice', 'sttEntries'], {
    default: { providerId: 'local-stt' },
    roster: {},
  });
  queryClient.setQueryData(['voice', 'realtimeEntries'], { roster: {}, defaultEntryName: null });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(PersonalityVoiceFields, { value, onChange: () => {} }),
    ),
  );
}

describe('PersonalityVoiceFields — the three sub-keys that were yaml-only', () => {
  it('offers the tier, the fast-lane model and the language map', () => {
    const html = markup(blank());
    expect(html).toContain('Voice tier');
    expect(html).toContain('Fast-lane model');
    expect(html).toContain('Voices by language');
  });

  it('offers the fast-lane model as free text, since it is a model id', () => {
    // Antd renders `help` through a CSSMotion child that server-side rendering
    // skips, so the copy itself is not assertable here — the control is.
    expect(markup(blank({ model: 'claude-haiku-4-5' }))).toContain('value="claude-haiku-4-5"');
    expect(markup(blank())).toContain('placeholder="claude-haiku-4-5"');
  });

  it('lets the tier fall through to the deployment, rather than forcing a choice', () => {
    expect(markup(blank())).toContain('Deployment default');
  });

  it('draws the language map as rows, never as the Card primitive', () => {
    // DESIGN.md "cards earn existence": Card is reserved for skill rows, cron
    // rows and task tiles. A tag-and-voice pair does not earn one.
    const html = markup(blank({ languages: [{ rowId: 1, tag: 'es', voice: 'ef_dora' }] }));
    expect(html).not.toContain('ant-card');
    expect(html).toContain('value="es"');
    expect(html).toContain('value="ef_dora"');
    expect(html).toContain('Add language');
  });

  it('says why a malformed tag is refused instead of dropping it in silence', () => {
    const html = markup(blank({ languages: [{ rowId: 1, tag: 'es!', voice: 'ef_dora' }] }));
    expect(html).toContain('a BCP-47 tag like es or pt-BR');
  });
});

describe('voice language rows', () => {
  it('round-trips a stored map through the row editor', () => {
    const rows = voiceLanguageRows({ ja: 'jf_alpha', es: 'ef_dora' });
    expect(rows.map((r) => r.tag)).toEqual(['es', 'ja']);
    expect(voiceLanguageMap(rows)).toEqual({ es: 'ef_dora', ja: 'jf_alpha' });
  });

  it('gives every row its own key so a delete does not renumber the rest', () => {
    const rows = voiceLanguageRows({ es: 'ef_dora', ja: 'jf_alpha' });
    expect(new Set(rows.map((r) => r.rowId)).size).toBe(2);
  });

  it('drops half-typed rows rather than writing them to config.yaml', () => {
    expect(
      voiceLanguageMap([
        { rowId: 1, tag: 'es', voice: 'ef_dora' },
        { rowId: 2, tag: 'pt-BR', voice: '' },
        { rowId: 3, tag: '', voice: 'jf_alpha' },
        { rowId: 4, tag: '  ', voice: '  ' },
      ]),
    ).toEqual({ es: 'ef_dora' });
  });

  it('refuses a tag that would smuggle a second key into the dotted config line', () => {
    // The tag becomes `voice.languages.<tag>` in a flat yaml file. A tag
    // carrying a newline or a colon would serialize into lines the loader never
    // meant to read.
    expect(
      voiceLanguageMap([
        { rowId: 1, tag: 'es\nname', voice: 'ef_dora' },
        { rowId: 2, tag: 'es: x', voice: 'ef_dora' },
        { rowId: 3, tag: 'pt-BR', voice: 'pf_ana' },
      ]),
    ).toEqual({ 'pt-BR': 'pf_ana' });
  });

  it('trims a tag and a voice the operator typed with stray spaces', () => {
    expect(voiceLanguageMap([{ rowId: 1, tag: ' es ', voice: ' ef_dora ' }])).toEqual({
      es: 'ef_dora',
    });
  });
});

describe('voice block payloads', () => {
  it('creates no voice block at all when the section was never touched', () => {
    expect(voiceCreateInput(blank())).toEqual({});
  });

  it('carries the tier, the model and the language map on create', () => {
    expect(
      voiceCreateInput(
        blank({
          ttsVoice: 'af_bella',
          tier: 'realtime',
          model: 'claude-haiku-4-5',
          languages: [{ rowId: 1, tag: 'es', voice: 'ef_dora' }],
        }),
      ),
    ).toEqual({
      voice: {
        tts_voice: 'af_bella',
        tier: 'realtime',
        model: 'claude-haiku-4-5',
        languages: { es: 'ef_dora' },
      },
    });
  });

  it('sends every sub-key on update, blanks included, so "back to default" is expressible', () => {
    // The registry shallow-merges the block: an omitted sub-key keeps its
    // stored value, so a cleared field has to travel as `''`.
    expect(voiceUpdateInput(blank({ ttsVoice: 'af_bella' }))).toEqual({
      tts_provider: '',
      tts_voice: 'af_bella',
      stt_provider: '',
      realtime_provider: '',
      call_style: '',
      tier: '',
      model: '',
      languages: {},
    });
  });

  it('sends the whole language map on update, so removing a row deletes the tag', () => {
    expect(
      voiceUpdateInput(blank({ languages: [{ rowId: 1, tag: 'ja', voice: 'jf_alpha' }] }))
        .languages,
    ).toEqual({ ja: 'jf_alpha' });
  });
});
