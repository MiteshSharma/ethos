import { join } from 'node:path';
import {
  type CharacterSheetModelFit,
  FilePersonalityRegistry,
  renderCharacterSheet,
} from '@ethosagent/personalities';
import { SkillsInjector, SkillsLibrary, UniversalScanner } from '@ethosagent/skills';
import { FsStorage, InMemoryStorage } from '@ethosagent/storage-fs';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { PersonalitiesService } from '../../services/personalities.service';
import { makeStubPersonalityRegistry } from '../test-helpers';

function stubLLM(response: string): LLMProvider {
  return {
    name: 'mock',
    model: 'mock',
    maxContextTokens: 100_000,
    supportsCaching: false,
    supportsThinking: false,
    complete(_messages: Message[], _tools: unknown[]): AsyncIterable<CompletionChunk> {
      return (async function* () {
        yield { type: 'text_delta', text: response };
        yield { type: 'done', finishReason: 'end_turn' };
      })();
    },
    async countTokens() {
      return 0;
    },
  };
}

// Service tests cover both the repository (via real SOUL.md reads from
// InMemoryStorage) and the wire-shape mapping.

const DATA = '/data';

describe('PersonalitiesService', () => {
  function makeService(opts: { personalities: import('@ethosagent/types').PersonalityConfig[] }) {
    const registry = makeStubPersonalityRegistry(opts.personalities, DATA);
    const library = new SkillsLibrary({ dataDir: DATA, storage: new FsStorage() });
    return new PersonalitiesService({ personalities: registry, library });
  }

  it('list maps PersonalityConfig → wire shape and includes defaultId', async () => {
    const service = makeService({
      personalities: [
        {
          id: 'researcher',
          name: 'Researcher',
          description: 'curious + careful',
          model: 'claude-opus-4-7',
          // soulFile lives outside the user dir → built-in
          soulFile: '/usr/share/ethos/personalities/researcher/SOUL.md',
        },
      ],
    });
    const result = await service.list();
    expect(result.defaultId).toBe('researcher');
    expect(result.items).toHaveLength(1);
    const p = result.items[0];
    if (!p) throw new Error('expected one personality');
    expect(p.id).toBe('researcher');
    expect(p.builtin).toBe(true);
    // Server-internal fields are stripped
    expect('soulFile' in p).toBe(false);
    expect('skillsDirs' in p).toBe(false);
  });

  it('marks user personalities as builtin: false based on soulFile path', async () => {
    const userSoulFile = join(DATA, 'personalities', 'custom', 'SOUL.md');
    const service = makeService({
      personalities: [
        { id: 'custom', name: 'Custom', soulFile: userSoulFile },
        // No soulFile → treated as built-in (config-only personalities are built-ins by default)
        { id: 'builtin', name: 'Built-in' },
      ],
    });
    const result = await service.list();
    const byId = Object.fromEntries(result.items.map((p) => [p.id, p]));
    expect(byId.custom?.builtin).toBe(false);
    expect(byId.builtin?.builtin).toBe(true);
  });

  it('get returns personality + reads SOUL.md body from disk', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'researcher', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(soulPath, '# Researcher\n\nI am a careful researcher.\n');

    const registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({ id: 'researcher', name: 'Researcher', soulFile: soulPath });
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });
    const service = new PersonalitiesService({ personalities: registry, library });

    const result = await service.get('researcher');
    expect(result.personality.id).toBe('researcher');
    expect(result.soulMd).toContain('I am a careful researcher.');
    // soulFile under DATA/personalities/ → user-owned → builtin: false
    expect(result.personality.builtin).toBe(false);
  });

  it('get throws PERSONALITY_NOT_FOUND for unknown ids', async () => {
    const service = makeService({ personalities: [] });
    await expect(service.get('nope')).rejects.toMatchObject({ code: 'PERSONALITY_NOT_FOUND' });
  });

  it('get returns empty soulMd when file is missing', async () => {
    const service = makeService({
      personalities: [
        {
          id: 'researcher',
          name: 'Researcher',
          soulFile: join(DATA, 'personalities', 'researcher', 'SOUL.md'),
        },
      ],
    });
    const result = await service.get('researcher');
    expect(result.soulMd).toBe('');
  });

  it('characterSheet renders the Markdown artifact from config + SOUL.md', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'researcher', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(soulPath, '# Researcher\n\nI am a careful researcher.\n');

    const registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({
      id: 'researcher',
      name: 'Researcher',
      model: 'claude-opus-4-7',
      soulFile: soulPath,
    });
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });
    const service = new PersonalitiesService({ personalities: registry, library });

    const { markdown } = await service.characterSheet('researcher');
    expect(markdown).toMatch(/^# researcher — Researcher$/m);
    expect(markdown).toContain('I am a careful researcher.');
    expect(markdown).toContain('claude-opus-4-7');
  });

  it('characterSheet throws PERSONALITY_NOT_FOUND for unknown ids', async () => {
    const service = makeService({ personalities: [] });
    await expect(service.characterSheet('nope')).rejects.toMatchObject({
      code: 'PERSONALITY_NOT_FOUND',
    });
  });

  it('characterSheet threads the computed model fit through the SAME generator the CLI uses (Lane 6, D5)', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'researcher', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(soulPath, '# Researcher\n\nI am a careful researcher.\n');

    const registry = new FilePersonalityRegistry(storage, DATA);
    const config = {
      id: 'researcher',
      name: 'Researcher',
      model: 'qwen3:8b',
      soulFile: soulPath,
    };
    registry.define(config);
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });

    const fit: CharacterSheetModelFit = {
      verdict: 'refuses',
      model: 'qwen3:8b',
      windowTokens: 8_192,
      windowSource: 'probe',
      floor: {
        tokens: 7_200,
        toolCount: 12,
        components: [
          { name: 'SOUL.md', tokens: 2_060 },
          { name: 'tool schemas', tokens: 4_800 },
          { name: 'injection-defense prelude', tokens: 340 },
        ],
      },
      outputReserveTokens: 4_096,
      compactibleTokens: -3_104,
      staticShare: 0.879,
      degradations: [],
      refusalReason:
        'personality `researcher` cannot run on `qwen3:8b` (8,192 tokens): static prefix 7,200 + output reserve 4,096 exceeds the window. Largest contributor: tool schemas (4,800 tokens, 12 tools).',
      exclusions: ['tier models not evaluated'],
    };
    const service = new PersonalitiesService({
      personalities: registry,
      library,
      modelFit: async () => fit,
    });

    const { markdown } = await service.characterSheet('researcher');
    // One generator, both surfaces: the RPC markdown IS renderCharacterSheet's
    // output for the same inputs — byte-identical, no second renderer.
    const soulMd = await registry.readSoulMd('researcher');
    expect(markdown).toBe(renderCharacterSheet(config, soulMd, undefined, fit));
    expect(markdown).toContain('- Verdict: refuses');
    expect(markdown).toContain('Largest contributor: tool schemas (4,800 tokens, 12 tools).');
  });

  it('characterSheet renders without the verdict when the modelFit seam is absent or fails', async () => {
    const storage = new InMemoryStorage();
    const soulPath = join(DATA, 'personalities', 'researcher', 'SOUL.md');
    await storage.mkdir(join(DATA, 'personalities', 'researcher'));
    await storage.write(soulPath, '# Researcher\n\nI am a careful researcher.\n');
    const registry = new FilePersonalityRegistry(storage, DATA);
    registry.define({ id: 'researcher', name: 'Researcher', soulFile: soulPath });
    registry.setDefault('researcher');
    const library = new SkillsLibrary({ dataDir: DATA, storage });

    const absent = new PersonalitiesService({ personalities: registry, library });
    const failing = new PersonalitiesService({
      personalities: registry,
      library,
      modelFit: async () => {
        throw new Error('probe blew up');
      },
    });
    const a = await absent.characterSheet('researcher');
    const b = await failing.characterSheet('researcher');
    expect(a.markdown).not.toContain('## Model fit');
    // Fail-soft: a throwing seam degrades to the same verdict-less sheet.
    expect(b.markdown).toBe(a.markdown);
  });

  // -------------------------------------------------------------------------
  // MCP per-server tool subsets — mcp.yaml persistence + read-back. Mirrors
  // what the personalities.update RPC handler does when `mcp_servers` and
  // `mcp_tools` are both present.
  // -------------------------------------------------------------------------
  describe('MCP tool subsets', () => {
    async function makeMcpService() {
      const storage = new InMemoryStorage();
      const registry = new FilePersonalityRegistry(storage, DATA);
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      // A real user personality, so writes land on InMemoryStorage.
      await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        mcp_servers: ['linear', 'slack'],
      });
      return { service, storage };
    }

    // Replicates the RPC handler's `mcp_servers` + `mcp_tools` → subsets map.
    function buildSubsets(
      mcpServers: string[],
      mcpTools: Record<string, string[]>,
    ): Record<string, string[] | null> {
      const subsets: Record<string, string[] | null> = {};
      for (const server of mcpServers) subsets[server] = mcpTools[server] ?? null;
      return subsets;
    }

    it('persists a strict subset and clears all-selected servers', async () => {
      const { service, storage } = await makeMcpService();

      // linear → strict subset; slack → all tools (omitted from mcp_tools).
      await service.writeMcpToolSubsets(
        'agent',
        buildSubsets(['linear', 'slack'], { linear: ['list_issues'] }),
      );

      const yaml = await storage.read(join(DATA, 'personalities', 'agent', 'mcp.yaml'));
      expect(yaml).toContain('linear:');
      expect(yaml).toContain('- list_issues');
      // slack got `null` → no tools key → not present (default-allow).
      expect(yaml).not.toContain('slack:');

      const { mcpPolicy } = await service.get('agent');
      expect(mcpPolicy?.servers?.linear?.tools).toEqual(['list_issues']);
      expect(mcpPolicy?.servers?.slack).toBeUndefined();
    });

    it('get returns mcpPolicy: null when the personality has no mcp.yaml', async () => {
      const { service } = await makeMcpService();
      const { mcpPolicy } = await service.get('agent');
      expect(mcpPolicy).toBeNull();
    });

    it('preserves reject_args across a subsequent subset edit', async () => {
      // Seed a personality dir that already has an mcp.yaml carrying
      // reject_args, then load it so the registry's policy cache is warm.
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\nmcp_servers: linear\n');
      await storage.write(join(dir, 'SOUL.md'), '# Agent');
      await storage.write(
        join(dir, 'mcp.yaml'),
        [
          'servers:',
          '  linear:',
          '    tools:',
          '      - list_issues',
          '      - save_issue',
          '    reject_args:',
          '      save_issue:',
          '        status:',
          '          - Done',
        ].join('\n'),
      );
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });

      await service.writeMcpToolSubsets(
        'agent',
        buildSubsets(['linear'], { linear: ['list_issues'] }),
      );

      const { mcpPolicy } = await service.get('agent');
      expect(mcpPolicy?.servers?.linear?.tools).toEqual(['list_issues']);
      expect(mcpPolicy?.servers?.linear?.reject_args?.save_issue?.status).toEqual(['Done']);
    });
  });

  // -------------------------------------------------------------------------
  // Governed learning — Living Soul Expression evolution (Phase 3a)
  // -------------------------------------------------------------------------
  describe('governed learning', () => {
    async function makeSoulService(opts: {
      llm?: LLMProvider;
      soulMd?: string;
    }): Promise<{ service: PersonalitiesService; storage: InMemoryStorage }> {
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
      await storage.write(
        join(dir, 'SOUL.md'),
        opts.soulMd ?? '# Core\nI am the agent.\n\n# Expression\nI speak plainly.\n',
      );
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({
        personalities: registry,
        library,
        ...(opts.llm ? { llm: async () => opts.llm as LLMProvider } : {}),
      });
      return { service, storage };
    }

    it('proposeSoulSplit parses a canned CORE/EXPRESSION/RATIONALE split', async () => {
      const llm = stubLLM(
        'CORE:\nI am the agent.\n\nEXPRESSION:\nI speak plainly.\n\nRATIONALE: clean split.',
      );
      const { service } = await makeSoulService({ llm });
      const result = await service.proposeSoulSplit('I am the agent. I speak plainly.');
      expect(result.core).toContain('I am the agent.');
      expect(result.expression).toContain('I speak plainly.');
      expect(result.rationale).toBe('clean split.');
    });

    it('proposeSoulSplit throws NOT_CONFIGURED when no llm is configured', async () => {
      const { service } = await makeSoulService({});
      await expect(service.proposeSoulSplit('whatever')).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
      });
    });

    it('proposeExpression throws NOT_CONFIGURED when no llm is configured', async () => {
      const { service } = await makeSoulService({});
      await expect(service.proposeExpression('agent')).rejects.toMatchObject({
        code: 'NOT_CONFIGURED',
      });
    });

    it('applyExpression writes a revision and returns its id', async () => {
      const { service } = await makeSoulService({});
      const { revisionId } = await service.applyExpression(
        'agent',
        'I speak even more plainly.\n',
        'tighten voice',
        'sessions:test',
      );
      expect(revisionId).toBe('expr-rev-1');
      const soul = await service.livingSoul('agent');
      expect(soul.expression).toContain('I speak even more plainly.');
      expect(soul.learningLog).toHaveLength(1);
    });

    it('revertExpression on an empty learning log throws INVALID_INPUT', async () => {
      const { service } = await makeSoulService({});
      await expect(service.revertExpression('agent')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
    });

    it('revertExpression restores the prior snapshot after an apply', async () => {
      const { service } = await makeSoulService({});
      await service.applyExpression('agent', 'changed voice.\n', 'summary', 'sessions:test');
      const result = await service.revertExpression('agent');
      expect(result.ok).toBe(true);
      const soul = await service.livingSoul('agent');
      expect(soul.expression).toContain('I speak plainly.');
    });
  });

  // -------------------------------------------------------------------------
  // Living Soul judge alignment — reads `.judge-history/state.json` (Phase 3).
  // -------------------------------------------------------------------------
  describe('living soul judge alignment', () => {
    const STATE_PATH = join(DATA, 'personalities', 'agent', '.judge-history', 'state.json');

    async function makeJudgeService(stateRaw?: string): Promise<PersonalitiesService> {
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
      await storage.write(join(dir, 'SOUL.md'), '# Core\nI am the agent.\n\n# Expression\nHi.\n');
      if (stateRaw !== undefined) {
        await storage.mkdir(join(dir, '.judge-history'));
        await storage.write(STATE_PATH, stateRaw);
      }
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      return new PersonalitiesService({ personalities: registry, library, storage, dataDir: DATA });
    }

    it('includes judge with parsed values when state is present', async () => {
      const service = await makeJudgeService(
        JSON.stringify({
          lowStreak: 2,
          lastResult: {
            alignmentScore: 0.82,
            signal: 'drift',
            sampleCount: 5,
            perDimension: [{ id: 'core_expression_alignment', score: 0.82, evidence: 'ok' }],
          },
          at: '2026-06-17T00:00:00.000Z',
        }),
      );
      const soul = await service.livingSoul('agent');
      expect(soul.judge).toEqual({
        alignmentScore: 0.82,
        signal: 'drift',
        lowStreak: 2,
        at: '2026-06-17T00:00:00.000Z',
        perDimension: [{ dimension: 'core_expression_alignment', score: 0.82 }],
      });
    });

    it('omits judge when no state file exists', async () => {
      const service = await makeJudgeService();
      const soul = await service.livingSoul('agent');
      expect(soul.judge).toBeUndefined();
    });

    it('omits judge when the state JSON is malformed (no throw)', async () => {
      const service = await makeJudgeService('{not json');
      const soul = await service.livingSoul('agent');
      expect(soul.judge).toBeUndefined();
      expect(soul.expression).toContain('Hi.');
    });

    it('omits judge when storage / dataDir are not wired', async () => {
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
      await storage.write(join(dir, 'SOUL.md'), '# Core\nx\n');
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      const soul = await service.livingSoul('agent');
      expect(soul.judge).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Living Soul nightly status — reads `.nightly-state.json` (Phase 3).
  // -------------------------------------------------------------------------
  describe('living soul nightly status', () => {
    const STATE_PATH = join(DATA, 'personalities', 'agent', '.nightly-state.json');

    async function makeNightlyService(stateRaw?: string): Promise<PersonalitiesService> {
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
      await storage.write(join(dir, 'SOUL.md'), '# Core\nI am the agent.\n\n# Expression\nHi.\n');
      if (stateRaw !== undefined) {
        await storage.write(STATE_PATH, stateRaw);
      }
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      return new PersonalitiesService({ personalities: registry, library, storage, dataDir: DATA });
    }

    it('includes nightly with parsed values when state is present', async () => {
      const service = await makeNightlyService(
        JSON.stringify({
          windowEnd: '2026-06-17T00:00:00.000Z',
          completed: ['judge', 'dream'],
        }),
      );
      const soul = await service.livingSoul('agent');
      expect(soul.nightly).toEqual({
        windowEnd: '2026-06-17T00:00:00.000Z',
        completed: ['judge', 'dream'],
      });
    });

    it('omits nightly when no state file exists', async () => {
      const service = await makeNightlyService();
      const soul = await service.livingSoul('agent');
      expect(soul.nightly).toBeUndefined();
    });

    it('omits nightly when the state JSON is malformed (no throw)', async () => {
      const service = await makeNightlyService('{not json');
      const soul = await service.livingSoul('agent');
      expect(soul.nightly).toBeUndefined();
      expect(soul.expression).toContain('Hi.');
    });

    it('omits nightly when the shape is wrong (no throw)', async () => {
      const service = await makeNightlyService(
        JSON.stringify({ windowEnd: 123, completed: ['ok'] }),
      );
      const soul = await service.livingSoul('agent');
      expect(soul.nightly).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Governed-learning settings — evolution_approval_mode + skill_evolution
  // round-trip through create/update → config.yaml → toWire.
  // -------------------------------------------------------------------------
  describe('governed-learning settings round-trip', () => {
    async function makeRealService() {
      const storage = new InMemoryStorage();
      const registry = new FilePersonalityRegistry(storage, DATA);
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      return { service, storage };
    }

    it('persists evolution_approval_mode + skill_evolution on create and reads them back', async () => {
      const { service } = await makeRealService();
      const { personality } = await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        evolution_approval_mode: 'auto',
        skill_evolution: { enabled: true, min_tool_calls: 5, cooldown_minutes: 30 },
      });
      expect(personality.evolution_approval_mode).toBe('auto');
      expect(personality.skill_evolution).toEqual({
        enabled: true,
        min_tool_calls: 5,
        cooldown_minutes: 30,
      });
      const reloaded = await service.get('agent');
      expect(reloaded.personality.evolution_approval_mode).toBe('auto');
      expect(reloaded.personality.skill_evolution).toEqual({
        enabled: true,
        min_tool_calls: 5,
        cooldown_minutes: 30,
      });
    });

    it('update mutates evolution_approval_mode + skill_evolution and toWire reflects it', async () => {
      const { service } = await makeRealService();
      await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        evolution_approval_mode: 'user',
        skill_evolution: { enabled: false, min_tool_calls: 3, cooldown_minutes: 10 },
      });
      const { personality } = await service.update('agent', {
        evolution_approval_mode: 'auto',
        skill_evolution: { enabled: true, min_tool_calls: 7, cooldown_minutes: 45 },
      });
      expect(personality.evolution_approval_mode).toBe('auto');
      expect(personality.skill_evolution).toEqual({
        enabled: true,
        min_tool_calls: 7,
        cooldown_minutes: 45,
      });
    });

    it('update persists dreaming limits + skill_evolution.model and toWire reflects them', async () => {
      const { service } = await makeRealService();
      await service.create({ id: 'agent', name: 'Agent', toolset: [], soulMd: '# Agent' });

      const { personality } = await service.update('agent', {
        dreaming: { enable: true, idleMinutes: 30, maxPerDay: 3 },
        skill_evolution: { model: 'gpt-4o-mini' },
      });
      expect(personality.dreaming).toEqual({ enable: true, idleMinutes: 30, maxPerDay: 3 });
      expect(personality.skill_evolution?.model).toBe('gpt-4o-mini');

      const reloaded = await service.get('agent');
      expect(reloaded.personality.dreaming).toEqual({
        enable: true,
        idleMinutes: 30,
        maxPerDay: 3,
      });
      expect(reloaded.personality.skill_evolution?.model).toBe('gpt-4o-mini');
    });

    // The personality editor's voice fields — create, edit, and clear, all the
    // way through config.yaml and back out on the wire.
    it('persists the voice a create carries and reads it back on the wire', async () => {
      const { service } = await makeRealService();
      const { personality } = await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        voice: { provider: 'studio', tts_voice: 'nova' },
      });
      expect(personality.voice).toEqual({ provider: 'studio', tts_voice: 'nova' });
      const reloaded = await service.get('agent');
      expect(reloaded.personality.voice).toEqual({ provider: 'studio', tts_voice: 'nova' });
    });

    it('an update back to the default entry clears the provider on the wire too', async () => {
      const { service } = await makeRealService();
      await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
        voice: { provider: 'studio', tts_voice: 'nova' },
      });

      // What the edit form sends after switching the select back to Default.
      const { personality } = await service.update('agent', {
        voice: { provider: '', tts_voice: 'nova' },
      });
      expect(personality.voice).toEqual({ tts_voice: 'nova' });

      const cleared = await service.update('agent', { voice: { provider: '', tts_voice: '' } });
      expect(cleared.personality.voice).toBeUndefined();
    });

    it('omits voice entirely for a personality that declares none', async () => {
      const { service } = await makeRealService();
      const { personality } = await service.create({
        id: 'agent',
        name: 'Agent',
        toolset: [],
        soulMd: '# Agent',
      });
      expect(personality.voice).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Pending skill-candidate review queue — list / approve (promote) / reject.
  // Pending dir mirrors the nightly skill-evolver: <DATA>/skills/.pending/<id>.
  // -------------------------------------------------------------------------
  describe('skill-candidate review queue', () => {
    const PENDING = join(DATA, 'skills', '.pending', 'agent');
    const LIVE = join(DATA, 'skills');

    async function makeCandidateService(): Promise<{
      service: PersonalitiesService;
      storage: InMemoryStorage;
    }> {
      const storage = new InMemoryStorage();
      const dir = join(DATA, 'personalities', 'agent');
      await storage.mkdir(dir);
      await storage.write(join(dir, 'config.yaml'), 'name: Agent\n');
      await storage.write(join(dir, 'SOUL.md'), '# Core\nx\n');
      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({
        personalities: registry,
        library,
        storage,
        dataDir: DATA,
      });
      return { service, storage };
    }

    it('lists pending .md candidates', async () => {
      const { service, storage } = await makeCandidateService();
      await storage.mkdir(PENDING);
      await storage.write(join(PENDING, 'nightly-a.md'), '# A\nbody a\n');
      await storage.write(join(PENDING, 'nightly-b.md'), '# B\nbody b\n');
      await storage.write(join(PENDING, 'notes.txt'), 'ignored');

      const { candidates } = await service.skillCandidatesList('agent');
      const byName = Object.fromEntries(candidates.map((c) => [c.fileName, c.content]));
      expect(Object.keys(byName).sort()).toEqual(['nightly-a.md', 'nightly-b.md']);
      expect(byName['nightly-a.md']).toContain('body a');
    });

    it('returns [] when no pending dir exists', async () => {
      const { service } = await makeCandidateService();
      const { candidates } = await service.skillCandidatesList('agent');
      expect(candidates).toEqual([]);
    });

    it('approve writes the live file and removes the pending one', async () => {
      const { service, storage } = await makeCandidateService();
      await storage.mkdir(PENDING);
      await storage.write(join(PENDING, 'nightly-a.md'), '# A\nbody a\n');

      const result = await service.skillCandidateApprove('agent', 'nightly-a.md');
      expect(result).toEqual({ ok: true, promotedTo: join(LIVE, 'nightly-a.md') });
      expect(await storage.read(join(LIVE, 'nightly-a.md'))).toContain('body a');
      expect(await storage.exists(join(PENDING, 'nightly-a.md'))).toBe(false);
    });

    it('approve on a missing candidate throws SKILL_NOT_FOUND', async () => {
      const { service } = await makeCandidateService();
      await expect(service.skillCandidateApprove('agent', 'nope.md')).rejects.toMatchObject({
        code: 'SKILL_NOT_FOUND',
      });
    });

    it('approve drains the pending file even if the live skill already exists', async () => {
      const { service, storage } = await makeCandidateService();
      await storage.mkdir(LIVE);
      await storage.write(join(LIVE, 'nightly-a.md'), 'EXISTING live body\n');
      await storage.mkdir(PENDING);
      await storage.write(join(PENDING, 'nightly-a.md'), 'NEW candidate body\n');

      await service.skillCandidateApprove('agent', 'nightly-a.md');
      // Live file is left untouched; pending is cleared.
      expect(await storage.read(join(LIVE, 'nightly-a.md'))).toContain('EXISTING live body');
      expect(await storage.exists(join(PENDING, 'nightly-a.md'))).toBe(false);
    });

    it('reject removes the pending file', async () => {
      const { service, storage } = await makeCandidateService();
      await storage.mkdir(PENDING);
      await storage.write(join(PENDING, 'nightly-a.md'), '# A\n');

      await service.skillCandidateReject('agent', 'nightly-a.md');
      expect(await storage.exists(join(PENDING, 'nightly-a.md'))).toBe(false);
    });

    it('reject on a missing candidate succeeds idempotently', async () => {
      const { service } = await makeCandidateService();
      await expect(service.skillCandidateReject('agent', 'nightly-a.md')).resolves.toBeUndefined();
    });

    it('rejects a traversal file name and writes nothing', async () => {
      const { service, storage } = await makeCandidateService();
      await expect(service.skillCandidateApprove('agent', '../evil.md')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      await expect(service.skillCandidateReject('agent', 'a/b.md')).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      });
      expect(await storage.exists(join(LIVE, 'evil.md'))).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Per-personality safety + memory overrides — approvalMode + memory.provider
  // round-trip through update → config.yaml → toWire.
  // -------------------------------------------------------------------------
  describe('safety + memory overrides round-trip', () => {
    async function makeRealService() {
      const storage = new InMemoryStorage();
      const registry = new FilePersonalityRegistry(storage, DATA);
      const library = new SkillsLibrary({ dataDir: DATA, storage });
      const service = new PersonalitiesService({ personalities: registry, library });
      return { service, storage };
    }

    it('update persists safety.approvalMode + memory.provider and toWire reflects them', async () => {
      const { service } = await makeRealService();
      await service.create({ id: 'agent', name: 'Agent', toolset: [], soulMd: '# Agent' });

      const { personality } = await service.update('agent', {
        safety: { approvalMode: 'smart' },
        memory: { provider: 'vector' },
      });
      expect(personality.safety?.approvalMode).toBe('smart');
      expect(personality.memory?.provider).toBe('vector');

      const reloaded = await service.get('agent');
      expect(reloaded.personality.safety?.approvalMode).toBe('smart');
      expect(reloaded.personality.memory?.provider).toBe('vector');
    });
  });

  // -------------------------------------------------------------------------
  // renderers — skill-declared renderer capabilities, fail-closed
  // -------------------------------------------------------------------------

  describe('renderers', () => {
    const CHARTS_MD = `---
name: charts
description: Interactive charts.
required_tools: []

ethos:
  renders: ['echarts@1']
---
Emit an echarts fence.`;

    /** Registry + injector over one InMemoryStorage, with the charts skill
     *  installed into `researcher`'s per-personality skills/ dir. */
    async function makeRenderersService(withInjector: boolean) {
      const storage = new InMemoryStorage();
      const pdir = join(DATA, 'personalities', 'researcher');
      await storage.mkdir(join(pdir, 'skills'));
      await storage.write(join(pdir, 'config.yaml'), 'name: Researcher\n');
      await storage.write(join(pdir, 'SOUL.md'), '# Researcher\n');
      await storage.write(join(pdir, 'skills', 'charts.md'), CHARTS_MD);

      const registry = new FilePersonalityRegistry(storage, DATA);
      await registry.loadFromDirectory(join(DATA, 'personalities'));
      registry.setDefault('researcher');

      const injector = new SkillsInjector(registry, {
        storage,
        globalSkillsDir: join(DATA, 'skills'),
        // Hermetic pool — no real ~/.ethos or ~/.claude skills.
        scanner: new UniversalScanner({ storage, sources: [] }),
      });

      const service = new PersonalitiesService({
        personalities: registry,
        library: new SkillsLibrary({ dataDir: DATA, storage }),
        ...(withInjector ? { skillsInjector: injector } : {}),
      });
      return { service, injector };
    }

    it('returns the union of ethos.renders across the resolved skill set', async () => {
      const { service } = await makeRenderersService(true);
      expect(await service.renderers('researcher')).toEqual({ renderers: ['echarts@1'] });
    });

    it('returns [] when no injector is wired', async () => {
      const { service } = await makeRenderersService(false);
      expect(await service.renderers('researcher')).toEqual({ renderers: [] });
    });

    it('returns [] for an unknown personality instead of the default personality set', async () => {
      const { service } = await makeRenderersService(true);
      expect(await service.renderers('ghost')).toEqual({ renderers: [] });
    });

    it('returns [] when the derivation throws (fail-closed, never breaks the page)', async () => {
      const { service, injector } = await makeRenderersService(true);
      injector.resolveRenderers = async () => {
        throw new Error('scanner exploded');
      };
      expect(await service.renderers('researcher')).toEqual({ renderers: [] });
    });

    // Lane E — the character sheet reads the SAME derivation, so the sheet's
    // claim and the RPC the web renderer gates on cannot drift.
    it('characterSheet names the declared renderer under Capabilities', async () => {
      const { service } = await makeRenderersService(true);
      const { markdown } = await service.characterSheet('researcher');
      expect(markdown).toContain('- Renders: echarts@1 (interactive charts — via charts skill)');
    });

    it('characterSheet omits the Renders line when no injector is wired', async () => {
      const { service } = await makeRenderersService(false);
      const { markdown } = await service.characterSheet('researcher');
      expect(markdown).not.toContain('Renders:');
    });
  });
});
