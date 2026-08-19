import { join } from 'node:path';
import type { PersonalityConfig, PersonalityRegistry } from '@ethosagent/types';
import type { WiringContext } from '@ethosagent/wiring/types';
import { createPersonalityRegistry, type PersonalityToolsConfig } from './index';

export interface PersonalityCompose {
  personalities: PersonalityRegistry & {
    getMcpPolicy(id: string): import('@ethosagent/types').McpPolicy | undefined;
    getToolsConfig(id: string): PersonalityToolsConfig | undefined;
  };
  activePerson: PersonalityConfig;
}

export async function compose(
  ctx: WiringContext,
  opts?: { personality?: string },
): Promise<PersonalityCompose> {
  const personalities = await createPersonalityRegistry({
    storage: ctx.storage,
    ...(ctx.builtinPersonalitiesDir
      ? { builtinPersonalitiesDir: ctx.builtinPersonalitiesDir }
      : {}),
  });
  await personalities.loadFromDirectory(join(ctx.dataDir, 'personalities'));

  if (opts?.personality) {
    try {
      personalities.setDefault(opts.personality);
    } catch {
      // Unknown personality — fall back to built-in default.
    }
  }

  const activePerson = personalities.getDefault();

  return { personalities, activePerson };
}
