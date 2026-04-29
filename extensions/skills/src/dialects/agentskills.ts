import type { Skill } from '@ethosagent/types';
import matter from 'gray-matter';

/** Detect agentskills.io standard: `required_tools` or `tags` at the top level. */
export function canParse(data: Record<string, unknown>): boolean {
  return (
    Array.isArray(data.required_tools) ||
    Array.isArray(data.tags) ||
    typeof data.description === 'string'
  );
}

/**
 * Parse an agentskills.io skill file.
 * Returns null when frontmatter is absent or the file is empty.
 */
export function parseAgentSkills(
  raw: string,
  filePath: string,
  source: string,
  name: string,
  mtimeMs: number,
): Omit<Skill, 'qualifiedName'> | null {
  const { data, content } = matter(raw);
  const body = content.trim();
  if (Object.keys(data).length === 0 && body.length === 0) return null;

  const displayName = typeof data.name === 'string' ? data.name : (name as string);

  const tags = Array.isArray(data.tags)
    ? data.tags.filter((t): t is string => typeof t === 'string')
    : undefined;

  const required_tools = Array.isArray(data.required_tools)
    ? data.required_tools.filter((t): t is string => typeof t === 'string')
    : undefined;

  return {
    name: displayName,
    source,
    filePath,
    body: body || raw,
    tags: tags && tags.length > 0 ? tags : undefined,
    required_tools: required_tools && required_tools.length > 0 ? required_tools : undefined,
    rawFrontmatter: data as Record<string, unknown>,
    dialect: 'agentskills',
    mtimeMs,
  };
}
