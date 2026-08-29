import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { verifyCard } from '../a2a-crypto';
import {
  PersonalityA2aIdentityProvider,
  parseSkillCard,
  resolveA2aSkillTools,
} from '../a2a-identity';
import { FilePersonalityRegistry } from '../index';

const ROOT = '/ethos/personalities';
const DIR = `${ROOT}/researcher`;

async function seedPersonality(storage: InMemoryStorage): Promise<void> {
  await storage.mkdir(DIR);
  await storage.write(
    `${DIR}/config.yaml`,
    ['name: Researcher', 'description: A careful researcher.'].join('\n'),
  );
  await storage.write(`${DIR}/SOUL.md`, '# Researcher\n\nI dig into questions and cite sources.\n');
  await storage.write(`${DIR}/toolset.yaml`, '- web_search\n');

  // Two skills: one exposed to agents, one private (no flag).
  await storage.mkdir(`${DIR}/skills/web-research`);
  await storage.write(
    `${DIR}/skills/web-research/SKILL.md`,
    [
      '---',
      'name: web-research',
      'description: Search the web and synthesize sources.',
      'ethos:',
      '  exposeToAgents: true',
      '---',
      'Body of the web-research skill.',
    ].join('\n'),
  );
  await storage.mkdir(`${DIR}/skills/internal-notes`);
  await storage.write(
    `${DIR}/skills/internal-notes/SKILL.md`,
    [
      '---',
      'name: internal-notes',
      'description: Private scratchpad conventions.',
      '---',
      'Body of the internal-notes skill.',
    ].join('\n'),
  );
}

async function makeProvider(): Promise<{
  provider: PersonalityA2aIdentityProvider;
  secrets: InMemorySecretsResolver;
  registry: FilePersonalityRegistry;
}> {
  const storage = new InMemoryStorage();
  await seedPersonality(storage);
  const registry = new FilePersonalityRegistry(storage);
  await registry.loadFromDirectory(ROOT);
  const secrets = new InMemorySecretsResolver();
  const provider = new PersonalityA2aIdentityProvider({
    personalities: registry,
    secrets,
    storage,
    baseUrl: 'https://agent.example',
  });
  return { provider, secrets, registry };
}

describe('PersonalityA2aIdentityProvider.getIdentity', () => {
  it('internal audience returns all of the personality skills', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'internal');
    expect(card.skills.map((s) => s.name).sort()).toEqual(['internal-notes', 'web-research']);
  });

  it('trusted-peer audience returns only exposeToAgents skills', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'trusted-peer');
    expect(card.skills.map((s) => s.name)).toEqual(['web-research']);
    expect(card.skills[0]?.description).toBe('Search the web and synthesize sources.');
  });

  it('default skill visibility is private (unflagged skill never leaks)', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'trusted-peer');
    expect(card.skills.some((s) => s.name === 'internal-notes')).toBe(false);
  });

  it('stranger audience returns a minimal card with no skill list', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'stranger');
    expect(card.skills).toEqual([]);
    expect(card.name).toBe('Researcher');
    expect(card.description).toBe('A careful researcher.');
  });

  it('produces a card that verifies (fingerprint + signature)', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'trusted-peer');
    expect(verifyCard(card)).toBe(true);
    expect(card.signatureAlg).toBe('ed25519');
    expect(card.protocolVersion).toBe('a2a/0.1');
  });

  it('carries endpoints and a DID envelope wired to the JSON-RPC endpoint', async () => {
    const { provider } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'internal');
    expect(card.endpoints.jsonRpc).toBe('https://agent.example/a2a/researcher');
    expect(card.endpoints.auth).toBe('https://agent.example/a2a-auth/researcher');
    expect(card.did.id.startsWith('did:key:z6Mk')).toBe(true);
    expect(card.did.service[0]?.serviceEndpoint).toBe('https://agent.example/a2a/researcher');
  });

  it('generates the key once and reuses it across calls (stable identity)', async () => {
    const { provider, secrets } = await makeProvider();
    const first = await provider.getIdentity('researcher', 'internal');
    const second = await provider.getIdentity('researcher', 'stranger');
    expect(second.publicKey).toBe(first.publicKey);
    expect(second.keyFingerprint).toBe(first.keyFingerprint);
    expect(await secrets.list('a2a/researcher/')).toEqual(['a2a/researcher/private-key']);
  });

  it('who-are-you parity: card name/description come from the same config + SOUL source', async () => {
    const { provider, registry } = await makeProvider();
    const card = await provider.getIdentity('researcher', 'stranger');
    const config = registry.get('researcher');
    // Same source renderCharacterSheet() reads — config.name and the SOUL/description headline.
    expect(card.name).toBe(config?.name);
    expect(card.description).toBe(config?.description);
  });

  it('throws for an unknown personality', async () => {
    const { provider } = await makeProvider();
    await expect(provider.getIdentity('nope', 'internal')).rejects.toThrow(/not found/i);
  });
});

