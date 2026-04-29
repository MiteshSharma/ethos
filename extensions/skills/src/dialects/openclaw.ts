import type { Skill } from '@ethosagent/types';
import matter from 'gray-matter';

const META_KEYS = ['openclaw', 'clawdbot', 'clawdis'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Detect OpenClaw format: `metadata.{openclaw|clawdbot|clawdis}` block present. */
export function canParse(data: Record<string, unknown>): boolean {
  if (!isRecord(data.metadata)) return false;
  return META_KEYS.some((k) => isRecord((data.metadata as Record<string, unknown>)[k]));
}

/**
 * Parse an OpenClaw / ClawHub skill file.
 * Returns null if the content is empty or the OpenClaw block is absent.
 */
export function parseOpenClaw(
  raw: string,
  filePath: string,
  source: string,
  name: string,
  mtimeMs: number,
): Omit<Skill, 'qualifiedName'> | null {
  const { data, content } = matter(raw);
  if (Object.keys(data).length === 0) return null;

  const displayName = typeof data.name === 'string' ? data.name : (name as string);

  const tags = Array.isArray(data.tags)
    ? data.tags.filter((t): t is string => typeof t === 'string')
    : undefined;

  return {
    name: displayName,
    source,
    filePath,
    body: content.trim() || raw,
    tags: tags && tags.length > 0 ? tags : undefined,
    rawFrontmatter: data as Record<string, unknown>,
    dialect: 'openclaw',
    mtimeMs,
  };
}
