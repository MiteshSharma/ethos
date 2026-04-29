// ClawMigrator — one-command migration from OpenClaw to Ethos.
//
// Reads ~/.openclaw/ and produces a MigrationPlan (a list of typed CopyOps).
// Execute applies each op file-by-file with skip-or-overwrite semantics.
// No content merge — one file wins. See plan/PLAN.md Phase 28.
//
// Reads/writes route through @ethosagent/storage-fs. Raw `copyFile` is kept
// for binary-safe tree copies — Storage doesn't model byte streams.

import { copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Storage } from '@ethosagent/types';

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
  /** Storage backend for plan inspection + write ops. Defaults to FsStorage. */
  storage?: Storage;
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
  private readonly storage: Storage;

  constructor(opts: MigrateOptions = {}) {
    this.source = opts.source ?? join(homedir(), '.openclaw');
    this.target = opts.target ?? join(homedir(), '.ethos');
    this.workspace = opts.workspace ?? process.cwd();
    this.preset = opts.preset ?? 'all';
    this.overwrite = opts.overwrite ?? false;
    this.dryRun = opts.dryRun ?? false;
    this.storage = opts.storage ?? new FsStorage();
  }

  /** True iff the OpenClaw source directory contains config.yaml. */
  async sourceExists(): Promise<boolean> {
    return this.storage.exists(join(this.source, 'config.yaml'));
  }

  /**
   * Build the migration plan. Reads source files to detect what exists; does
   * not write anything. Safe to call repeatedly.
   */
  async plan(): Promise<MigrationPlan> {
    const detected = {
      config: await this.storage.exists(join(this.source, 'config.yaml')),
      memory: await this.storage.exists(join(this.source, 'MEMORY.md')),
      user: await this.storage.exists(join(this.source, 'USER.md')),
      soul: await this.storage.exists(join(this.source, 'SOUL.md')),
      skills: await this.storage.exists(join(this.source, 'skills')),
      keys: await this.storage.exists(join(this.source, 'keys.json')),
      agents: await this.storage.exists(join(this.source, 'AGENTS.md')),
    };

    // Resolve personality up front so execute() can write a coherent config
    // regardless of which file is actually copied.
    let personalityRequested: string | null = null;
    let personalityResolved = 'researcher';
    if (detected.config) {
      const raw = (await this.storage.read(join(this.source, 'config.yaml'))) ?? '';
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
    const skills = detected.skills
      ? await countSkills(this.storage, join(this.source, 'skills'))
      : 0;
    let platformTokens = 0;
    let apiKeys = 0;
    if (detected.config) {
      const raw = (await this.storage.read(join(this.source, 'config.yaml'))) ?? '';
      const kv = parseFlatYaml(raw);
      for (const key of PLATFORM_TOKEN_KEYS) {
        if (kv[key]) platformTokens += 1;
      }
      if (includeApiKeys && kv.apiKey) apiKeys += 1;
    }
    if (detected.keys && includeApiKeys) {
      const raw = (await this.storage.read(join(this.source, 'keys.json'))) ?? '';
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
    if ((await isFileLike(this.storage, op.dest)) && !this.overwrite) {
      return { label: op.label, status: 'skipped', reason: 'already exists' };
    }
    if (this.dryRun) return { label: op.label, status: 'copied' };
    await this.storage.mkdir(dirname(op.dest));
    // Raw copyFile preserves bytes — Storage doesn't model byte streams.
    await copyFile(op.source, op.dest);
    return { label: op.label, status: 'copied' };
  }

  private async applyTree(op: CopyOp): Promise<ItemResult> {
    if ((await isDirLike(this.storage, op.dest)) && !this.overwrite) {
      return { label: op.label, status: 'skipped', reason: 'already exists' };
    }
    if (this.dryRun) return { label: op.label, status: 'copied' };
    await copyTree(this.storage, op.source, op.dest);
    return { label: op.label, status: 'copied' };
  }

  private async applyConfigMerge(op: CopyOp, plan: MigrationPlan): Promise<ItemResult> {
    if ((await isFileLike(this.storage, op.dest)) && !this.overwrite) {
      return { label: op.label, status: 'skipped', reason: 'already exists' };
    }

    const raw = (await this.storage.read(op.source)) ?? '';
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
    await this.storage.mkdir(dirname(op.dest));
    await this.storage.write(op.dest, `${lines.join('\n')}\n`);
    return { label: op.label, status: 'copied' };
  }

  private async applySoul(op: CopyOp, plan: MigrationPlan): Promise<ItemResult> {
    // The personality dir contains three files; consider the personality
    // "already exists" if the directory exists with an ETHOS.md inside.
    const ethosFile = join(op.dest, 'ETHOS.md');
    if ((await isFileLike(this.storage, ethosFile)) && !this.overwrite) {
      return { label: op.label, status: 'skipped', reason: 'already exists' };
    }

    const soul = (await this.storage.read(op.source)) ?? '';
    const configYaml = [
      'name: Migrated',
      'description: Imported from OpenClaw SOUL.md by ethos claw migrate.',
      `model: ${plan.detected.config ? readModel(plan) : 'claude-opus-4-7'}`,
      'memoryScope: global',
      'capabilities: imported',
    ].join('\n');
    const toolsetYaml = '# No toolset specified — inherits the LLM provider default.\n';

    if (this.dryRun) return { label: op.label, status: 'copied' };
    await this.storage.mkdir(op.dest);
    await this.storage.write(ethosFile, soul);
    await this.storage.write(join(op.dest, 'config.yaml'), `${configYaml}\n`);
    await this.storage.write(join(op.dest, 'toolset.yaml'), toolsetYaml);
    return { label: op.label, status: 'copied' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function isFileLike(storage: Storage, path: string): Promise<boolean> {
  // Storage.exists() can't distinguish file from directory, so check the
  // parent listing. Cheap for a one-shot migration; not for hot loops.
  const entries = await storage.listEntries(dirname(path));
  return entries.some((e) => e.name === basename(path) && !e.isDir);
}

async function isDirLike(storage: Storage, path: string): Promise<boolean> {
  const entries = await storage.listEntries(dirname(path));
  return entries.some((e) => e.name === basename(path) && e.isDir);
}

async function copyTree(storage: Storage, source: string, dest: string): Promise<void> {
  await storage.mkdir(dest);
  const entries = await storage.listEntries(source);
  for (const entry of entries) {
    const sp = join(source, entry.name);
    const dp = join(dest, entry.name);
    if (entry.isDir) {
      await copyTree(storage, sp, dp);
    } else {
      await copyFile(sp, dp);
    }
    // Symlinks and other types are deliberately ignored — skill bundles
    // shouldn't depend on them and following them is a footgun.
  }
}

async function countSkills(storage: Storage, skillsDir: string): Promise<number> {
  // A "skill" is any direct child directory containing a SKILL.md, plus the
  // scoped form <scope>/<slug>/SKILL.md (steipete/slack pattern).
  let count = 0;
  const entries = await storage.listEntries(skillsDir);
  for (const entry of entries) {
    if (!entry.isDir) continue;
    const top = join(skillsDir, entry.name);
    if (await storage.exists(join(top, 'SKILL.md'))) {
      count += 1;
      continue;
    }
    const inner = await storage.listEntries(top);
    for (const child of inner) {
      if (child.isDir && (await storage.exists(join(top, child.name, 'SKILL.md')))) {
        count += 1;
      }
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
