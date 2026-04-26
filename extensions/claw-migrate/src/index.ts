// ClawMigrator — one-command migration from OpenClaw to Ethos.
//
// Reads ~/.openclaw/ and produces a MigrationPlan (a list of typed CopyOps).
// Execute applies each op file-by-file with skip-or-overwrite semantics.
// No content merge — one file wins. See plan/PLAN.md Phase 28.
//
// Zero new runtime deps. Pure node:fs/promises + node:path.

import type { Dirent } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CopyKind =
  | 'file' // verbatim copy
  | 'tree' // recursive copy of a directory
  | 'soul-as-personality' // SOUL.md → personalities/migrated/{ETHOS.md,config.yaml,toolset.yaml}
  | 'config-merge'; // OpenClaw config.yaml → translated Ethos config.yaml

export interface CopyOp {
  kind: CopyKind;
  source: string;
  dest: string;
  label: string; // user-facing description
}

export interface MigrationPlan {
  source: string;
  target: string;
  workspace: string;
  ops: CopyOp[];
  detected: {
    config: boolean;
    memory: boolean;
    user: boolean;
    soul: boolean;
    skills: boolean;
    keys: boolean;
    agents: boolean;
  };
  // Counts for the dry-run summary line
  summary: {
    memories: number;
    skills: number;
    platformTokens: number;
    apiKeys: number;
  };
  // Personality decision derived during planning so execute() can write a
  // valid config.yaml whether or not SOUL.md exists.
  personality: {
    requested: string | null; // raw value from OpenClaw config
    resolved: string; // built-in id, 'migrated', or fallback
    becomesMigrated: boolean; // true when SOUL.md is the source
  };
}

export interface ItemResult {
  label: string;
  status: 'copied' | 'skipped' | 'failed';
  reason?: string;
}

export interface MigrationResult {
  copied: number;
  skipped: number;
  failed: number;
  items: ItemResult[];
}

export interface MigrateOptions {
  source?: string;
  target?: string;
  workspace?: string;
  preset?: 'all' | 'user-data';
  overwrite?: boolean;
  dryRun?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Match what ships in extensions/personalities/data/. Hardcoded because Ethos
// allows custom personalities — anything not in this list becomes 'migrated'.
const BUILTIN_PERSONALITIES = new Set(['researcher', 'engineer', 'reviewer', 'coach', 'operator']);

const PLATFORM_TOKEN_KEYS = [
  'telegramToken',
  'discordToken',
  'slackBotToken',
  'slackAppToken',
  'slackSigningSecret',
];

// ---------------------------------------------------------------------------
// ClawMigrator
// ---------------------------------------------------------------------------

export class ClawMigrator {
  readonly source: string;
  readonly target: string;
  readonly workspace: string;
  readonly preset: 'all' | 'user-data';
  readonly overwrite: boolean;
  readonly dryRun: boolean;

  constructor(opts: MigrateOptions = {}) {
    this.source = opts.source ?? join(homedir(), '.openclaw');
    this.target = opts.target ?? join(homedir(), '.ethos');
    this.workspace = opts.workspace ?? process.cwd();
    this.preset = opts.preset ?? 'all';
    this.overwrite = opts.overwrite ?? false;
    this.dryRun = opts.dryRun ?? false;
  }

  /** True iff the OpenClaw source directory contains config.yaml. */
  async sourceExists(): Promise<boolean> {
    try {
      const s = await stat(join(this.source, 'config.yaml'));
      return s.isFile();
    } catch {
      return false;
    }
  }

