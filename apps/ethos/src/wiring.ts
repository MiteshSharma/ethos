import type { AgentLoop } from '@ethosagent/core';
import { FsStorage } from '@ethosagent/storage-fs';
import type { LLMProvider, Storage } from '@ethosagent/types';
import {
  createAgentLoop as packageCreateAgentLoop,
  createLLM as packageCreateLLM,
  type WiringProfile,
} from '@ethosagent/wiring';
import { type EthosConfig, ethosDir, readKeys } from './config';
import { logger } from './logger';

// CLI-side adapter over @ethosagent/wiring. Resolves the rotation pool, data
// dir, working dir, and logger from the CLI's environment, then delegates.
// The actual loop assembly (LLM + tools + hooks + session/memory/personalities)
// lives in the package so TUI / web / ACP surfaces can share it.

let storageSingleton: Storage | undefined;

/**
 * The CLI's process-wide Storage instance. FsStorage is stateless so multiple
 * instances would be safe, but a singleton keeps the dependency-injection
 * graph readable: any code path that needs ~/.ethos/ access calls this.
 */
export function getStorage(): Storage {
  if (!storageSingleton) storageSingleton = new FsStorage();
  return storageSingleton;
}

async function withRotation(config: EthosConfig) {
  const rotationKeys = config.provider === 'anthropic' ? await readKeys(getStorage()) : [];
  return { ...config, rotationKeys };
}

export async function createLLM(config: EthosConfig): Promise<LLMProvider> {
  return packageCreateLLM(await withRotation(config));
}

export async function createAgentLoop(
  config: EthosConfig,
  opts: { profile?: WiringProfile } = {},
): Promise<AgentLoop> {
  return packageCreateAgentLoop(await withRotation(config), {
    dataDir: ethosDir(),
    workingDir: process.cwd(),
    profile: opts.profile ?? 'cli',
    logger,
  });
}
