import { noopLogger } from '@ethosagent/logger';
import { FsStorage } from '@ethosagent/storage-fs';
import type { Logger, SecretsResolver } from '@ethosagent/types';
import type { CreateAgentLoopOptions, WiringConfig, WiringProfile } from './index';
import type { WiringContext } from './types';

export interface BuildContextResult {
  wiringCtx: WiringContext;
  dataDir: string;
  workingDir: string;
  profile: WiringProfile;
  log: Logger;
  NOOP_SECRETS: SecretsResolver;
}

/**
 * Build the WiringContext and resolve top-level options (dataDir, workingDir,
 * profile, logger) from CreateAgentLoopOptions. Also validates storage
 * encryption config and constructs the NOOP_SECRETS fallback.
 */
export function buildWiringContext(
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
): BuildContextResult {
  const { dataDir } = opts;
  const workingDir = opts.workingDir ?? process.cwd();
  const profile: WiringProfile = opts.profile ?? 'cli';
  const log: Logger = opts.logger ?? noopLogger;

  // Storage encryption — fail fast if enabled without the required env var.
  if (config.storage?.encryption) {
    const key = process.env.ETHOS_STORAGE_KEY;
    if (!key) {
      console.error(
        'Error: storage encryption is enabled but ETHOS_STORAGE_KEY is not set.\n' +
          'Set it in your environment or EnvironmentFile before starting Ethos.',
      );
      process.exit(1);
    }
  }

  const NOOP_SECRETS: SecretsResolver = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };

  const wiringCtx: WiringContext = {
    storage: new FsStorage(),
    dataDir,
    workingDir,
    log,
    ...(opts.builtinPersonalitiesDir
      ? { builtinPersonalitiesDir: opts.builtinPersonalitiesDir }
      : {}),
    ...(opts.callCaptureNativeDir ? { callCaptureNativeDir: opts.callCaptureNativeDir } : {}),
  };

  return { wiringCtx, dataDir, workingDir, profile, log, NOOP_SECRETS };
}
