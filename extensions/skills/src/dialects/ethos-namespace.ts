// Shared parsers for the `ethos:` frontmatter namespace. The dialect
// modules (agentskills / openclaw / hermes) call these so the namespace
// shape is identical regardless of which top-level dialect produced the
// rest of the frontmatter.

import type { SkillEnvRef, SkillPermissions } from '@ethosagent/types';

function getEthosBlock(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const ethos = data.ethos;
  if (typeof ethos !== 'object' || ethos === null || Array.isArray(ethos)) return undefined;
  return ethos as Record<string, unknown>;
}

export function parseEthosPermissions(data: Record<string, unknown>): SkillPermissions | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  const perms = ethos.permissions;
  if (typeof perms !== 'object' || perms === null || Array.isArray(perms)) return undefined;
  const p = perms as Record<string, unknown>;
  const result: SkillPermissions = {};
  if (Array.isArray(p.fs_read))
    result.fs_read = p.fs_read.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(p.fs_write))
    result.fs_write = p.fs_write.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(p.network))
    result.network = p.network.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(p.tools_required))
    result.tools_required = p.tools_required.filter((x): x is string => typeof x === 'string');
  if (Array.isArray(p.mcp_env_passthrough))
    result.mcp_env_passthrough = p.mcp_env_passthrough.filter(
      (x): x is string => typeof x === 'string',
    );
  return Object.keys(result).length > 0 ? result : undefined;
}

export function parseEthosFallbackForTools(data: Record<string, unknown>): string[] | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  const raw = ethos.fallback_for_tools;
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((x): x is string => typeof x === 'string');
  return list.length > 0 ? list : undefined;
}

/**
 * Renderer capability grammar: `<renderer-name>@<spec-version>`, where the
 * version is an INTEGER. Semver is rejected on purpose — a spec version names
 * a documented subset, not a package (see `Skill.renders`).
 */
const RENDERER_SPEC_RE = /^[a-z][a-z0-9-]*@\d+$/;

/**
 * Parse `ethos.renders` — the renderer capabilities a skill declares:
 *   ethos:
 *     renders: ['echarts@1']
 *
 * Entries that are not strings, or that do not match the grammar, are dropped
 * silently (the namespace's lenient posture). Returns undefined when nothing
 * survives, so consumers never see an empty array.
 */
export function parseEthosRenders(data: Record<string, unknown>): string[] | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  const raw = ethos.renders;
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((x): x is string => typeof x === 'string' && RENDERER_SPEC_RE.test(x));
  return list.length > 0 ? list : undefined;
}

function parseEnvRefList(raw: unknown): SkillEnvRef[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: SkillEnvRef[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      out.push({ name: item });
    } else if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
      const obj = item as Record<string, unknown>;
      const name = obj.name;
      if (typeof name !== 'string' || name.length === 0) continue;
      const description = typeof obj.description === 'string' ? obj.description : undefined;
      out.push(description !== undefined ? { name, description } : { name });
    }
  }
  return out.length > 0 ? out : undefined;
}

export function parseEthosEnvRequired(data: Record<string, unknown>): SkillEnvRef[] | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  return parseEnvRefList(ethos.env_required);
}

export function parseEthosEnvOptional(data: Record<string, unknown>): SkillEnvRef[] | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  return parseEnvRefList(ethos.env_optional);
}

export function parseEthosExternalCliAlternatives(
  data: Record<string, unknown>,
): string[] | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  const raw = ethos.external_cli_alternatives;
  if (!Array.isArray(raw)) return undefined;
  const list = raw.filter((x): x is string => typeof x === 'string');
  return list.length > 0 ? list : undefined;
}

/**
 * Gap 11 — parse `ethos.requires` from frontmatter. Accepts:
 *   ethos:
 *     requires:
 *       env: [OPENAI_API_KEY]
 *       tools: [bash, read_file]
 *       os: [linux, darwin]
 */
export function parseEthosRequires(
  data: Record<string, unknown>,
): { env?: string[]; tools?: string[]; os?: ('linux' | 'darwin' | 'win32')[] } | undefined {
  const ethos = getEthosBlock(data);
  if (!ethos) return undefined;
  const req = ethos.requires;
  if (typeof req !== 'object' || req === null || Array.isArray(req)) return undefined;
  const r = req as Record<string, unknown>;
  const result: { env?: string[]; tools?: string[]; os?: ('linux' | 'darwin' | 'win32')[] } = {};
  if (Array.isArray(r.env)) {
    const list = r.env.filter((x): x is string => typeof x === 'string');
    if (list.length > 0) result.env = list;
  }
  if (Array.isArray(r.tools)) {
    const list = r.tools.filter((x): x is string => typeof x === 'string');
    if (list.length > 0) result.tools = list;
  }
  if (Array.isArray(r.os)) {
    const valid = new Set<string>(['linux', 'darwin', 'win32']);
    const list = r.os
      .filter((x): x is string => typeof x === 'string')
      .filter((x) => valid.has(x)) as ('linux' | 'darwin' | 'win32')[];
    if (list.length > 0) result.os = list;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}
