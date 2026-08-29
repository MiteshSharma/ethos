export type IngestMode = 'capability' | 'tags' | 'explicit' | 'none';

/** E2 — single env-var reference with a human-readable description. */
export interface SkillEnvRef {
  name: string;
  description?: string;
}

export interface SkillPermissions {
  fs_read?: string[];
  fs_write?: string[];
  network?: string[];
  tools_required?: string[];
  mcp_env_passthrough?: string[];
}
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
  /**
   * Fallback activation: skill is included only when ALL listed tools are
   * absent from the personality's effective tool reach. From frontmatter
   * `ethos.fallback_for_tools`. Mutually orthogonal with `required_tools`
   * (a skill MAY declare both — both gates must pass).
   */
  fallback_for_tools?: string[];
  /**
   * E2 — environment dependencies declared by the skill. Hard requirements:
   * skill is filtered out when any listed name is unset in `process.env`.
   * From frontmatter `ethos.env_required`.
   */
  env_required?: SkillEnvRef[];
  /**
   * E2 — informational env hints surfaced by `ethos doctor`. Never blocks
   * skill activation. From frontmatter `ethos.env_optional`.
   */
  env_optional?: SkillEnvRef[];
  /**
   * E2 — at least ONE of these external CLIs must be discoverable on PATH
   * for the skill to load. From frontmatter `ethos.external_cli_alternatives`.
   */
  external_cli_alternatives?: string[];
  /**
   * Renderer capabilities the skill declares, from frontmatter
   * `ethos.renders` (e.g. `['echarts@1']`). Each entry is
   * `<renderer-name>@<spec-version>`.
   *
   * Two-level versioning: the integer names OUR spec version — a documented
   * option subset taught by the skill (e.g. "the ECharts option subset of
   * charts skill v1") — NOT the npm version of the rendering library. The
   * levels move independently: the surface pins the library and owns the
   * spec→renderer map, so a library major bump that still renders the subset
   * is invisible to every skill, while a spec bump is a deliberate
   * skill-authoring event. Spec versions are small integers by design, so
   * semver strings are rejected at parse time.
   *
   * A skill DECLARES a capability; it never ships renderer code. A surface
   * renders only spec versions it maps, and degrades to a code block
   * otherwise.
   */
  renders?: string[];
  /** Raw parsed frontmatter object. */
  rawFrontmatter: Record<string, unknown>;
  /** Which frontmatter dialect was detected. */
  dialect: 'agentskills' | 'openclaw' | 'hermes' | 'legacy';
  /** mtime for cache invalidation. */
  mtimeMs: number;
  /** Declared permissions from SKILL.md frontmatter `ethos.permissions`. */
  permissions?: SkillPermissions;
  /**
   * Gap 11 — environment-gated skills. Hard requirements declared in
   * frontmatter under `ethos.requires` (or OpenClaw `metadata.*.requires`).
   * When any gate fails at load time the skill is excluded from injection
   * (unless `includeUnavailable` is set) and `unavailableReason` is populated.
   */
  requires?: {
    env?: string[];
    tools?: string[];
    os?: ('linux' | 'darwin' | 'win32')[];
  };
  /**
   * Non-null when the skill failed a `requires` gate. Human-readable reason
   * string (e.g. "missing env var OPENAI_API_KEY"). Set at load time by
   * `checkRequirements` in the skills extension.
   */
  unavailableReason?: string;
}