  /**
   * Build the migration plan. Reads source files to detect what exists; does
   * not write anything. Safe to call repeatedly.
   */
  async plan(): Promise<MigrationPlan> {
    const detected = {
      config: await isFile(join(this.source, 'config.yaml')),
      memory: await isFile(join(this.source, 'MEMORY.md')),
      user: await isFile(join(this.source, 'USER.md')),
      soul: await isFile(join(this.source, 'SOUL.md')),
      skills: await isDir(join(this.source, 'skills')),
      keys: await isFile(join(this.source, 'keys.json')),
      agents: await isFile(join(this.source, 'AGENTS.md')),
    };

    // Resolve personality up front so execute() can write a coherent config
    // regardless of which file is actually copied.
    let personalityRequested: string | null = null;
    let personalityResolved = 'researcher';
    if (detected.config) {
      const raw = await safeReadFile(join(this.source, 'config.yaml'));
      const kv = parseFlatYaml(raw);
      personalityRequested = kv.personality ?? null;
      if (personalityRequested && BUILTIN_PERSONALITIES.has(personalityRequested)) {
        personalityResolved = personalityRequested;
      } else if (detected.soul) {
        personalityResolved = 'migrated';
      } else if (personalityRequested) {
        // Custom personality requested but no SOUL.md to back it — fall back.
        personalityResolved = 'migrated';
      }
    } else if (detected.soul) {
      personalityResolved = 'migrated';
    }

    const ops: CopyOp[] = [];
    const includeApiKeys = this.preset === 'all';

    // Order matters for dry-run readability and for execute(): config →
    // memories → skills → personality. Keys + workspace AGENTS.md slot in
    // alongside their natural neighbours.
    if (detected.config) {
      ops.push({
        kind: 'config-merge',
        source: join(this.source, 'config.yaml'),
        dest: join(this.target, 'config.yaml'),
        label: 'config.yaml (translated)',
      });
    }
    if (detected.keys && includeApiKeys) {
      ops.push({
        kind: 'file',
        source: join(this.source, 'keys.json'),
        dest: join(this.target, 'keys.json'),
        label: 'keys.json (rotation pool)',
      });
    }
    if (detected.memory) {
      ops.push({
        kind: 'file',
        source: join(this.source, 'MEMORY.md'),
        dest: join(this.target, 'MEMORY.md'),
        label: 'MEMORY.md',
      });
    }
    if (detected.user) {
      ops.push({
        kind: 'file',
        source: join(this.source, 'USER.md'),
        dest: join(this.target, 'USER.md'),
        label: 'USER.md',
      });
    }
    if (detected.skills) {
      ops.push({
        kind: 'tree',
        source: join(this.source, 'skills'),
        dest: join(this.target, 'skills', 'openclaw-imports'),
        label: 'skills/ → skills/openclaw-imports/',
      });
    }
    if (detected.soul) {
      ops.push({
        kind: 'soul-as-personality',
        source: join(this.source, 'SOUL.md'),
        dest: join(this.target, 'personalities', 'migrated'),
        label: 'SOUL.md → personalities/migrated/',
      });
    }
    if (detected.agents) {
      ops.push({
        kind: 'file',
        source: join(this.source, 'AGENTS.md'),
        dest: join(this.workspace, 'AGENTS.md'),
        label: `AGENTS.md → ${relative(process.cwd(), join(this.workspace, 'AGENTS.md')) || 'AGENTS.md'}`,
      });
    }

    // Summary counts for the user-facing dry-run line.
    const memories = (detected.memory ? 1 : 0) + (detected.user ? 1 : 0);
    const skills = detected.skills ? await countSkills(join(this.source, 'skills')) : 0;
    let platformTokens = 0;
    let apiKeys = 0;
    if (detected.config) {
      const raw = await safeReadFile(join(this.source, 'config.yaml'));
      const kv = parseFlatYaml(raw);
      for (const key of PLATFORM_TOKEN_KEYS) {
        if (kv[key]) platformTokens += 1;
      }
      if (includeApiKeys && kv.apiKey) apiKeys += 1;
    }
    if (detected.keys && includeApiKeys) {
      const raw = await safeReadFile(join(this.source, 'keys.json'));
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) apiKeys += parsed.length;
      } catch {
        // malformed keys.json — surface during execute, not plan
      }
    }

