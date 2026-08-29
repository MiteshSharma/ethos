// @ethosagent/constitution — loader + enforcer for the operator constitution.
//
// The constitution is the host operator's ceiling over every personality. It
// is loaded from `~/.ethos/constitution.yaml` and enforced at wiring time.
//
// Failure modes and the SAFE MODE recovery path are documented in the runbook:
//   docs/content/using/how-to/safe-mode.md
//
// Layering: this extension imports `@ethosagent/types` only. The `substitute`
// helper is REPLICATED locally (mirrors core's scoped-storage helper) rather
// than imported, to keep the types ← core ← extensions direction clean.

import { join } from 'node:path';
import {
  type Constitution,
  type ConstitutionClamp,
  type ConstitutionEnforcement,
  type ConstitutionLoadResult,
  ConstitutionViolationError,
  type Logger,
  PERMISSIVE_DEFAULT_CONSTITUTION,
  type PersonalityConfig,
  type Storage,
} from '@ethosagent/types';
import { parse } from 'yaml';

// Re-exported for convenience so consumers import the error class and the
// permissive default from this package alongside the loader/enforcer.
export { ConstitutionViolationError, PERMISSIVE_DEFAULT_CONSTITUTION } from '@ethosagent/types';

/**
 * Resolve `${ETHOS_HOME}`, `${self}`, and `${CWD}` placeholders. Mirrors the
 * helper in `packages/core/src/agent-loop/scoped-storage.ts` (replicated, not
 * imported, to respect the layer model).
 */
function substitute(
  template: string,
  vars: { ethosHome: string; self: string; cwd: string },
): string {
  return template
    .replace(/\$\{ETHOS_HOME\}/g, vars.ethosHome)
    .replace(/\$\{self\}/g, vars.self)
    .replace(/\$\{CWD\}/g, vars.cwd);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

/**
 * Validate a parsed YAML mapping into a `Constitution`, field-by-field. No
 * `as` cast asserts the output shape — we only read keys off an
 * already-checked object view. Returns `{ error }` on the first malformed
 * field.
 */
function validateConstitution(obj: object): Constitution | { error: string } {
  const o = obj as Record<string, unknown>;
  const result: Constitution = {};

  if (o.budget !== undefined) {
    if (!isPlainObject(o.budget)) return { error: 'budget must be a mapping' };
    const budget: Constitution['budget'] = {};
    const max = o.budget.maxUsdPerSession;
    if (max !== undefined) {
      if (typeof max !== 'number' || !Number.isFinite(max)) {
        return { error: 'budget.maxUsdPerSession must be a finite number' };
      }
      budget.maxUsdPerSession = max;
    }
    result.budget = budget;
  }

  if (o.forbidden !== undefined) {
    if (!isPlainObject(o.forbidden)) return { error: 'forbidden must be a mapping' };
    const forbidden: Constitution['forbidden'] = {};
    if (o.forbidden.hosts !== undefined) {
      if (!isStringArray(o.forbidden.hosts)) {
        return { error: 'forbidden.hosts must be an array of strings' };
      }
      forbidden.hosts = o.forbidden.hosts;
    }
    if (o.forbidden.tools !== undefined) {
      if (!isStringArray(o.forbidden.tools)) {
        return { error: 'forbidden.tools must be an array of strings' };
      }
      forbidden.tools = o.forbidden.tools;
    }
    result.forbidden = forbidden;
  }

  if (o.observability !== undefined) {
    if (!isPlainObject(o.observability)) return { error: 'observability must be a mapping' };
    const observability: Constitution['observability'] = {};
    const min = o.observability.minimum;
    if (min !== undefined) {
      if (min !== 'none' && min !== 'redacted' && min !== 'full') {
        return { error: "observability.minimum must be 'none', 'redacted', or 'full'" };
      }
      observability.minimum = min;
    }
    result.observability = observability;
  }

  if (o.filesystem !== undefined) {
    if (!isPlainObject(o.filesystem)) return { error: 'filesystem must be a mapping' };
    const filesystem: Constitution['filesystem'] = {};
    if (o.filesystem.allowedMountRoots !== undefined) {
      if (!isStringArray(o.filesystem.allowedMountRoots)) {
        return { error: 'filesystem.allowedMountRoots must be an array of strings' };
      }
      filesystem.allowedMountRoots = o.filesystem.allowedMountRoots;
    }
    if (o.filesystem.deniedPathPrefixes !== undefined) {
      if (!isStringArray(o.filesystem.deniedPathPrefixes)) {
        return { error: 'filesystem.deniedPathPrefixes must be an array of strings' };
      }
      filesystem.deniedPathPrefixes = o.filesystem.deniedPathPrefixes;
    }
    result.filesystem = filesystem;
  }

  if (o.execution !== undefined) {
    if (!isPlainObject(o.execution)) return { error: 'execution must be a mapping' };
    const execution: Constitution['execution'] = {};
    if (o.execution.requireSandbox !== undefined) {
      if (typeof o.execution.requireSandbox !== 'boolean') {
        return { error: 'execution.requireSandbox must be a boolean' };
      }
      execution.requireSandbox = o.execution.requireSandbox;
    }
    if (o.execution.forbidLocal !== undefined) {
      if (typeof o.execution.forbidLocal !== 'boolean') {
        return { error: 'execution.forbidLocal must be a boolean' };
      }
      execution.forbidLocal = o.execution.forbidLocal;
    }
    result.execution = execution;
  }

  return result;
}

export async function loadConstitution(
  storage: Storage,
  ethosHome: string,
): Promise<ConstitutionLoadResult> {
  const path = join(ethosHome, 'constitution.yaml');
  const raw = await storage.read(path);
  if (raw == null) {
    return { status: 'missing', constitution: PERMISSIVE_DEFAULT_CONSTITUTION };
  }

  let parsed: unknown;
  try {
    parsed = parse(raw);
  } catch (err) {
    return { status: 'malformed', error: err instanceof Error ? err.message : String(err) };
  }

  // An empty YAML document parses to null/undefined — valid-empty constitution.
  if (parsed == null) return { status: 'loaded', constitution: {} };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 'malformed', error: 'constitution must be a YAML mapping' };
  }

  const validated = validateConstitution(parsed);
  if ('error' in validated) return { status: 'malformed', error: validated.error };
  return { status: 'loaded', constitution: validated };
}

