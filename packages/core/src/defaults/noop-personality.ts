import type { PersonalityConfig, PersonalityRegistry } from '@ethosagent/types';

const DEFAULT_PERSONALITY: PersonalityConfig = {
  id: 'default',
  name: 'Default',
  description: 'Default Ethos personality',
};

export class DefaultPersonalityRegistry implements PersonalityRegistry {
  private readonly personalities = new Map<string, PersonalityConfig>([
    ['default', DEFAULT_PERSONALITY],
  ]);
  private defaultId = 'default';

  define(config: PersonalityConfig): void {
    this.personalities.set(config.id, config);
  }

  get(id: string): PersonalityConfig | undefined {
    return this.personalities.get(id);
  }

  list(): PersonalityConfig[] {
    return [...this.personalities.values()];
  }

  getDefault(): PersonalityConfig {
    return this.personalities.get(this.defaultId) ?? DEFAULT_PERSONALITY;
  }

  setDefault(id: string): void {
    if (!this.personalities.has(id)) {
      throw new Error(`Unknown personality: ${id}`);
    }
    this.defaultId = id;
  }

  async loadFromDirectory(_dir: string): Promise<void> {
    // Implemented in extensions/personalities
  }

  remove(id: string): void {
    this.personalities.delete(id);
  }
}
