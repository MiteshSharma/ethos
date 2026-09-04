import type { DescribedPersonality, FilePersonalityRegistry } from '@ethosagent/personalities';
import type { SkillsLibrary } from '@ethosagent/skills';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { PersonalitiesService } from '../personalities.service';

// What the personality editor gets to READ of a `safety` block — same rule as
// `personality-voice-wire.test.ts`: it has to be everything the editor can
// WRITE. The allowed-hosts field sends the whole `network` object on save, so a
// sub-key the wire omits is a sub-key the next save erases.

function serviceFor(safety: PersonalityConfig['safety']): PersonalitiesService {
  const entry: DescribedPersonality = {
    config: {
      id: 'briefer',
      name: 'Briefer',
      soulFile: 'SOUL.md',
      toolset: [],
      ...(safety ? { safety } : {}),
    },
    builtin: false,
  };
  const personalities = {
    describeAll: () => [entry],
    getDefault: () => entry.config,
  } as unknown as FilePersonalityRegistry;
  return new PersonalitiesService({
    personalities,
    library: {} as unknown as SkillsLibrary,
  });
}

describe('personality safety.network on the wire', () => {
  it('echoes the network policy back so the allowed-hosts field can populate', async () => {
    const { items } = await serviceFor({
      approvalMode: 'manual',
      network: { allow: ['*'], deny: ['tracker.example'], allow_private_urls: true },
    }).list();

    expect(items[0]?.safety).toEqual({
      approvalMode: 'manual',
      network: { allow: ['*'], deny: ['tracker.example'], allow_private_urls: true },
    });
  });

  it('carries a network policy even when no approval mode is set', async () => {
    const { items } = await serviceFor({ network: { allow: ['api.open-meteo.com'] } }).list();

    expect(items[0]?.safety).toEqual({ network: { allow: ['api.open-meteo.com'] } });
  });

  it('omits the safety block entirely when the personality declares none', async () => {
    const { items } = await serviceFor(undefined).list();

    expect(items[0]?.safety).toBeUndefined();
  });
});
