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

  // The regression guard for the data-loss bug: the web config editor builds
  // `fs_reach` from its two path lists and sends the whole object. Before
  // `fs_reach` was shallow-merged, that patch replaced the stored block
  // wholesale and a hand-declared `workdir` vanished from disk — the agent
  // silently reverted to process.cwd().
  it('does NOT drop fs_reach.workdir when a read/write-only patch is applied', async () => {
    const registry = makeRegistry();
    await mkdir(join(testDir, 'personalities'), { recursive: true });
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    await registry.create({
      id: 'reach-preserve',
      name: 'ReachPreserve',
      toolset: ['read_file'],
      soulMd: '# ReachPreserve\n',
      fs_reach: { workdir: '${ETHOS_HOME}/workspace/${self}' },
    });
    expect(registry.get('reach-preserve')?.fs_reach?.workdir).toBe(
      '${ETHOS_HOME}/workspace/${self}',
    );

    await registry.update('reach-preserve', {
      fs_reach: { read: ['/data'], write: ['/data/output'] },
    });

    const raw = await readFile(
      join(testDir, 'personalities', 'reach-preserve', 'config.yaml'),
      'utf-8',
    );
    expect(raw).toContain('fs_reach.workdir: ${ETHOS_HOME}/workspace/${self}');

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    const config = fresh.get('reach-preserve')?.fs_reach;
    expect(config?.workdir).toBe('${ETHOS_HOME}/workspace/${self}');
    expect(config?.read).toEqual(['/data']);
    expect(config?.write).toEqual(['/data/output']);
  });

  it('clears fs_reach.workdir when the patch carries an empty string', async () => {
    await seedPersonality('reach-clear', 'name: ReachClear\nfs_reach.workdir: /srv/ethos/out\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('reach-clear')?.fs_reach?.workdir).toBe('/srv/ethos/out');

    // The config editor always sends `workdir`, empty string included, so the
    // shallow merge never makes the field un-clearable from that surface.
    await registry.update('reach-clear', {
      fs_reach: { read: ['/data'], write: [], workdir: '' },
    });

    const raw = await readFile(
      join(testDir, 'personalities', 'reach-clear', 'config.yaml'),
      'utf-8',
    );
    expect(raw).not.toContain('fs_reach.workdir');

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('reach-clear')?.fs_reach?.workdir).toBeUndefined();
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

// `PersonalityConfig.voice` — the voice V1a schema amendment. It rides the
// established DOTTED-KEY convention (`fs_reach.*`, `memory.options.*`,
// `nightly.judge.*`) rather than becoming a second nested block, so the flat
// parser reads it unchanged and the renderer emits it the same way it emits
// every other structured field.
describe('voice round-trip', () => {
  it('parses the dotted voice.* keys into the voice block', async () => {
    await seedPersonality(
      'voice-parse',
      `${[
        'name: VoiceParse',
        'voice.tts_voice: af_bella',
        'voice.tier: pipeline',
        'voice.model: claude-haiku-4-5',
        'voice.languages.es: ef_dora',
        'voice.languages.ja: jf_alpha',
      ].join('\n')}\n`,
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    expect(registry.get('voice-parse')?.voice).toEqual({
      tts_voice: 'af_bella',
      tier: 'pipeline',
      model: 'claude-haiku-4-5',
      languages: { es: 'ef_dora', ja: 'jf_alpha' },
    });
  });

  // `voice.tts_provider` / `voice.stt_provider` name entries in the deployment's
  // `voice.tts.providers.*` / `voice.stt.providers.*` rosters. They are SUB-KEYS
  // of the existing `voice` block, not new top-level PersonalityConfig fields —
  // the field count stays where it is.
  it('parses both roster keys and keeps them verbatim through an update', async () => {
    await seedPersonality(
      'voice-roster',
      'name: VoiceRoster\nvoice.tts_provider: studio\nvoice.stt_provider: whisper-es\nvoice.tts_voice: alloy\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('voice-roster')?.voice).toEqual({
      tts_provider: 'studio',
      stt_provider: 'whisper-es',
      tts_voice: 'alloy',
    });

    await registry.update('voice-roster', { description: 'still points at studio' });
    const raw = await readFile(
      join(testDir, 'personalities', 'voice-roster', 'config.yaml'),
      'utf-8',
    );
    expect(raw).toContain('voice.tts_provider: studio');
    expect(raw).toContain('voice.stt_provider: whisper-es');

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('voice-roster')?.voice?.tts_provider).toBe('studio');
    expect(fresh.get('voice-roster')?.voice?.stt_provider).toBe('whisper-es');
  });

  // `voice.provider` was the spelling before a personality could name an STT
  // engine. A hand-written config still carrying it must load, and re-serialize
  // to the new key alone.
  it('accepts the older voice.provider spelling and rewrites it as voice.tts_provider', async () => {
    await seedPersonality(
      'voice-legacy',
      'name: VoiceLegacy\nvoice.provider: studio\nvoice.tts_voice: alloy\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('voice-legacy')?.voice).toEqual({
      tts_provider: 'studio',
      tts_voice: 'alloy',
    });

    await registry.update('voice-legacy', { description: 'unrelated edit' });
    const raw = await readFile(
      join(testDir, 'personalities', 'voice-legacy', 'config.yaml'),
      'utf-8',
    );
    expect(raw).toContain('voice.tts_provider: studio');
    expect(raw).not.toMatch(/^voice\.provider:/m);

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('voice-legacy')?.voice?.tts_provider).toBe('studio');
  });

  it('prefers the new spelling when a config somehow carries both', async () => {
    await seedPersonality(
      'voice-both',
      'name: VoiceBoth\nvoice.provider: old\nvoice.tts_provider: new\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('voice-both')?.voice).toEqual({ tts_provider: 'new' });
  });

  it('loads a personality naming a provider this machine has never heard of', async () => {
    // Validation would mean the loader knew the machine's config. It does not:
    // an unknown name is a resolution-time fallback, never a load failure.
    await seedPersonality(
      'voice-alien',
      'name: VoiceAlien\nvoice.tts_provider: elevenlabs-studio\nvoice.stt_provider: deepgram-eu\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('voice-alien')?.voice).toEqual({
      tts_provider: 'elevenlabs-studio',
      stt_provider: 'deepgram-eu',
    });
  });

  // The editor's write path: create with a voice, retune it, and clear it back
  // to the default entry — all through the sub-keys the web form exposes.
  it('writes the voice a create carries, and nothing when it carries none', async () => {
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.create({
      id: 'voice-created',
      name: 'VoiceCreated',
      toolset: ['read_file'],
      soulMd: '# VoiceCreated\n',
      voice: { tts_provider: 'studio', stt_provider: 'whisper-es', tts_voice: 'nova' },
    });
    expect(registry.get('voice-created')?.voice).toEqual({
      tts_provider: 'studio',
      stt_provider: 'whisper-es',
      tts_voice: 'nova',
    });

    // Blank form fields are not a voice block — an empty `voice.tts_provider:` line
    // would be a key the loader reads back as nothing.
    await registry.create({
      id: 'voice-blank',
      name: 'VoiceBlank',
      toolset: ['read_file'],
      soulMd: '# VoiceBlank\n',
      voice: { tts_provider: '', stt_provider: '', tts_voice: '' },
    });
    expect(registry.get('voice-blank')?.voice).toBeUndefined();
    const blankRaw = await readFile(
      join(testDir, 'personalities', 'voice-blank', 'config.yaml'),
      'utf-8',
    );
    expect(blankRaw).not.toContain('voice.');
  });

  it('updates one voice sub-key without disturbing the others', async () => {
    await seedPersonality(
      'voice-patch',
      'name: VoicePatch\nvoice.tts_provider: studio\nvoice.tts_voice: alloy\nvoice.languages.es: ef_dora\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('voice-patch', { voice: { tts_voice: 'nova' } });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    // The hand-written language map is not something the web form can express,
    // so a save from it must not be able to delete one.
    expect(fresh.get('voice-patch')?.voice).toEqual({
      tts_provider: 'studio',
      tts_voice: 'nova',
      languages: { es: 'ef_dora' },
    });
  });

  it('an empty provider clears the key, putting it back on the default entry', async () => {
    await seedPersonality(
      'voice-clear',
      'name: VoiceClear\nvoice.tts_provider: studio\nvoice.tts_voice: alloy\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('voice-clear', { voice: { tts_provider: '', tts_voice: 'alloy' } });

    const raw = await readFile(
      join(testDir, 'personalities', 'voice-clear', 'config.yaml'),
      'utf-8',
    );
    expect(raw).not.toContain('voice.tts_provider');
    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('voice-clear')?.voice).toEqual({ tts_voice: 'alloy' });
  });

  it('clearing every sub-key removes the voice block entirely', async () => {
    await seedPersonality('voice-drop', 'name: VoiceDrop\nvoice.tts_voice: alloy\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('voice-drop', { voice: { tts_provider: '', tts_voice: '' } });

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('voice-drop')?.voice).toBeUndefined();
  });

  it('carries no voice block when no voice.* key is set', async () => {
    await seedPersonality('voice-absent', 'name: VoiceAbsent\n');
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('voice-absent')?.voice).toBeUndefined();
  });

  it('drops an unknown tier rather than making the personality unloadable', async () => {
    await seedPersonality(
      'voice-bad-tier',
      'name: VoiceBadTier\nvoice.tts_voice: af_bella\nvoice.tier: telepathy\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));
    expect(registry.get('voice-bad-tier')?.voice).toEqual({ tts_voice: 'af_bella' });
  });

  it('survives an unrelated update and re-load', async () => {
    await seedPersonality(
      'voice-persist',
      'name: VoicePersist\nvoice.tts_voice: af_bella\nvoice.languages.es: ef_dora\n',
    );
    const registry = makeRegistry();
    await registry.loadFromDirectory(join(testDir, 'personalities'));

    await registry.update('voice-persist', { description: 'now with a description' });

    const raw = await readFile(
      join(testDir, 'personalities', 'voice-persist', 'config.yaml'),
      'utf-8',
    );
    expect(raw).toContain('voice.tts_voice: af_bella');
    expect(raw).toContain('voice.languages.es: ef_dora');

    const fresh = makeRegistry();
    await fresh.loadFromDirectory(join(testDir, 'personalities'));
    expect(fresh.get('voice-persist')?.voice).toEqual({
      tts_voice: 'af_bella',
      languages: { es: 'ef_dora' },
    });
  });
});