// --- T0.2 / D8 — turn-time tool-narrowing resolution ------------------------

describe('resolveA2aSkillTools (plan T0.2 / D8)', () => {
  const DIR2 = `${ROOT}/relay`;
  const CONFIG: PersonalityConfig = {
    id: 'relay',
    name: 'Relay',
    skillsDirs: [`${DIR2}/skills`],
  };

  async function seed(): Promise<InMemoryStorage> {
    const storage = new InMemoryStorage();
    await storage.mkdir(`${DIR2}/skills/with-tools`);
    await storage.write(
      `${DIR2}/skills/with-tools/SKILL.md`,
      [
        '---',
        'name: with-tools',
        'description: Declares a non-empty required_tools list.',
        'required_tools: [web_search, read_file]',
        'ethos:',
        '  exposeToAgents: true',
        '---',
        'Body.',
      ].join('\n'),
    );
    await storage.mkdir(`${DIR2}/skills/empty-tools`);
    await storage.write(
      `${DIR2}/skills/empty-tools/SKILL.md`,
      [
        '---',
        'name: empty-tools',
        'description: Explicitly declares no tools.',
        'required_tools: []',
        'ethos:',
        '  exposeToAgents: true',
        '---',
        'Body.',
      ].join('\n'),
    );
    await storage.mkdir(`${DIR2}/skills/no-declaration`);
    await storage.write(
      `${DIR2}/skills/no-declaration/SKILL.md`,
      [
        '---',
        'name: no-declaration',
        'description: Never mentions required_tools at all.',
        'ethos:',
        '  exposeToAgents: true',
        '---',
        'Body.',
      ].join('\n'),
    );
    return storage;
  }

  it('returns the declared required_tools for a non-empty list', async () => {
    const storage = await seed();
    const result = await resolveA2aSkillTools(storage, CONFIG, 'with-tools');
    expect(result).toEqual({ found: true, requiredTools: ['web_search', 'read_file'] });
  });

  it('returns an empty array for an explicit required_tools: [] (legitimate, not a refusal)', async () => {
    const storage = await seed();
    const result = await resolveA2aSkillTools(storage, CONFIG, 'empty-tools');
    expect(result.found).toBe(true);
    expect(result.requiredTools).toEqual([]);
  });

  it('returns requiredTools: undefined when the key is entirely absent (fails closed, D2)', async () => {
    const storage = await seed();
    const result = await resolveA2aSkillTools(storage, CONFIG, 'no-declaration');
    expect(result.found).toBe(true);
    expect(result.requiredTools).toBeUndefined();
  });

  it('returns found: false when no SKILL.md matches the skill name at all', async () => {
    const storage = await seed();
    const result = await resolveA2aSkillTools(storage, CONFIG, 'ghost-skill');
    expect(result).toEqual({ found: false });
  });

  it('returns found: false when the personality has no skillsDirs', async () => {
    const storage = await seed();
    const result = await resolveA2aSkillTools(storage, { id: 'bare', name: 'Bare' }, 'with-tools');
    expect(result).toEqual({ found: false });
  });
});

// --- T0.1 — the operator-copyable exposure template ------------------------

describe('examples/skills/a2a-expose-template/SKILL.md (T0.1)', () => {
  const TEMPLATE_PATH = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    '..',
    'examples',
    'skills',
    'a2a-expose-template',
    'SKILL.md',
  );

  it('does not declare a2a_send in required_tools (D9 — not a relay amplifier)', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    const parsed = parseSkillCard(raw, TEMPLATE_PATH);
    expect(parsed.requiredTools ?? []).not.toContain('a2a_send');
  });

  it('is not named a2a-communicate or a2a-handle-inbound (D9)', () => {
    const raw = readFileSync(TEMPLATE_PATH, 'utf-8');
    const parsed = parseSkillCard(raw, TEMPLATE_PATH);
    expect(parsed.name).not.toBe('a2a-communicate');
    expect(parsed.name).not.toBe('a2a-handle-inbound');
  });
});
