import type { PersonalityRegistry } from '@ethosagent/types';
import { FileContextInjector } from './file-context-injector';
import { MemoryGuidanceInjector } from './memory-guidance-injector';
import { SkillsInjector } from './skills-injector';

export { FileContextInjector } from './file-context-injector';
export { MemoryGuidanceInjector } from './memory-guidance-injector';
export { sanitize } from './prompt-injection-guard';
export {
  applySubstitutions,
  type OpenClawMeta,
  type ParsedFrontmatter,
  parseSkillFrontmatter,
  shouldInject,
} from './skill-compat';
export { SkillsInjector, type SkillsInjectorOptions } from './skills-injector';
export {
  type PendingSkillRecord,
  type PersonalitySkillRecord,
  type SkillRecord,
  SkillsLibrary,
  type SkillsLibraryOptions,
} from './skills-library';

export interface InjectorConfig {
  /** Override the global skills directory (defaults to ~/.ethos/skills/) */
  globalSkillsDir?: string;
  /** Notified when a skill is skipped because of OpenClaw `requires`/`os` rules. */
  onSkillSkip?: (skillId: string, reason: string) => void;
}

/**
 * Creates the standard set of context injectors in priority order.
 * Pass these to AgentLoopConfig.injectors — AgentLoop sorts by priority.
 */
export function createInjectors(personalities: PersonalityRegistry, config: InjectorConfig = {}) {
  return [
    new SkillsInjector(personalities, {
      globalSkillsDir: config.globalSkillsDir,
      onSkip: config.onSkillSkip,
    }),
    new FileContextInjector(),
    new MemoryGuidanceInjector(),
  ];
}
