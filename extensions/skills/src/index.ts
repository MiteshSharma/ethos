import type {
  HookRegistry,
  PersonalityConfig,
  PersonalityRegistry,
  Storage,
  Tool,
} from '@ethosagent/types';
import { FileContextInjector } from './file-context-injector';
import { GetSkillTool } from './get-skill-tool';
import { MemoryGuidanceInjector } from './memory-guidance-injector';
import { SkillsInjector } from './skills-injector';
import { type ScanSource, UniversalScanner } from './universal-scanner';

export { BUNDLED_SKILL_IDS, type BundledSkillId, bundledSkillsSource } from './bundled';
export {
  checkSkillEnv,
  defaultWhich,
  type EnvResolutionResult,
  type EnvResolverOptions,
} from './env-resolver';
export { FileContextInjector } from './file-context-injector';
export { GetSkillTool } from './get-skill-tool';
export {
  type FilterResult,
  filterSkill,
  setEnvResolverOptions,
  warnMissingAllowList,
} from './ingest-filter';
export { MemoryGuidanceInjector } from './memory-guidance-injector';
export { PlatformFormattingInjector } from './platform-formatting-injector';
export { sanitize } from './prompt-injection-guard';
export {
  applySubstitutions,
  checkRequirements,
  checkSkillFrontmatter,
  type FrontmatterCheck,
  type OpenClawMeta,
  type ParsedFrontmatter,
  parseSkillFrontmatter,
  shouldInject,
} from './skill-compat';
export {
  type ResolvedSkill,
  SkillsInjector,
  type SkillsInjectorOptions,
} from './skills-injector';
export {
  type PendingSkillRecord,
  type PersonalitySkillRecord,
  type SkillRecord,
  SkillsLibrary,
  type SkillsLibraryOptions,
} from './skills-library';
export {
  externalSources,
  type ScanSource,
  UniversalScanner,
  type UniversalScannerOptions,
} from './universal-scanner';

export interface InjectorConfig {
  /** Storage backend. Injected by the composition root; required — never
   *  falls back to raw disk. */
  storage: Storage;
  /** Override the global skills directory (defaults to ~/.ethos/skills/) */
  globalSkillsDir?: string;
  /** Notified when a skill is skipped because of OpenClaw `requires`/`os` rules. */
  onSkillSkip?: (skillId: string, reason: string) => void;
  /**
   * Untrusted extension point — additional skill sources from user config,
   * plugins, or other caller-controlled sources. Always gated at the
   * `community` trust tier (red AND yellow safety findings block).
   */
  extraSources?: ScanSource[];
  /**
   * First-party extension point — skill sources that ship inside Ethos
   * itself (e.g. `@ethosagent/skills-library`'s bundled `data/` directory).
   * Gated at `builtin` — the tier that means "shipped inside this
   * repository" — so legitimate mentions of `bash`, `gh`, `curl`, etc.
   * don't block. Reserved for in-repo callers; user config goes via
   * `extraSources`.
   */
  trustedFirstPartySources?: ScanSource[];
  /**
   * E5 — when provided, the FileContextInjector subscribes to
   * `tool_end_with_path` for progressive context-file discovery in
   * monorepos. Without it, the injector falls back to static-only.
   */
  hooks?: HookRegistry;
  /**
   * Gap 11 — live tool-reach getter for `requires.tools` gating and
   * capability-mode filtering. Wiring passes a registry-backed closure
   * (evaluated per resolveSkills() call, so late-registered MCP/plugin
   * tools are visible). When omitted, tool availability is unknown and
   * the `requires.tools` gate is skipped.
   */
  toolNamesForPersonality?: (personality: PersonalityConfig) => Set<string>;
}

/**
 * Creates the standard set of context injectors and skill tools.
 *
 * The returned `tools` array must be registered in the ToolRegistry before
 * creating the AgentLoop. The injector and tools share one UniversalScanner
 * so the mtime cache is reused across inject + get_skill calls.
 */
export function createInjectors(
  personalities: PersonalityRegistry,
  config: InjectorConfig,
): {
  injectors: import('@ethosagent/types').ContextInjector[];
  tools: Tool[];
  skillsInjector: SkillsInjector;
  scanner: UniversalScanner;
} {
  const scanner = new UniversalScanner({
    storage: config.storage,
    extraSources: config.extraSources,
    trustedFirstPartySources: config.trustedFirstPartySources,
  });
  const skillsInjector = new SkillsInjector(personalities, {
    storage: config.storage,
    globalSkillsDir: config.globalSkillsDir,
    onSkip: config.onSkillSkip,
    scanner,
    ...(config.toolNamesForPersonality
      ? { toolNamesForPersonality: config.toolNamesForPersonality }
      : {}),
  });
  const fileContext = new FileContextInjector({
    storage: config.storage,
    personalities,
    ...(config.hooks ? { hooks: config.hooks } : {}),
  });
  // `skillsInjector` is surfaced concretely (not just inside `injectors`) so
  // read-only surfaces can call `resolveSkills()` without re-deriving the
  // scanner + filter wiring.
  return {
    injectors: [skillsInjector, fileContext, new MemoryGuidanceInjector()],
    tools: [new GetSkillTool(scanner, skillsInjector) as Tool],
    skillsInjector,
    scanner,
  };
}
