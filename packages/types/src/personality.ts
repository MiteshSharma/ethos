export interface PersonalityConfig {
  id: string;
  name: string;
  description?: string;
  ethosFile?: string;
  skillsDirs?: string[];
  toolset?: string[];
  capabilities?: string[];
  model?: string;
  provider?: string;
  platform?: string;
  memoryScope?: 'global' | 'per-personality';
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
