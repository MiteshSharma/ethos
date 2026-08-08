// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal `${self}` / `${ETHOS_HOME}` / `${CWD}` tokens — not template interpolation.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FilePersonalityRegistry } from '../index';

let testDir: string;

beforeEach(async () => {
  testDir = join(tmpdir(), `ethos-roundtrip-${Date.now()}-${randomBytes(4).toString('hex')}`);
  await mkdir(testDir, { recursive: true });
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

async function seedPersonality(
  id: string,
  config: string,
  soulMd = `# ${id}\n\nIdentity text.\n`,
  toolset = '- read_file\n',
): Promise<void> {
  const dir = join(testDir, 'personalities', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'config.yaml'), config);
  await writeFile(join(dir, 'SOUL.md'), soulMd);
  await writeFile(join(dir, 'toolset.yaml'), toolset);
}

function makeRegistry(): FilePersonalityRegistry {
  return new FilePersonalityRegistry(new FsStorage(), testDir);
}

describe('capabilities round-trip', () => {
  it('persists capabilities through update and re-load', async () => {
    await seedPersonality('cap-test', 'name: CapTest\ndescription: Testing caps\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('cap-test', { capabilities: ['triage', 'release'] });

    // Re-load into a fresh registry to verify persistence
    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('cap-test');
    expect(config).toBeDefined();
    expect(config?.capabilities).toEqual(['triage', 'release']);
  });

  it('writes comma-separated capabilities to config.yaml', async () => {
    await seedPersonality('cap-yaml', 'name: CapYaml\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('cap-yaml', { capabilities: ['triage', 'release'] });

    const raw = await readFile(join(testDir, 'personalities', 'cap-yaml', 'config.yaml'), 'utf-8');
    expect(raw).toContain('capabilities: triage, release');
  });
});

describe('provider round-trip', () => {
  it('persists provider: openai through update and re-load', async () => {
    await seedPersonality('prov-openai', 'name: ProvOpenai\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('prov-openai', { provider: 'openai' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('prov-openai')?.provider).toBe('openai');
  });

  it('persists provider: azure through update and re-load', async () => {
    await seedPersonality('prov-azure', 'name: ProvAzure\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('prov-azure', { provider: 'azure' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('prov-azure')?.provider).toBe('azure');
  });

  it('clears provider when updated with empty string', async () => {
    await seedPersonality('prov-clear', 'name: ProvClear\nprovider: openai\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('prov-clear')?.provider).toBe('openai');

    await registry.update('prov-clear', { provider: '' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    // Empty string is treated as falsy by the loader — provider should be undefined
    expect(fresh.get('prov-clear')?.provider).toBeUndefined();
  });
});

describe('fs_reach round-trip', () => {
  it('persists fs_reach through update and re-load', async () => {
    await seedPersonality('reach-test', 'name: ReachTest\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('reach-test', {
      fs_reach: { read: ['/data', '${self}/docs'], write: ['/data/output'] },
    });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('reach-test');
    expect(config?.fs_reach?.read).toEqual(['/data', '${self}/docs']);
    expect(config?.fs_reach?.write).toEqual(['/data/output']);
  });

  it('writes dotted fs_reach keys to config.yaml', async () => {
    await seedPersonality('reach-yaml', 'name: ReachYaml\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('reach-yaml', {
      fs_reach: { read: ['/data', '${self}/docs'], write: ['/data/output'] },
    });

    const raw = await readFile(
      join(testDir, 'personalities', 'reach-yaml', 'config.yaml'),
      'utf-8',
    );
    expect(raw).toContain('fs_reach.read: /data, ${self}/docs');
    expect(raw).toContain('fs_reach.write: /data/output');
  });

  it('persists fs_reach.workdir through update and re-load', async () => {
    await seedPersonality('reach-workdir', 'name: ReachWorkdir\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('reach-workdir', {
      fs_reach: { workdir: '${ETHOS_HOME}/workspace/${self}' },
    });

    const raw = await readFile(
      join(testDir, 'personalities', 'reach-workdir', 'config.yaml'),
      'utf-8',
    );
    expect(raw).toContain('fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}');

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    // A workdir-only declaration must still construct fs_reach — the loader's
    // truthiness guard used to look at read/write only.
    expect(fresh.get('reach-workdir')?.fs_reach?.workdir).toBe('${ETHOS_HOME}/workspace/${self}');
  });
});

describe('dreaming round-trip', () => {
  it('does NOT drop dreaming when an unrelated field is updated', async () => {
    await seedPersonality(
      'dream-preserve',
      'name: DreamPreserve\ndreaming.enable: true\ndreaming.idleMinutes: 45\ndreaming.maxPerDay: 2\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('dream-preserve')?.dreaming?.enable).toBe(true);

    // Update an UNRELATED field — dreaming must survive the config.yaml rewrite.
    await registry.update('dream-preserve', { description: 'changed' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('dream-preserve');
    expect(config?.description).toBe('changed');
    expect(config?.dreaming?.enable).toBe(true);
    expect(config?.dreaming?.idleMinutes).toBe(45);
    expect(config?.dreaming?.maxPerDay).toBe(2);
  });

  it('persists a dreaming patch through update and re-load', async () => {
    await seedPersonality('dream-set', 'name: DreamSet\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('dream-set')?.dreaming).toBeUndefined();

    await registry.update('dream-set', {
      dreaming: { enable: true, idleMinutes: 60, maxPerDay: 1 },
    });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('dream-set');
    expect(config?.dreaming?.enable).toBe(true);
    expect(config?.dreaming?.idleMinutes).toBe(60);
    expect(config?.dreaming?.maxPerDay).toBe(1);
  });

  it('toggling dreaming back to disabled persists as off', async () => {
    await seedPersonality(
      'dream-toggle',
      'name: DreamToggle\ndreaming.enable: true\ndreaming.idleMinutes: 30\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('dream-toggle')?.dreaming?.enable).toBe(true);

    await registry.update('dream-toggle', {
      dreaming: { enable: false, idleMinutes: 30, maxPerDay: 1 },
    });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    // buildDreamingConfig treats enable!=='true' as off → dreaming is undefined.
    expect(fresh.get('dream-toggle')?.dreaming?.enable).not.toBe(true);
  });

  it('persists a full dreaming patch with cadence through update and re-load', async () => {
    await seedPersonality('dream-cadence', 'name: DreamCadence\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('dream-cadence', {
      dreaming: { enable: true, idleMinutes: 30, maxPerDay: 3 },
    });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('dream-cadence');
    expect(config?.dreaming?.enable).toBe(true);
    expect(config?.dreaming?.idleMinutes).toBe(30);
    expect(config?.dreaming?.maxPerDay).toBe(3);
  });

  it('a partial dreaming patch preserves sibling cadence fields', async () => {
    await seedPersonality(
      'dream-partial',
      'name: DreamPartial\ndreaming.enable: true\ndreaming.idleMinutes: 45\ndreaming.maxPerDay: 2\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    // Patch only maxPerDay — enable + idleMinutes must survive.
    await registry.update('dream-partial', { dreaming: { maxPerDay: 5 } });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('dream-partial');
    expect(config?.dreaming?.enable).toBe(true);
    expect(config?.dreaming?.idleMinutes).toBe(45);
    expect(config?.dreaming?.maxPerDay).toBe(5);
  });
});

describe('nightly round-trip', () => {
  it('persists a nightly patch through update and re-load', async () => {
    await seedPersonality('nightly-set', 'name: NightlySet\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('nightly-set')?.nightly).toBeUndefined();

    await registry.update('nightly-set', {
      nightly: {
        enabled: false,
        judge: { enabled: false, minInteractions: 30 },
        expression: false,
      },
    });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('nightly-set');
    expect(config?.nightly?.enabled).toBe(false);
    expect(config?.nightly?.judge?.enabled).toBe(false);
    expect(config?.nightly?.judge?.minInteractions).toBe(30);
    expect(config?.nightly?.expression).toBe(false);
  });

  it('writes dotted nightly keys to config.yaml', async () => {
    await seedPersonality('nightly-yaml', 'name: NightlyYaml\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('nightly-yaml', {
      nightly: { enabled: true, judge: { enabled: true, minInteractions: 15 }, expression: true },
    });

    const raw = await readFile(
      join(testDir, 'personalities', 'nightly-yaml', 'config.yaml'),
      'utf-8',
    );
    expect(raw).toContain('nightly.enabled: true');
    expect(raw).toContain('nightly.judge.enabled: true');
    expect(raw).toContain('nightly.judge.minInteractions: 15');
    expect(raw).toContain('nightly.expression: true');
  });

  it('does NOT drop nightly when an unrelated field is updated', async () => {
    await seedPersonality(
      'nightly-preserve',
      'name: NightlyPreserve\nnightly.enabled: false\nnightly.judge.minInteractions: 40\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('nightly-preserve', { description: 'changed' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('nightly-preserve');
    expect(config?.description).toBe('changed');
    expect(config?.nightly?.enabled).toBe(false);
    expect(config?.nightly?.judge?.minInteractions).toBe(40);
  });

  it('a full nightly patch replaces the judge sub-object (one-level merge)', async () => {
    await seedPersonality(
      'nightly-merge',
      'name: NightlyMerge\nnightly.judge.enabled: true\nnightly.judge.minInteractions: 50\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    // The UI sends the FULL nightly object incl. the full judge sub-object, so
    // a one-level merge replaces `judge` wholesale.
    await registry.update('nightly-merge', {
      nightly: { judge: { enabled: false, minInteractions: 20 } },
    });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('nightly-merge');
    expect(config?.nightly?.judge?.enabled).toBe(false);
    expect(config?.nightly?.judge?.minInteractions).toBe(20);
  });
});

describe('skill_evolution round-trip', () => {
  it('persists skill_evolution.model through update and re-load', async () => {
    await seedPersonality('skill-model', 'name: SkillModel\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('skill-model', { skill_evolution: { model: 'x' } });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('skill-model')?.skill_evolution?.model).toBe('x');
  });

  it('a skill_evolution.model patch preserves sibling fields', async () => {
    await seedPersonality(
      'skill-preserve',
      'name: SkillPreserve\nskill_evolution.enabled: true\nskill_evolution.min_tool_calls: 5\nskill_evolution.cooldown_minutes: 15\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('skill-preserve', { skill_evolution: { model: 'y' } });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const se = fresh.get('skill-preserve')?.skill_evolution;
    expect(se?.model).toBe('y');
    expect(se?.enabled).toBe(true);
    expect(se?.min_tool_calls).toBe(5);
    expect(se?.cooldown_minutes).toBe(15);
  });

  it('persists evolve_existing, promotion, and scope through update and re-load', async () => {
    await seedPersonality('skill-p5', 'name: SkillP5\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('skill-p5', {
      skill_evolution: { evolve_existing: false, promotion: 'auto', scope: 'personality' },
    });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const se = fresh.get('skill-p5')?.skill_evolution;
    expect(se?.evolve_existing).toBe(false);
    expect(se?.promotion).toBe('auto');
    expect(se?.scope).toBe('personality');
  });

  it('a promotion-only patch preserves enabled/min/cooldown/model siblings', async () => {
    await seedPersonality(
      'skill-p5-preserve',
      [
        'name: SkillP5Preserve',
        'skill_evolution.enabled: true',
        'skill_evolution.min_tool_calls: 5',
        'skill_evolution.cooldown_minutes: 15',
        'skill_evolution.model: m',
        '',
      ].join('\n'),
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('skill-p5-preserve', { skill_evolution: { promotion: 'review' } });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const se = fresh.get('skill-p5-preserve')?.skill_evolution;
    expect(se?.promotion).toBe('review');
    expect(se?.enabled).toBe(true);
    expect(se?.min_tool_calls).toBe(5);
    expect(se?.cooldown_minutes).toBe(15);
    expect(se?.model).toBe('m');
  });
});

describe('governed-learning settings round-trip', () => {
  it('persists evolution_approval_mode through update and re-load', async () => {
    await seedPersonality('gl-mode', 'name: GLMode\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('gl-mode', { evolution_approval_mode: 'auto' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('gl-mode')?.evolution_approval_mode).toBe('auto');
  });

  it('persists skill_evolution through update and re-load', async () => {
    await seedPersonality('gl-skill', 'name: GLSkill\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('gl-skill', {
      skill_evolution: { enabled: true, min_tool_calls: 7, cooldown_minutes: 45 },
    });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('gl-skill')?.skill_evolution).toEqual({
      enabled: true,
      min_tool_calls: 7,
      cooldown_minutes: 45,
    });
  });

  it('preserves evolution_approval_mode + skill_evolution when an unrelated field is updated', async () => {
    await seedPersonality(
      'gl-preserve',
      [
        'name: GLPreserve',
        'evolution_approval_mode: user',
        'skill_evolution.enabled: true',
        'skill_evolution.min_tool_calls: 5',
        'skill_evolution.cooldown_minutes: 30',
        '',
      ].join('\n'),
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('gl-preserve', { description: 'changed' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const after = fresh.get('gl-preserve');
    expect(after?.description).toBe('changed');
    expect(after?.evolution_approval_mode).toBe('user');
    expect(after?.skill_evolution).toEqual({
      enabled: true,
      min_tool_calls: 5,
      cooldown_minutes: 30,
    });
  });
});

describe('safety + memory settings round-trip', () => {
  it('persists safety.approvalMode through update and re-load', async () => {
    await seedPersonality('sm-safety', 'name: SMSafety\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('sm-safety', { safety: { approvalMode: 'smart' } });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('sm-safety')?.safety?.approvalMode).toBe('smart');
  });

  it('persists memory.provider through update and re-load', async () => {
    await seedPersonality('sm-memory', 'name: SMMemory\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('sm-memory', { memory: { provider: 'vector' } });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('sm-memory')?.memory?.provider).toBe('vector');
  });

  it('preserves safety + memory when an unrelated field is updated', async () => {
    await seedPersonality(
      'sm-preserve',
      ['name: SMPreserve', 'memory.provider: vector', 'safety:', '  approvalMode: smart', ''].join(
        '\n',
      ),
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('sm-preserve', { description: 'changed' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const after = fresh.get('sm-preserve');
    expect(after?.description).toBe('changed');
    expect(after?.safety?.approvalMode).toBe('smart');
    expect(after?.memory?.provider).toBe('vector');
  });

  it('merges a safety.approvalMode patch without dropping sibling safety fields', async () => {
    await seedPersonality(
      'sm-merge',
      [
        'name: SMMerge',
        'safety:',
        '  approvalMode: manual',
        '  observability:',
        '    storeToolArgs: redacted',
        '',
      ].join('\n'),
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('sm-merge', { safety: { approvalMode: 'off' } });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const after = fresh.get('sm-merge');
    expect(after?.safety?.approvalMode).toBe('off');
    expect(after?.safety?.observability?.storeToolArgs).toBe('redacted');
  });
});

describe('lossless update — full config round-trip', () => {
  // A config.yaml that populates EVERY droppable PersonalityConfig field with
  // realistic values. The syntax of each key mirrors what parseConfigYaml /
  // the buildX helpers read back. Updating one unrelated field must preserve
  // all of these verbatim.
  const FULL_CONFIG = [
    'name: FullPersona',
    'description: Original description',
    'provider: openai',
    'platform: cli',
    'model.trivial: gpt-4o-mini',
    'model.default: gpt-4o',
    'model.deep: o1',
    'model.dreaming: gpt-4o-mini',
    'capabilities: triage, release',
    'mcp_servers: linear slack',
    'plugins: kanban notes',
    'fs_reach.read: /data, ${self}/docs',
    'fs_reach.write: /data/output',
    'fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}',
    'streamingTimeoutMs: 90000',
    'budgetCapUsd: 12.5',
    'evolution_approval_mode: user',
    'context_engine: drop_oldest',
    'context_engine_options.threshold: 1000',
    'context_engine_options.aggressive: true',
    'context_layering.mode: progressive',
    'context_layering.max_depth: 3',
    'context_layering.discovery_files: AGENTS.md, CLAUDE.md',
    'context_layering.cap_total_chars: 5000',
    'skill_evolution.enabled: true',
    'skill_evolution.min_tool_calls: 5',
    'skill_evolution.cooldown_minutes: 30',
    'memory.provider: vector',
    'memory.options.dim: 768',
    'memory.options.normalize: true',
    'mcp_export.enabled: true',
    'mcp_export.expose_tools: read_file write_file',
    'mcp_export.expose_memory: scoped',
    'mcp_export.expose_sessions: true',
    'mcp_export.auth: bearer',
    'outbound_policy.approve_before_send: true',
    'outbound_policy.channels: telegram slack',
    'outbound_policy.approver_personality: reviewer',
    'dreaming.enable: true',
    'dreaming.idleMinutes: 45',
    'dreaming.maxPerDay: 2',
    'dreaming.prompt: Reflect on the day.',
    'nightly.enabled: true',
    'nightly.judge.enabled: false',
    'nightly.judge.minInteractions: 30',
    'nightly.expression: false',
    'safety:',
    '  approvalMode: smart',
    '  observability:',
    '    storeToolArgs: redacted',
    '    storeToolBodies: none',
    '    storeLlmPayloads: metadata',
    '    redactPatterns:',
    '      - secret',
    '      - token',
    '  allowed_skill_permissions:',
    '    fs_read:',
    '      - /data',
    '    network: true',
    '  network:',
    '    allow:',
    '      - example.com',
    '    deny:',
    '      - evil.com',
    '    allow_private_urls: true',
    '  injectionDefense:',
    '    enabled: false',
    '    classifier:',
    '      alwaysCallLLM: true',
    '    postReadDowngrade:',
    '      enabled: true',
    '      turns: 3',
    '      tools:',
    '        - terminal',
    '    blockSecretResults: true',
    '    toolResultDelimiters: false',
    '  piiRedaction:',
    '    enabled: true',
    '    extraPatterns:',
    '      - ssn',
    '',
  ].join('\n');

  it('preserves every config field when an unrelated field is updated', async () => {
    await seedPersonality('full-persona', FULL_CONFIG);
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    const before = registry.get('full-persona');
    expect(before).toBeDefined();
    // Snapshot the loaded config before the update.
    const snapshot = structuredClone(before);

    // Update a single unrelated field. Every other field must survive the
    // config.yaml rewrite untouched.
    await registry.update('full-persona', { description: 'changed' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const after = fresh.get('full-persona');
    expect(after).toBeDefined();

    // Everything except description must deep-equal the pre-update snapshot.
    const expected = { ...structuredClone(snapshot), description: 'changed' };
    expect(after).toEqual(expected);
    expect(after?.description).toBe('changed');
  });
});

describe('safety block preservation', () => {
  it('preserves the full safety block when an unrelated field is updated', async () => {
    const cfg = `${[
      'name: Guarded',
      'description: Has a rich safety block',
      'safety:',
      '  approvalMode: smart',
      '  network:',
      '    allow: - api.example.com',
      '    - cdn.example.com',
      '    allow_private_urls: true',
      '  observability:',
      '    storeToolArgs: redacted',
      '    redactPatterns: - secret',
      '    - token',
    ].join('\n')}\n`;
    await seedPersonality('safety-rich', cfg);
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('safety-rich', { name: 'Renamed' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('safety-rich');
    expect(config?.name).toBe('Renamed');
    expect(config?.safety?.approvalMode).toBe('smart');
    expect(config?.safety?.observability?.storeToolArgs).toBe('redacted');
    expect(config?.safety?.observability?.redactPatterns).toEqual(['secret', 'token']);

    // The network sub-block is dropped on READ, so the only proof it survived is
    // the raw written config.yaml retaining it verbatim. This is the
    // security-critical assertion.
    const raw = await readFile(
      join(testDir, 'personalities', 'safety-rich', 'config.yaml'),
      'utf-8',
    );
    expect(raw).toContain('network:');
    expect(raw).toContain('api.example.com');
    expect(raw).toContain('cdn.example.com');
    expect(raw).toContain('allow_private_urls: true');
  });

  it('updates fine and stays safety-free when there is no safety block', async () => {
    await seedPersonality('safety-none', 'name: Plain\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('safety-none', { name: 'Plain2' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('safety-none')?.name).toBe('Plain2');
    expect(fresh.get('safety-none')?.safety).toBeUndefined();

    const raw = await readFile(
      join(testDir, 'personalities', 'safety-none', 'config.yaml'),
      'utf-8',
    );
    expect(raw).not.toContain('safety:');
  });

  it('keeps the safety block intact across repeated rewrites', async () => {
    const cfg = `${[
      'name: Guarded',
      'description: Has a rich safety block',
      'safety:',
      '  approvalMode: smart',
      '  network:',
      '    allow: - api.example.com',
      '    - cdn.example.com',
      '    allow_private_urls: true',
      '  observability:',
      '    storeToolArgs: redacted',
      '    redactPatterns: - secret',
      '    - token',
    ].join('\n')}\n`;
    await seedPersonality('safety-twice', cfg);
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('safety-twice', { name: 'Renamed' });
    const second = makeRegistry();
    await second.loadFromDirectory(join(testDir, 'personalities'));
    await second.update('safety-twice', { description: 'updated again' });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('safety-twice');
    expect(config?.safety?.approvalMode).toBe('smart');
    expect(config?.safety?.observability?.storeToolArgs).toBe('redacted');

    const raw = await readFile(
      join(testDir, 'personalities', 'safety-twice', 'config.yaml'),
      'utf-8',
    );
    expect(raw).toContain('api.example.com');
  });
});
