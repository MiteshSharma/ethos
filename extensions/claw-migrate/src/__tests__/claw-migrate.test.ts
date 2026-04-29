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
      cron: false,
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

// ---------------------------------------------------------------------------
// Phase 3.2 — cron/jobs.json migration with personality backfill
// ---------------------------------------------------------------------------

describe('ClawMigrator cron migration (Phase 3.2)', () => {
  it('detects cron/jobs.json and emits a cron-migrate op', async () => {
    const { source, target, workspace } = await makeSandbox();
    await seedMinimalOpenclaw(source);
    await mkdir(join(source, 'cron'), { recursive: true });
    await writeFile(join(source, 'cron', 'jobs.json'), JSON.stringify([]));

    const m = new ClawMigrator({ source, target, workspace });
    const plan = await m.plan();

    expect(plan.detected.cron).toBe(true);
    const cronOp = plan.ops.find((op) => op.kind === 'cron-migrate');
    expect(cronOp).toBeDefined();
    expect(cronOp?.label).toContain('jobs.json');
  });

  it('does not emit a cron-migrate op when cron/jobs.json is absent', async () => {
    const { source, target, workspace } = await makeSandbox();
    await seedMinimalOpenclaw(source);

    const m = new ClawMigrator({ source, target, workspace });
    const plan = await m.plan();

    expect(plan.detected.cron).toBe(false);
    expect(plan.ops.find((op) => op.kind === 'cron-migrate')).toBeUndefined();
  });

  it('backfills personality from resolved OpenClaw config on jobs that lack it', async () => {
    const { source, target, workspace } = await makeSandbox();
    // config.yaml has personality: engineer (a built-in → resolves to 'engineer')
    await seedMinimalOpenclaw(source);
    const jobs = [
      { id: 'j1', name: 'daily', schedule: '0 9 * * *', prompt: 'Summarize.', status: 'active', missedRunPolicy: 'skip', createdAt: '2026-01-01T00:00:00.000Z' },
      { id: 'j2', name: 'weekly', schedule: '0 8 * * 1', prompt: 'Report.', personality: 'researcher', status: 'active', missedRunPolicy: 'skip', createdAt: '2026-01-02T00:00:00.000Z' },
    ];
    await mkdir(join(source, 'cron'), { recursive: true });
    await writeFile(join(source, 'cron', 'jobs.json'), JSON.stringify(jobs));

    const m = new ClawMigrator({ source, target, workspace });
    const plan = await m.plan();
    await m.execute(plan);

    const raw = await readFile(join(target, 'cron', 'jobs.json'), 'utf-8');
    const migrated = JSON.parse(raw) as Array<{ id: string; personality: string }>;

    // j1 had no personality → backfilled from the resolved plan personality
    expect(migrated.find((j) => j.id === 'j1')?.personality).toBe('engineer');
    // j2 already had personality: researcher → preserved unchanged
    expect(migrated.find((j) => j.id === 'j2')?.personality).toBe('researcher');
  });

  it('falls back to resolved personality when OpenClaw config has no personality field', async () => {
    const { source, target, workspace } = await makeSandbox();
    // Config without personality field → plan resolves to 'researcher' (default)
    await mkdir(source, { recursive: true });
    await writeFile(join(source, 'config.yaml'), 'provider: anthropic\nmodel: claude-opus-4-7\n');
    const jobs = [
      { id: 'j1', name: 'task', schedule: '0 9 * * *', prompt: 'Do it.', status: 'active', missedRunPolicy: 'skip', createdAt: '2026-01-01T00:00:00.000Z' },
    ];
    await mkdir(join(source, 'cron'), { recursive: true });
    await writeFile(join(source, 'cron', 'jobs.json'), JSON.stringify(jobs));

    const m = new ClawMigrator({ source, target, workspace });
    const plan = await m.plan();
    await m.execute(plan);

    const raw = await readFile(join(target, 'cron', 'jobs.json'), 'utf-8');
    const migrated = JSON.parse(raw) as Array<{ personality: string }>;
    expect(migrated[0]?.personality).toBe('researcher');
  });

  it('skips cron migration when dest already exists and overwrite is false', async () => {
    const { source, target, workspace } = await makeSandbox();
    await seedMinimalOpenclaw(source);
    const jobs = [{ id: 'j1', name: 'daily', schedule: '0 9 * * *', prompt: 'X.', status: 'active', missedRunPolicy: 'skip', createdAt: '2026-01-01T00:00:00.000Z' }];
    await mkdir(join(source, 'cron'), { recursive: true });
    await writeFile(join(source, 'cron', 'jobs.json'), JSON.stringify(jobs));

    // Pre-create target cron/jobs.json with existing data
    await mkdir(join(target, 'cron'), { recursive: true });
    await writeFile(join(target, 'cron', 'jobs.json'), '[]');

    const m = new ClawMigrator({ source, target, workspace, overwrite: false });
    const plan = await m.plan();
    const result = await m.execute(plan);

    const skipped = result.items.find((i) => i.label.includes('jobs.json'));
    expect(skipped?.status).toBe('skipped');
    // Target still has the original content (not overwritten)
    const raw = await readFile(join(target, 'cron', 'jobs.json'), 'utf-8');
    expect(JSON.parse(raw)).toEqual([]);
  });

  it('dry run reports copied but writes nothing', async () => {
    const { source, target, workspace } = await makeSandbox();
    await seedMinimalOpenclaw(source);
    const jobs = [{ id: 'j1', name: 'daily', schedule: '0 9 * * *', prompt: 'X.', status: 'active', missedRunPolicy: 'skip', createdAt: '2026-01-01T00:00:00.000Z' }];
    await mkdir(join(source, 'cron'), { recursive: true });
    await writeFile(join(source, 'cron', 'jobs.json'), JSON.stringify(jobs));

    const m = new ClawMigrator({ source, target, workspace, dryRun: true });
    const plan = await m.plan();
    const result = await m.execute(plan);

    const cronItem = result.items.find((i) => i.label.includes('jobs.json'));
    expect(cronItem?.status).toBe('copied');
    // Nothing was actually written
    expect(await exists(join(target, 'cron', 'jobs.json'))).toBe(false);
  });
});
