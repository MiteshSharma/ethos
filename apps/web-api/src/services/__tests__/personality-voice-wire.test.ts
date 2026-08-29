import type { DescribedPersonality, FilePersonalityRegistry } from '@ethosagent/personalities';
import type { SkillsLibrary } from '@ethosagent/skills';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { PersonalitiesService } from '../personalities.service';

// What the personality editor gets to READ of a `voice` block.
//
// It has to be everything the editor can WRITE. The editor sends the whole
// block on save (the registry shallow-merges it, so a cleared field must travel
// as `''`), which means a sub-key the wire omits is a sub-key the next save
// silently erases — `voice.languages` was exactly that until V1a's parity pass.

function described(voice: PersonalityConfig['voice']): DescribedPersonality {
  return {
    config: {
      id: 'ada',
      name: 'Ada',
      soulFile: 'SOUL.md',
      toolset: [],
      ...(voice ? { voice } : {}),
    },
    builtin: false,
  };
}

function serviceFor(voice: PersonalityConfig['voice']): PersonalitiesService {
  const entry = described(voice);
  const personalities = {
    describeAll: () => [entry],
    getDefault: () => entry.config,
  } as unknown as FilePersonalityRegistry;
  return new PersonalitiesService({
    personalities,
    library: {} as unknown as SkillsLibrary,
  });
}

describe('personality voice on the wire', () => {
  it('echoes every sub-key the editor can write, including tier, model and languages', async () => {
    const { items } = await serviceFor({
      tts_provider: 'studio',
      stt_provider: 'whisper-es',
      realtime_provider: 'live',
      tts_voice: 'af_bella',
      call_style: 'rings',
      tier: 'pipeline',
      model: 'claude-haiku-4-5',
      languages: { es: 'ef_dora' },
    }).list();

    expect(items[0]?.voice).toEqual({
      tts_provider: 'studio',
      stt_provider: 'whisper-es',
      realtime_provider: 'live',
      tts_voice: 'af_bella',
      call_style: 'rings',
      tier: 'pipeline',
      model: 'claude-haiku-4-5',
      languages: { es: 'ef_dora' },
    });
  });

  it('carries a language map even when nothing else in the block is set', async () => {
    const { items } = await serviceFor({ languages: { 'pt-BR': 'pf_ana' } }).list();
    expect(items[0]?.voice).toEqual({ languages: { 'pt-BR': 'pf_ana' } });
  });

  it('omits the block entirely for a personality that declares no voice', async () => {
    const { items } = await serviceFor(undefined).list();
    expect(items[0]?.voice).toBeUndefined();
  });
});
