import type { IngestMode, PersonalityConfig, Skill } from '@ethosagent/types';

export interface FilterResult {
  include: boolean;
  reason: string;
}

/**
 * Decide whether a skill from the global pool should be visible to a
 * personality. Returns `{ include, reason }`.
 *
 * Mode resolution (when `skills.global_ingest.mode` is absent): `capability`.
 */
export function filterSkill(
  skill: Skill,
  personality: PersonalityConfig,
  toolNames: Set<string>,
  onWarn?: (msg: string) => void,
): FilterResult {
  const cfg = personality.skills?.global_ingest;
  const mode: IngestMode = cfg?.mode ?? 'capability';

  const allow = cfg?.allow ?? [];
  const deny = cfg?.deny ?? [];

  // Explicit deny always wins
  if (deny.includes(skill.qualifiedName)) {
    return { include: false, reason: 'explicit deny' };
  }
  // Explicit allow always wins (even in non-explicit mode)
  if (allow.includes(skill.qualifiedName)) {
    return (
      checkToolReach(skill, toolNames, onWarn, personality.id) ?? {
        include: true,
        reason: 'explicit allow',
      }
    );
  }

  switch (mode) {
    case 'none':
      return { include: false, reason: 'mode: none' };

    case 'explicit':
      return { include: false, reason: 'not in allow list (mode: explicit)' };

    case 'tags': {
      const acceptTags = cfg?.accept_tags ?? [];
      const rejectTags = cfg?.reject_tags ?? [];
      const skillTags = skill.tags ?? [];

      if (rejectTags.length > 0 && skillTags.some((t) => rejectTags.includes(t))) {
        return {
          include: false,
          reason: `tag rejected (${skillTags.filter((t) => rejectTags.includes(t)).join(', ')})`,
        };
      }
      if (acceptTags.length > 0 && !skillTags.some((t) => acceptTags.includes(t))) {
        return { include: false, reason: 'no accepted tags' };
      }
      return (
        checkToolReach(skill, toolNames, onWarn, personality.id) ?? {
          include: true,
          reason: 'tags match',
        }
      );
    }

    case 'capability':
    default:
      return capabilityCheck(
        skill,
        toolNames,
        cfg?.fallback_unknown ?? 'allow',
        onWarn,
        personality.id,
      );
  }
}

function capabilityCheck(
  skill: Skill,
  toolNames: Set<string>,
  fallback: string,
  onWarn: ((msg: string) => void) | undefined,
  personalityId: string,
): FilterResult {
  const required = skill.required_tools;

  if (!required || required.length === 0) {
    // Pure prose — no tool requirements declared
    if (fallback === 'deny') {
      return { include: false, reason: 'no required_tools declared (fallback: deny)' };
    }
    if (fallback === 'warn') {
      onWarn?.(
        `[boot] ${personalityId}: skill '${skill.qualifiedName}' has no required_tools — loading (fallback: warn)`,
      );
    }
    return { include: true, reason: 'no required_tools (pure prose)' };
  }

  const missing = required.filter((t) => !toolNames.has(t));
  if (missing.length > 0) {
    return {
      include: false,
      reason: `required_tools not in effective reach: ${missing.join(', ')}`,
    };
  }
  return { include: true, reason: 'capability match' };
}

/** When a skill is in the explicit allow list, still check tool reachability. */
function checkToolReach(
  skill: Skill,
  toolNames: Set<string>,
  onWarn: ((msg: string) => void) | undefined,
  personalityId: string,
): FilterResult | null {
  const required = skill.required_tools;
  if (!required || required.length === 0) return null;

  const missing = required.filter((t) => !toolNames.has(t));
  if (missing.length > 0) {
    onWarn?.(
      `[boot] ${personalityId}: skill '${skill.qualifiedName}' allowed but requires tool '${missing[0]}' ` +
        `which is not reachable (not in toolset; not provided by any attached MCP server or plugin) — rejecting`,
    );
    return {
      include: false,
      reason: `required_tools not reachable: ${missing.join(', ')}`,
    };
  }
  return null;
}

/**
 * Validate a personality's allow list against the global pool.
 * Emits a warning for each listed name that doesn't exist in the pool.
 */
export function warnMissingAllowList(
  personalityId: string,
  allow: string[],
  pool: Map<string, unknown>,
  onWarn: (msg: string) => void,
): void {
  for (const name of allow) {
    if (!pool.has(name)) {
      onWarn(
        `[boot] ${personalityId}: skill '${name}' referenced but not found in any source — skipping`,
      );
    }
  }
}
