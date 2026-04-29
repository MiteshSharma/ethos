import type { Skill } from '@ethosagent/types';
import matter from 'gray-matter';

/** Detect Hermes format: top-level `agent`, `category`, or `version` key. */
export function canParse(data: Record<string, unknown>): boolean {
  return (
    typeof data.agent === 'string' ||
    typeof data.category === 'string' ||
    (typeof data.version === 'string' && Object.keys(data).length > 1)
  );
}

/**
 * Parse a Hermes Skills Hub skill file.
 */
export function parseHermes(
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
    : typeof data.category === 'string'
      ? [data.category]
      : undefined;

  const required_tools = Array.isArray(data.required_tools)
    ? data.required_tools.filter((t): t is string => typeof t === 'string')
    : undefined;

  return {
    name: displayName,
    source,
    filePath,
    body: content.trim() || raw,
    tags: tags && tags.length > 0 ? tags : undefined,
    required_tools: required_tools && required_tools.length > 0 ? required_tools : undefined,
    rawFrontmatter: data as Record<string, unknown>,
    dialect: 'hermes',
    mtimeMs,
  };
}
