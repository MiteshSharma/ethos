export type IngestMode = 'capability' | 'tags' | 'explicit' | 'none';
export type FallbackBehavior = 'deny' | 'warn' | 'allow';

export interface IngestConfig {
  global_ingest?: {
    mode?: IngestMode;
    accept_tags?: string[];
    reject_tags?: string[];
    allow?: string[];
    deny?: string[];
    /** What to do when a skill has no `required_tools` in capability mode. Default: 'allow'. */
    fallback_unknown?: FallbackBehavior;
  };
}

export interface SkillIngestConfig extends IngestConfig {
  /**
   * Controls how global-pool skills are injected into the system prompt.
   *
   * - `'index'` (default): inject a compact table of name + description.
   *   The LLM calls `get_skill(name)` to load the full body on demand.
   * - `'full'`: inject every matching skill's full body (original behavior).
   *   Suitable only for small collections (< ~20 skills).
   */
  injection_mode?: 'full' | 'index';
}

/** A skill parsed from any source directory. */
export interface Skill {
  /** Qualified name: `<source>/<name>` (e.g. `claude-code/citation-formatter`). */
  qualifiedName: string;
  /** Display name from frontmatter `name` field, or derived from file path. */
  name: string;
  /** Source label (e.g. `ethos`, `claude-code`, `openclaw`, `hermes`). */
  source: string;
  /** Absolute path to the skill file. */
  filePath: string;
  /** Markdown body with frontmatter stripped. */
  body: string;
  /** Tags from frontmatter. */
  tags?: string[];
  /** Tools required by this skill, from frontmatter `required_tools`. */
  required_tools?: string[];
  /** Raw parsed frontmatter object. */
  rawFrontmatter: Record<string, unknown>;
  /** Which frontmatter dialect was detected. */
  dialect: 'agentskills' | 'openclaw' | 'hermes' | 'legacy';
  /** mtime for cache invalidation. */
  mtimeMs: number;
}
