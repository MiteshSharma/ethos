import type { PersonalityRegistry } from '@ethosagent/types';
import { FileContextInjector } from './file-context-injector';
import { MemoryGuidanceInjector } from './memory-guidance-injector';
import { SkillsInjector } from './skills-injector';

export { FileContextInjector } from './file-context-injector';
export { MemoryGuidanceInjector } from './memory-guidance-injector';
export { sanitize } from './prompt-injection-guard';
export { SkillsInjector } from './skills-injector';

export interface InjectorConfig {
  /** Override the global skills directory (defaults to ~/.ethos/skills/) */
  globalSkillsDir?: string;
}

/**
 * Creates the standard set of context injectors in priority order.
 * Pass these to AgentLoopConfig.injectors — AgentLoop sorts by priority.
 */
export function createInjectors(personalities: PersonalityRegistry, config: InjectorConfig = {}) {
  return [
    new SkillsInjector(personalities, config.globalSkillsDir),
    new FileContextInjector(),
    new MemoryGuidanceInjector(),
  ];
}