export interface EnforceArgs {
  constitution: Constitution;
  personalities: PersonalityConfig[];
  ethosHome: string;
  workingDir: string;
  log: Logger;
}

/**
 * Enforce the constitution over a set of personalities. For each personality,
 * checks run in a deterministic order:
 *   1. hard-fail checks — forbidden tools, A5 network, A4 posture, A2 fs_reach
 *      bounds, deniedPathPrefixes — throwing `ConstitutionViolationError` on the
 *      FIRST violation. A forbidden personality aborts the whole run; it must
 *      not load.
 *   2. budget clamp — the operator ceiling is authoritative; when a personality
 *      has no cap, the ceiling becomes its effective cap.
 *
 * Budget clamps mutate the live `PersonalityConfig` (the registry returns live
 * references), so the clamp is observed by everything downstream.
 */
export function enforceConstitution(args: EnforceArgs): { enforcement: ConstitutionEnforcement } {
  const clamps: ConstitutionClamp[] = [];
  const vars = (self: string) => ({
    ethosHome: args.ethosHome,
    self,
    cwd: args.workingDir,
  });

  for (const p of args.personalities) {
    // (1a) forbidden tools
    const forbiddenTools = args.constitution.forbidden?.tools ?? [];
    if (forbiddenTools.length > 0) {
      for (const name of p.toolset ?? []) {
        if (forbiddenTools.includes(name)) {
          throw new ConstitutionViolationError(p.id, `declares forbidden tool "${name}"`);
        }
      }
    }

    // (1b) A5 network — deny-all means an explicit allowlist with zero hosts.
    const forbiddenHosts = args.constitution.forbidden?.hosts ?? [];
    if (forbiddenHosts.length > 0) {
      const allow = p.safety?.network?.allow;
      const isDenyAll = Array.isArray(allow) && allow.length === 0;
      if (!isDenyAll) {
        throw new ConstitutionViolationError(
          p.id,
          'network is allow-all but constitution forbids hosts (deny-all network required)',
        );
      }
      for (const host of allow ?? []) {
        if (forbiddenHosts.includes(host)) {
          throw new ConstitutionViolationError(
            p.id,
            `network allowlist includes forbidden host "${host}"`,
          );
        }
      }
    }

    // (1c) A4 posture — `execution` is an untyped field on personality.
    const posture = (p as { execution?: string }).execution;
    if (
      (args.constitution.execution?.requireSandbox === true ||
        args.constitution.execution?.forbidLocal === true) &&
      posture === 'local'
    ) {
      throw new ConstitutionViolationError(
        p.id,
        'declares execution: local but the constitution forbids the local posture',
      );
    }

    // (1d) A2 fs_reach within allowedMountRoots. workdir counts: it is injected
    // into both derived reach lists, so an unbounded workdir is unbounded reach.
    const reachPaths = [
      ...(p.fs_reach?.read ?? []),
      ...(p.fs_reach?.write ?? []),
      ...(p.fs_reach?.workdir ? [p.fs_reach.workdir] : []),
    ];
    if (
      reachPaths.length > 0 &&
      !isReachWithinAllowedRoots(reachPaths, args.constitution, vars(p.id))
    ) {
      throw new ConstitutionViolationError(p.id, 'fs_reach escapes allowedMountRoots');
    }

    // (1e) deniedPathPrefixes — layers ON TOP of the built-in docker mount
    // denylist (extensions/execution-docker FORBIDDEN_MOUNT_ROOTS); it does not
    // replace it.
    const denied = args.constitution.filesystem?.deniedPathPrefixes ?? [];
    if (denied.length > 0) {
      const subDenied = denied.map((d) => substitute(d, vars(p.id)));
      for (const rp of reachPaths) {
        const sp = substitute(rp, vars(p.id));
        for (const prefix of subDenied) {
          if (sp === prefix || sp.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) {
            throw new ConstitutionViolationError(
              p.id,
              `fs_reach path "${sp}" is under denied prefix "${prefix}"`,
            );
          }
        }
      }
    }

    // (2) budget clamp — ceiling is operator-authoritative; with no cap set the
    // ceiling becomes the effective cap.
    const ceiling = args.constitution.budget?.maxUsdPerSession;
    if (ceiling != null) {
      if (p.budgetCapUsd == null) {
        p.budgetCapUsd = ceiling;
        clamps.push({
          personalityId: p.id,
          field: 'budgetCapUsd',
          declared: ceiling,
          clamped: ceiling,
        });
        args.log.warn(
          `Constitution applied budget ceiling $${ceiling} to personality "${p.id}" (had no cap)`,
        );
      } else if (p.budgetCapUsd > ceiling) {
        const declared = p.budgetCapUsd;
        p.budgetCapUsd = ceiling;
        clamps.push({ personalityId: p.id, field: 'budgetCapUsd', declared, clamped: ceiling });
        args.log.warn(
          `Constitution clamped personality "${p.id}" budgetCapUsd from $${declared} to $${ceiling}`,
        );
      }
    }
  }

  return { enforcement: { clamps } };
}

