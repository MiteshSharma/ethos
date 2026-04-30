import type { PersonalityRegistry, Tool } from '@ethosagent/types';
import { FileContextInjector } from './file-context-injector';
import { GetSkillTool } from './get-skill-tool';
import { MemoryGuidanceInjector } from './memory-guidance-injector';
import { SkillsInjector } from './skills-injector';
import { UniversalScanner } from './universal-scanner';

export { FileContextInjector } from './file-context-injector';
export { type FilterResult, filterSkill, warnMissingAllowList } from './ingest-filter';
export { MemoryGuidanceInjector } from './memory-guidance-injector';
export { sanitize } from './prompt-injection-guard';
export {
  applySubstitutions,
  type OpenClawMeta,
  type ParsedFrontmatter,
  parseSkillFrontmatter,
  shouldInject,
} from './skill-compat';
export { GetSkillTool } from './get-skill-tool';
export { SkillsInjector, type SkillsInjectorOptions } from './skills-injector';
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
  /** Override the global skills directory (defaults to ~/.ethos/skills/) */
  globalSkillsDir?: string;
  /** Notified when a skill is skipped because of OpenClaw `requires`/`os` rules. */
  onSkillSkip?: (skillId: string, reason: string) => void;
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
  config: InjectorConfig = {},
): { injectors: import('@ethosagent/types').ContextInjector[]; tools: Tool[] } {
  const scanner = new UniversalScanner();
  const skillsInjector = new SkillsInjector(personalities, {
    globalSkillsDir: config.globalSkillsDir,
    onSkip: config.onSkillSkip,
    scanner,
  });
  return {
    injectors: [skillsInjector, new FileContextInjector(), new MemoryGuidanceInjector()],
    tools: [new GetSkillTool(scanner) as Tool],
  };
}
