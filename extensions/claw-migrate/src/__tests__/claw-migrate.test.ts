import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ClawMigrator } from '../index';

// Each test gets its own pair of (source, target, workspace) tmpdirs so they
// can run in parallel without stomping on each other.
async function makeSandbox(): Promise<{
  source: string;
  target: string;
  workspace: string;
}> {
  const root = await mkdtemp(join(tmpdir(), 'claw-migrate-'));
  return {
    source: join(root, 'openclaw'),
    target: join(root, 'ethos'),
    workspace: join(root, 'workspace'),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function seedMinimalOpenclaw(source: string): Promise<void> {
  await mkdir(source, { recursive: true });
  await writeFile(
    join(source, 'config.yaml'),
    'provider: anthropic\nmodel: claude-opus-4-7\napiKey: sk-test-123\npersonality: engineer\ntelegramToken: tg-token\n',
  );
  await writeFile(join(source, 'MEMORY.md'), '- prefers TypeScript\n- uses pnpm\n');
  await writeFile(join(source, 'USER.md'), '# Mitesh\nSenior engineer.\n');
}

describe('ClawMigrator.sourceExists', () => {
  it('returns false when ~/.openclaw is missing', async () => {
    const { source, target } = await makeSandbox();
    const m = new ClawMigrator({ source, target });
    expect(await m.sourceExists()).toBe(false);
  });

  it('returns true when source has config.yaml', async () => {
    const { source, target } = await makeSandbox();
    await seedMinimalOpenclaw(source);
    const m = new ClawMigrator({ source, target });
    expect(await m.sourceExists()).toBe(true);
  });
});

describe('ClawMigrator.plan', () => {
  it('detects all expected files and emits ops in dependency order', async () => {
    const { source, target, workspace } = await makeSandbox();
    await seedMinimalOpenclaw(source);
    await mkdir(join(source, 'skills', 'my-skill'), { recursive: true });
    await writeFile(
      join(source, 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\n---\nBody.\n',
    );
    await writeFile(join(source, 'SOUL.md'), '# I am a coding agent.\nI like terse code.\n');
    await writeFile(join(source, 'keys.json'), '[{"apiKey":"sk-a","priority":1}]');
    await writeFile(join(source, 'AGENTS.md'), '# AGENTS\n');

    const m = new ClawMigrator({ source, target, workspace });
    const plan = await m.plan();

    expect(plan.detected).toEqual({
      config: true,
      memory: true,
      user: true,
      soul: true,
      skills: true,
      keys: true,
      agents: true,
    });

    // Order matters per the spec: config → keys → memories → skills → soul → agents.
    expect(plan.ops.map((o) => o.kind)).toEqual([
      'config-merge',
      'file', // keys.json
      'file', // MEMORY.md
      'file', // USER.md
      'tree', // skills
      'soul-as-personality',
      'file', // AGENTS.md
    ]);

    // Personality value 'engineer' is a built-in, so it stays as-is.
    // SOUL.md is present, but config's `personality: engineer` wins because
    // engineer is a known built-in.
    expect(plan.personality.requested).toBe('engineer');
    expect(plan.personality.resolved).toBe('engineer');
    expect(plan.personality.becomesMigrated).toBe(false);

    expect(plan.summary.skills).toBe(1);
    expect(plan.summary.platformTokens).toBe(1);
  });

  it('resolves personality to "migrated" when value is custom and SOUL.md exists', async () => {
    const { source, target } = await makeSandbox();
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'config.yaml'), 'personality: my-custom-team-coder\n');
    await writeFile(join(source, 'SOUL.md'), '# Custom\n');

    const plan = await new ClawMigrator({ source, target }).plan();
    expect(plan.personality.resolved).toBe('migrated');
    expect(plan.personality.becomesMigrated).toBe(true);
  });

  it('preset "user-data" drops keys.json and apiKey from the plan', async () => {
    const { source, target } = await makeSandbox();
    await seedMinimalOpenclaw(source);
    await writeFile(join(source, 'keys.json'), '[]');

    const plan = await new ClawMigrator({ source, target, preset: 'user-data' }).plan();
    const kinds = plan.ops.map((o) => `${o.kind}:${o.label}`);
    expect(kinds.some((k) => k.includes('keys.json'))).toBe(false);
    expect(plan.summary.apiKeys).toBe(0);
  });
});

describe('ClawMigrator.execute', () => {
  it('copies a complete OpenClaw layout into ~/.ethos', async () => {
    const { source, target, workspace } = await makeSandbox();
    await seedMinimalOpenclaw(source);
    await mkdir(join(source, 'skills', 'my-skill'), { recursive: true });
    await writeFile(
      join(source, 'skills', 'my-skill', 'SKILL.md'),
      '---\nname: my-skill\n---\nBody.\n',
    );
    await writeFile(join(source, 'SOUL.md'), '# I am.\n');
    await writeFile(join(source, 'AGENTS.md'), '# AGENTS\nWorkspace instructions.\n');
    await mkdir(workspace, { recursive: true });

    const m = new ClawMigrator({ source, target, workspace });
    const plan = await m.plan();
    const result = await m.execute(plan);

    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);

    // Memory + USER + skills land verbatim
    expect(await readFile(join(target, 'MEMORY.md'), 'utf-8')).toBe(
      '- prefers TypeScript\n- uses pnpm\n',
    );
    expect(await exists(join(target, 'skills', 'openclaw-imports', 'my-skill', 'SKILL.md'))).toBe(
      true,
    );

    // SOUL.md becomes a personality dir with three files
    const personalityDir = join(target, 'personalities', 'migrated');
    expect(await exists(join(personalityDir, 'ETHOS.md'))).toBe(true);
    expect(await exists(join(personalityDir, 'config.yaml'))).toBe(true);
    expect(await exists(join(personalityDir, 'toolset.yaml'))).toBe(true);
    const ethosBody = await readFile(join(personalityDir, 'ETHOS.md'), 'utf-8');
    expect(ethosBody).toBe('# I am.\n');

    // AGENTS.md goes to workspace, not target
    expect(await exists(join(workspace, 'AGENTS.md'))).toBe(true);
    expect(await exists(join(target, 'AGENTS.md'))).toBe(false);

    // Translated config preserves provider/model/apiKey/platform tokens and
    // sets personality to the resolved value (built-in 'engineer' here).
    const cfg = await readFile(join(target, 'config.yaml'), 'utf-8');
    expect(cfg).toContain('provider: anthropic');
    expect(cfg).toContain('model: claude-opus-4-7');
    expect(cfg).toContain('apiKey: sk-test-123');
    expect(cfg).toContain('personality: engineer');
    expect(cfg).toContain('telegramToken: tg-token');
  });

  it('dry run does not write any files', async () => {
    const { source, target } = await makeSandbox();
    await seedMinimalOpenclaw(source);

    const m = new ClawMigrator({ source, target, dryRun: true });
    const plan = await m.plan();
    const result = await m.execute(plan);

    expect(result.copied).toBeGreaterThan(0);
    expect(await exists(join(target, 'MEMORY.md'))).toBe(false);
    expect(await exists(join(target, 'config.yaml'))).toBe(false);
  });

  it('skips existing destination files unless --overwrite', async () => {
    const { source, target } = await makeSandbox();
    await seedMinimalOpenclaw(source);
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'MEMORY.md'), 'PRE-EXISTING\n');
    await writeFile(join(target, 'config.yaml'), 'provider: openai\n');

    // Without --overwrite, both are skipped and pre-existing content is kept.
    const noOverwrite = new ClawMigrator({ source, target });
    const planA = await noOverwrite.plan();
    const resultA = await noOverwrite.execute(planA);
    expect(resultA.skipped).toBeGreaterThanOrEqual(2);
    expect(await readFile(join(target, 'MEMORY.md'), 'utf-8')).toBe('PRE-EXISTING\n');
    expect(await readFile(join(target, 'config.yaml'), 'utf-8')).toBe('provider: openai\n');

    // With --overwrite, both get replaced.
    const overwrite = new ClawMigrator({ source, target, overwrite: true });
    const planB = await overwrite.plan();
    const resultB = await overwrite.execute(planB);
    expect(resultB.skipped).toBe(0);
    expect(await readFile(join(target, 'MEMORY.md'), 'utf-8')).toBe(
      '- prefers TypeScript\n- uses pnpm\n',
    );
    const cfgAfter = await readFile(join(target, 'config.yaml'), 'utf-8');
    expect(cfgAfter).toContain('provider: anthropic');
  });

  it('preset "user-data" never writes apiKey to the translated config', async () => {
    const { source, target } = await makeSandbox();
    await seedMinimalOpenclaw(source);

    const m = new ClawMigrator({ source, target, preset: 'user-data' });
    const plan = await m.plan();
    await m.execute(plan);

    const cfg = await readFile(join(target, 'config.yaml'), 'utf-8');
    expect(cfg).not.toContain('apiKey');
    expect(cfg).toContain('telegramToken: tg-token'); // platform tokens still copied
  });

  it('reports failures without aborting the run', async () => {
    const { source, target } = await makeSandbox();
    await seedMinimalOpenclaw(source);

    // Pre-create a path that conflicts with one of the writes — point keys
    // file at a directory so copyFile fails on it but the rest still runs.
    await writeFile(join(source, 'keys.json'), '[]');
    await mkdir(join(target, 'keys.json'), { recursive: true });

    const m = new ClawMigrator({ source, target });
    const plan = await m.plan();
    const result = await m.execute(plan);

    expect(result.failed).toBe(1);
    expect(result.copied).toBeGreaterThan(0); // memory/user/config still copied
    const failedItem = result.items.find((i) => i.status === 'failed');
    expect(failedItem?.label).toContain('keys.json');
  });
});
