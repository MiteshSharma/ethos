// Phase 30.8 — this schema is FROZEN.
//
// Adding a top-level field to `PersonalityConfig` requires:
//   1. A CHANGELOG entry justifying why it isn't a skill, a tool, or a memory section.
//   2. The `personality-schema-change` label on the PR.
//   3. Two-maintainer approval (enforced via branch protection).
//   4. Bumping the count in `.personality-field-count` at the repo root.
//
// The mechanical CI gate lives in
// `packages/types/src/__tests__/personality-field-count.test.ts`. It parses
// this interface at test time and fails if the count drifts from
// `.personality-field-count`. Culture sets the rule; CI enforces it.
//
// Common rejections — these belong in skills or per-channel adapter config,
// NOT here:
//   - voice modes / TTS settings
//   - emotion / mood / sentiment tags
//   - label or response templates
//   - per-channel UI affordances
export interface PersonalityConfig {
  /** @internal Personality directory name; populated by the loader, not user-set. */
  id: string;
  name: string;
  description?: string;
  /** @internal Absolute path to ETHOS.md; populated by the loader. */
  ethosFile?: string;
  /** @internal Absolute paths to skills directories; populated by the loader. */
  skillsDirs?: string[];
  toolset?: string[];
  capabilities?: string[];
  model?: string;
  provider?: string;
  platform?: string;
  memoryScope?: 'global' | 'per-personality';
  /**
   * Per-personality streaming watchdog: if no chunk arrives from the LLM within
   * this many milliseconds, the agent aborts the stream and emits an error.
   * Reset on every chunk, so slow-but-progressing streams are unaffected.
   * Defaults to AgentLoop's `streamingTimeoutMs` (120000ms / 2 minutes).
   * Thinking-mode personalities (e.g. Opus extended thinking) may need longer;
   * fast-turnaround personalities (Haiku) can pick something tighter.
   * See plan/IMPROVEMENT.md P1-2 / OpenClaw #68596.
   */
  streamingTimeoutMs?: number;
  /** @internal Free-form passthrough for adapter-specific metadata. */
  metadata?: Record<string, unknown>;
}

export interface PersonalityRegistry {
  define(config: PersonalityConfig): void;
  get(id: string): PersonalityConfig | undefined;
  list(): PersonalityConfig[];
  getDefault(): PersonalityConfig;
  setDefault(id: string): void;
  loadFromDirectory(dir: string): Promise<void>;
}