export const SAFE_MODE_READONLY_TOOLS = [
  'read_file',
  'search_files',
  'memory_read',
  'session_search',
  'web_search',
  'web_extract',
  'web_crawl',
  'kanban_show',
  'kanban_list',
  'team_memory_read',
  'team_memory_search',
  'think_deeper',
] as const;

// mirrors extensions/personalities/data/ dir names
export const BUILTIN_PERSONALITY_IDS: ReadonlySet<string> = new Set([
  'archived',
  'debug',
  'engineer',
  'personality-architect',
  'researcher',
  'reviewer',
  'team-architect',
]);

/**
 * SAFE MODE: keep only built-in personalities, and strip their toolsets down to
 * the read-only allowlist. Surviving objects are mutated in place.
 */
export function applySafeMode(
  personalities: PersonalityConfig[],
  builtinIds: ReadonlySet<string>,
): PersonalityConfig[] {
  const readonly = new Set<string>(SAFE_MODE_READONLY_TOOLS);
  const survivors = personalities.filter((p) => builtinIds.has(p.id));
  for (const p of survivors) {
    p.toolset = (p.toolset ?? []).filter((t) => readonly.has(t));
  }
  return survivors;
}

/**
 * True when every fs_reach path resolves under at least one allowed mount root.
 * When no roots are configured, the bound is permissive (returns true).
 */
export function isReachWithinAllowedRoots(
  reachPaths: string[],
  constitution: Constitution,
  vars: { ethosHome: string; self: string; cwd: string },
): boolean {
  const roots = constitution.filesystem?.allowedMountRoots ?? [];
  if (roots.length === 0) return true;
  const subRoots = roots.map((r) => substitute(r, vars));
  for (const rp of reachPaths) {
    const p = substitute(rp, vars);
    const ok = subRoots.some(
      (root) => p === root || p.startsWith(root.endsWith('/') ? root : `${root}/`),
    );
    if (!ok) return false;
  }
  return true;
}