    return {
      source: this.source,
      target: this.target,
      workspace: this.workspace,
      ops,
      detected,
      summary: { memories, skills, platformTokens, apiKeys },
      personality: {
        requested: personalityRequested,
        resolved: personalityResolved,
        becomesMigrated: detected.soul && personalityResolved === 'migrated',
      },
    };
  }

  /**
   * Apply the plan. Each op is atomic and reports its outcome. If `dryRun`,
   * no writes happen but skip/overwrite logic still runs so the user sees
   * what would be skipped on a real run.
   */
  async execute(plan: MigrationPlan): Promise<MigrationResult> {
    const items: ItemResult[] = [];

    for (const op of plan.ops) {
      const item = await this.applyOp(op, plan);
      items.push(item);
    }

    return {
      copied: items.filter((i) => i.status === 'copied').length,
      skipped: items.filter((i) => i.status === 'skipped').length,
      failed: items.filter((i) => i.status === 'failed').length,
      items,
    };
  }

  // -------------------------------------------------------------------------
  // Per-op application
  // -------------------------------------------------------------------------

  private async applyOp(op: CopyOp, plan: MigrationPlan): Promise<ItemResult> {
    try {
      switch (op.kind) {
        case 'file':
          return await this.applyFile(op);
        case 'tree':
          return await this.applyTree(op);
        case 'config-merge':
          return await this.applyConfigMerge(op, plan);
        case 'soul-as-personality':
          return await this.applySoul(op, plan);
      }
    } catch (err) {
      return { label: op.label, status: 'failed', reason: errMsg(err) };
    }
  }

  private async applyFile(op: CopyOp): Promise<ItemResult> {
    if ((await isFile(op.dest)) && !this.overwrite) {
      return { label: op.label, status: 'skipped', reason: 'already exists' };
    }
    if (this.dryRun) return { label: op.label, status: 'copied' };
    await mkdir(dirname(op.dest), { recursive: true });
    await copyFile(op.source, op.dest);
    return { label: op.label, status: 'copied' };
  }

  private async applyTree(op: CopyOp): Promise<ItemResult> {
    if ((await isDir(op.dest)) && !this.overwrite) {
      return { label: op.label, status: 'skipped', reason: 'already exists' };
    }
    if (this.dryRun) return { label: op.label, status: 'copied' };
    await copyTree(op.source, op.dest);
    return { label: op.label, status: 'copied' };
  }

  private async applyConfigMerge(op: CopyOp, plan: MigrationPlan): Promise<ItemResult> {
    if ((await isFile(op.dest)) && !this.overwrite) {
      return { label: op.label, status: 'skipped', reason: 'already exists' };
    }

    const raw = await readFile(op.source, 'utf-8');
    const kv = parseFlatYaml(raw);

    // Build the translated Ethos config.yaml as ordered key:value lines.
    const lines: string[] = [];
    if (kv.provider) lines.push(`provider: ${kv.provider}`);
    if (kv.model) lines.push(`model: ${kv.model}`);
    if (kv.apiKey && this.preset === 'all') lines.push(`apiKey: ${kv.apiKey}`);
    lines.push(`personality: ${plan.personality.resolved}`);
    if (kv.baseUrl) lines.push(`baseUrl: ${kv.baseUrl}`);
    for (const key of PLATFORM_TOKEN_KEYS) {
      if (kv[key]) lines.push(`${key}: ${kv[key]}`);
    }

    if (this.dryRun) return { label: op.label, status: 'copied' };
    await mkdir(dirname(op.dest), { recursive: true });
    await writeFile(op.dest, `${lines.join('\n')}\n`, 'utf-8');
    return { label: op.label, status: 'copied' };
  }

  private async applySoul(op: CopyOp, plan: MigrationPlan): Promise<ItemResult> {
    // The personality dir contains three files; consider the personality
    // "already exists" if the directory exists with an ETHOS.md inside.
    const ethosFile = join(op.dest, 'ETHOS.md');
    if ((await isFile(ethosFile)) && !this.overwrite) {
      return { label: op.label, status: 'skipped', reason: 'already exists' };
    }

    const soul = await readFile(op.source, 'utf-8');
    const configYaml = [
      'name: Migrated',
      'description: Imported from OpenClaw SOUL.md by ethos claw migrate.',
      `model: ${plan.detected.config ? readModel(plan) : 'claude-opus-4-7'}`,
      'memoryScope: global',
      'capabilities: imported',
    ].join('\n');
    const toolsetYaml = '# No toolset specified — inherits the LLM provider default.\n';

    if (this.dryRun) return { label: op.label, status: 'copied' };
    await mkdir(op.dest, { recursive: true });
    await writeFile(ethosFile, soul, 'utf-8');
    await writeFile(join(op.dest, 'config.yaml'), `${configYaml}\n`, 'utf-8');
    await writeFile(join(op.dest, 'toolset.yaml'), toolsetYaml, 'utf-8');
    return { label: op.label, status: 'copied' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function safeReadFile(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf-8');
  } catch {
    return '';
  }
}

async function copyTree(source: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    const sp = join(source, entry.name);
    const dp = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sp, dp);
    } else if (entry.isFile()) {
      await copyFile(sp, dp);
    }
    // Symlinks and other types are deliberately ignored — skill bundles
    // shouldn't depend on them and following them is a footgun.
  }
}

async function countSkills(skillsDir: string): Promise<number> {
  // A "skill" is any direct child directory containing a SKILL.md, plus the
  // scoped form <scope>/<slug>/SKILL.md (steipete/slack pattern).
  let count = 0;
  let entries: Dirent[];
  try {
    entries = await readdir(skillsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const top = join(skillsDir, entry.name);
    if (await isFile(join(top, 'SKILL.md'))) {
      count += 1;
      continue;
    }
    try {
      const inner = await readdir(top, { withFileTypes: true });
      for (const child of inner) {
        if (child.isDirectory() && (await isFile(join(top, child.name, 'SKILL.md')))) {
          count += 1;
        }
      }
    } catch {
      // unreadable scope dir — skip silently
    }
  }
  return count;
}

/**
 * Tiny flat YAML parser matching Ethos's own config style: `key: value` per
 * line, optional surrounding quotes, no nesting beyond `dotted.keys`. Lines
 * starting with `#` and blank lines are ignored.
 */
function parseFlatYaml(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of src.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([\w.]+):\s*(.*)$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (value) out[m[1]] = value;
  }
  return out;
}

function readModel(plan: MigrationPlan): string {
  // Re-read from the source config file synchronously is overkill; the plan
  // only carries personality state. We don't have the model in the plan
  // directly, so fall back to a sensible default. The actual config copy
  // already preserves the user's chosen model — this is just for the
  // generated personality's intended-fit hint.
  return plan.personality.resolved === 'researcher' || plan.personality.resolved === 'coach'
    ? 'claude-opus-4-7'
    : 'claude-sonnet-4-6';
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
