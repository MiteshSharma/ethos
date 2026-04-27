import type { AgentLoop } from '@ethosagent/core';
import type { LLMProvider } from '@ethosagent/types';
import {
  createAgentLoop as packageCreateAgentLoop,
  createLLM as packageCreateLLM,
} from '@ethosagent/wiring';
import { type EthosConfig, ethosDir, readKeys } from './config';
import { logger } from './logger';

// CLI-side adapter over @ethosagent/wiring. Resolves the rotation pool, data
// dir, working dir, and logger from the CLI's environment, then delegates.
// The actual loop assembly (LLM + tools + hooks + session/memory/personalities)
// lives in the package so TUI / web / ACP surfaces can share it.

async function withRotation(config: EthosConfig) {
  const rotationKeys = config.provider === 'anthropic' ? await readKeys() : [];
  return { ...config, rotationKeys };
}

export async function createLLM(config: EthosConfig): Promise<LLMProvider> {
  return packageCreateLLM(await withRotation(config));
}

export async function createAgentLoop(config: EthosConfig): Promise<AgentLoop> {
  return packageCreateAgentLoop(await withRotation(config), {
    dataDir: ethosDir(),
    workingDir: process.cwd(),
    profile: 'cli',
    logger,
  });
}
