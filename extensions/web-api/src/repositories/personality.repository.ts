import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PersonalityConfig, PersonalityRegistry } from '@ethosagent/types';

// Wraps `@ethosagent/personalities`'s registry. Stays thin — the registry
// already handles directory loading + mtime cache. We add:
//   • `builtin` flag derived from where ethosFile lives
//   • `readEthosMd` so the service doesn't reach into node:fs

export interface PersonalityRepositoryOptions {
  registry: PersonalityRegistry;
  /** User data directory (typically `~/.ethos`). Personalities under
   *  `<dataDir>/personalities/` are user-created (mutable); anything else
   *  came from the package's bundled built-ins. */
  userPersonalitiesDir: string;
}

export interface DescribedPersonality {
  config: PersonalityConfig;
  builtin: boolean;
}

export class PersonalityRepository {
  private readonly userDirPrefix: string;

  constructor(private readonly opts: PersonalityRepositoryOptions) {
    this.userDirPrefix = `${join(opts.userPersonalitiesDir, 'personalities')}/`;
  }

  list(): DescribedPersonality[] {
    return this.opts.registry.list().map((config) => this.describe(config));
  }

  get(id: string): DescribedPersonality | null {
    const config = this.opts.registry.get(id);
    return config ? this.describe(config) : null;
  }

  defaultId(): string {
    return this.opts.registry.getDefault().id;
  }

  /**
   * Read the ETHOS.md body for a personality. Returns `''` if the
   * personality has no `ethosFile` (config-only personalities) or if the
   * file isn't readable for any reason.
   */
  async readEthosMd(id: string): Promise<string> {
    const config = this.opts.registry.get(id);
    if (!config?.ethosFile) return '';
    try {
      return await readFile(config.ethosFile, 'utf-8');
    } catch {
      return '';
    }
  }

  private describe(config: PersonalityConfig): DescribedPersonality {
    const ethosFile = config.ethosFile;
    const builtin = ethosFile ? !ethosFile.startsWith(this.userDirPrefix) : true;
    return { config, builtin };
  }
}
