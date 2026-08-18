import { join } from 'node:path';
import {
  applySafeMode,
  BUILTIN_PERSONALITY_IDS,
  enforceConstitution,
  loadConstitution,
} from '@ethosagent/constitution';
import {
  type CapabilityBackends,
  ClarifyBridge,
  DefaultExecutionBackendRegistry,
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultStorageRegistry,
  DefaultToolRegistry,
  DefaultToolResultReducerRegistry,
  deriveFsReachPaths,
  FileClarifyStore,
} from '@ethosagent/core';
import { DockerExecutionBackend } from '@ethosagent/execution-docker';
import { LocalExecutionBackend } from '@ethosagent/execution-local';
import { SshExecutionBackend } from '@ethosagent/execution-ssh';
import {
  PROVIDER_CONTRACT_MAJOR as ANTHROPIC_CONTRACT,
  activate as activateAnthropic,
} from '@ethosagent/llm-anthropic';
import {
  PROVIDER_CONTRACT_MAJOR as AZURE_CONTRACT,
  activate as activateAzure,
} from '@ethosagent/llm-azure';
import {
  activate as activateBedrock,
  PROVIDER_CONTRACT_MAJOR as BEDROCK_CONTRACT,
} from '@ethosagent/llm-bedrock';
import {
  activate as activateCodex,
  PROVIDER_CONTRACT_MAJOR as CODEX_CONTRACT,
} from '@ethosagent/llm-codex';
import {
  activate as activateGeminiNative,
  PROVIDER_CONTRACT_MAJOR as GEMINI_NATIVE_CONTRACT,
} from '@ethosagent/llm-gemini-native';
import {
  activate as activateOpenaiCompat,
  PROVIDER_CONTRACT_MAJOR as OPENAI_COMPAT_CONTRACT,
} from '@ethosagent/llm-openai-compat';
import { HistoryStore } from '@ethosagent/memory-history';
import { compose as composeMemory } from '@ethosagent/memory-markdown/compose';
import { VectorMemoryProvider } from '@ethosagent/memory-vector';
import type { PersonalityCompose } from '@ethosagent/personalities/compose';
import { compose as composePersonalities } from '@ethosagent/personalities/compose';
import { DockerSandbox } from '@ethosagent/sandbox-docker';
import { compose as composeSession } from '@ethosagent/session-sqlite/compose';
import { FsAttachmentCache, FsStorage, REF_TO_ENV } from '@ethosagent/storage-fs';
import { readFileReducer } from '@ethosagent/tools-code/reducers/read-file';
import { kanbanListReducer } from '@ethosagent/tools-kanban/reducers/kanban-list';
import { bashReducer } from '@ethosagent/tools-terminal/reducers/bash';
import type {
  Constitution,
  ConstitutionEnforcement,
  ExecutionBackendRegistry,
  HookRegistry,
  LLMProviderRegistry,
  Logger,
  MemoryProviderRegistry,
  PersonalityConfig,
  PersonalityRegistry,
  RealtimeVoiceProviderRegistry,
  StorageRegistry,
  SttProviderRegistry,
  TtsProviderRegistry,
} from '@ethosagent/types';
import { activateFirstPartyPlugins } from './activate-first-party';
import { validateCallCaptureBinding } from './call-capture-binding';
import type { CreateAgentLoopOptions, WiringConfig } from './index';
import { buildVaultBackend, composeGatedMemory } from './memory-backend';
import { registerRemainingBuiltinProviders } from './register-builtin-providers';
import type { WiringContext } from './types';
import { createBuiltinVoiceRegistries } from './voice-registries';

export interface InfrastructureResult {
  llmProviders: LLMProviderRegistry;
  executionBackends: ExecutionBackendRegistry;
  memoryProviders: MemoryProviderRegistry;
  storageBackends: StorageRegistry;
  personalities: PersonalityCompose['personalities'];
  activePerson: PersonalityConfig;
  sandbox: DockerSandbox;
  hooks: HookRegistry;
  sessionCompose: ReturnType<typeof composeSession>;
  capabilityBackends: CapabilityBackends;
  tools: DefaultToolRegistry;
  clarifyBridge: ClarifyBridge;
  sttProviders: SttProviderRegistry;
  ttsProviders: TtsProviderRegistry;
  realtimeProviders: RealtimeVoiceProviderRegistry;
  constitutionEnforcement?: ConstitutionEnforcement;
  /**
   * The loaded operator constitution. `undefined` only in SAFE MODE (malformed
   * constitution). Threaded to compose-tools so the execution-posture resolver
   * and docker backend enforce `execution.*` and `filesystem.*` at runtime, not
   * just at load time.
   */
  constitution?: Constitution;
}

/**
 * The `personalityFsReach` handed to `CapabilityBackends` — the allow set behind
 * every `from-personality` tool capability (`ctx.scopedFs`).
 *
 * It goes through `deriveFsReachPaths` for the same reason ScopedStorage and the
 * docker mounts do: three copies of one rule drift. Reading the raw declared
 * config here meant an undeclared personality got an EMPTY set — which
 * `ScopedFsImpl` treats as deny-all — while the other two layers gave it
 * `ownDir + cwd`; and `${…}` tokens went unsubstituted.
 *
 * `EmptySubstitutionError` degrades to deny-all with a warning rather than
 * throwing. Warn-and-degrade matches `ensureFsReachDirs` (one bad path must not
 * take down the whole compose), and deny-all is the correct DIRECTION to degrade
 * an allowlist in: an unresolvable declared path must never be treated as
 * broader reach. The execution backend still throws the same error at exec time,
 * so the loud failure survives where it can be acted on.
 */
export function derivePersonalityFsReach(
  personality: PersonalityConfig,
  vars: { ethosHome: string; cwd: string },
  log: Logger,
): { read: string[]; write: string[] } {
  try {
    const { read, write } = deriveFsReachPaths(personality, {
      ethosHome: vars.ethosHome,
      self: personality.id,
      cwd: vars.cwd,
    });
    return { read, write };
  } catch (err) {
    log.warn('fs_reach: could not derive tool reach; falling back to deny-all', {
      personalityId: personality.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return { read: [], write: [] };
  }
}

/**
 * The `personalityFsReach` resolver handed to `CapabilityBackends`.
 *
 * It resolves per tool execution against the LIVE registry instead of storing a
 * derived `{read, write}`. Storing one froze the boundary at process start: an
 * edit to `~/.ethos/personalities/<id>/config.yaml` reached the character sheet
 * and the Documents root immediately, but the file tools kept refusing paths
 * the config plainly allowed until `ethos serve` was restarted. Capturing a
 * `PersonalityConfig` here would reintroduce exactly that, so the resolver
 * holds only the registry and looks the personality up by id — an in-memory map
 * lookup against the registry the surfaces already refresh, no disk I/O per
 * call. Taking the id per call is also what makes a mid-session `/personality`
 * switch resolve the new personality's reach.
 *
 * An id the registry does not know degrades to deny-all with a warning, never
 * to the active personality's (wider) set — same direction as the
 * `EmptySubstitutionError` degradation above.
 */
export function createPersonalityFsReachResolver(
  personalities: Pick<PersonalityRegistry, 'get' | 'getDefault'>,
  vars: { ethosHome: string; cwd: string },
  log: Logger,
): (personalityId?: string) => { read: string[]; write: string[] } {
  return (personalityId?: string) => {
    const person = personalityId ? personalities.get(personalityId) : personalities.getDefault();
    if (!person) {
      log.warn('fs_reach: unknown personality; falling back to deny-all', { personalityId });
      return { read: [], write: [] };
    }
    return derivePersonalityFsReach(person, vars, log);
  };
}

/**
 * Build the core infrastructure for createAgentLoop:
 *  - LLM + memory provider registries (built-ins registered)
 *  - Personalities loaded + active personality resolved
 *  - DockerSandbox initialized
 *  - HookRegistry created
 *  - Session compose (session store + kvStore factory)
 *  - CapabilityBackends constructed
 *  - ToolRegistry (DefaultToolRegistry) with reducers registered
 *  - ClarifyBridge
 */
export async function buildInfrastructure(
  wiringCtx: WiringContext,
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
): Promise<InfrastructureResult> {
  const { dataDir, log } = wiringCtx;

  // -------------------------------------------------------------------------
  // Provider registries — created first so plugins can register into them.
  // -------------------------------------------------------------------------

  // LLM provider registry — built-ins registered here; plugins add more via
  // registerLLMProvider. Built-in factories resolve the API key through
  // SecretsResolver first (ref: `providers/<name>/apiKey`), falling back to
  // the raw config value for backward compatibility.
  const llmProviders = new DefaultLLMProviderRegistry();
  await activateFirstPartyPlugins(
    [
      {
        id: '@ethosagent/llm-anthropic',
        activate: activateAnthropic,
        contractMajor: ANTHROPIC_CONTRACT,
      },
      {
        id: '@ethosagent/llm-openai-compat',
        activate: activateOpenaiCompat,
        contractMajor: OPENAI_COMPAT_CONTRACT,
      },
      {
        id: '@ethosagent/llm-azure',
        activate: activateAzure,
        contractMajor: AZURE_CONTRACT,
      },
      {
        id: '@ethosagent/llm-codex',
        activate: activateCodex,
        contractMajor: CODEX_CONTRACT,
      },
      {
        id: '@ethosagent/llm-bedrock',
        activate: activateBedrock,
        contractMajor: BEDROCK_CONTRACT,
      },
      {
        id: '@ethosagent/llm-gemini-native',
        activate: activateGeminiNative,
        contractMajor: GEMINI_NATIVE_CONTRACT,
      },
    ],
    llmProviders,
    log,
  );
  registerRemainingBuiltinProviders(llmProviders);

  // Execution backend registry — built-ins registered here.
  // backends resolved on demand in Lane B/c
  const executionBackends = new DefaultExecutionBackendRegistry();
  executionBackends.register('local', (ctx) => new LocalExecutionBackend(ctx));
  executionBackends.register('docker', (ctx) => new DockerExecutionBackend(ctx));
  executionBackends.register('ssh', (ctx) => new SshExecutionBackend(ctx));

  // Memory provider registry — built-ins registered here; plugins add more via
  // registerMemoryProvider.
  //
  // The `markdown` and `vault` factories compose the SAME decorator stack
  // (history + approve-before-store gate) via composeGatedMemory — the backend
  // decides where content + history live; the pending queue and tombstones stay
  // rooted at ~/.ethos in both cases (gate machinery, not memory content).
  //
  // Cap drops must be audible (the Curator lesson, plan §3b): the pending queue
  // signals every at-cap drop through this seam — logged, plus an observability
  // event when an adapter is wired.
  const pendingCapObservability = {
    onCapExceeded: (info: { scopeId: string; droppedId: string; cap: number }) => {
      log.warn(
        `memory pending queue at cap (${info.cap}) for ${info.scopeId} — dropped oldest candidate ${info.droppedId}`,
      );
      opts.observability?.recordMemoryPendingCapDrop({ details: { ...info } });
    },
  };
  const memoryProviders = new DefaultMemoryProviderRegistry();
  memoryProviders.register('markdown', ({ dataDir: dir }) => {
    // Agent tool writes flow through this provider; composeGatedMemory wraps it
    // in the history decorator so every mutation is auditable. Dream turns write
    // through the same handle and are relabelled from their `dream:` sessionKey
    // (§2.1).
    const { memoryProvider } = composeMemory({ ...wiringCtx, dataDir: dir });
    const history = new HistoryStore({ dataDir: dir, storage: wiringCtx.storage });
    return composeGatedMemory({
      base: memoryProvider,
      history,
      ...(config.memoryApproval ? { approval: config.memoryApproval } : {}),
      dataDir: dir,
      storage: wiringCtx.storage,
      observability: pendingCapObservability,
    }).provider;
  });
  memoryProviders.register('vector', ({ dataDir: dir }) => {
    return new VectorMemoryProvider({ dir, storage: wiringCtx.storage });
  });
  memoryProviders.register('vault', ({ dataDir: dir }) => {
    // ScopedStorage confinement + `.ethos-meta` history live in
    // buildVaultBackend; the gate stack composes identically to markdown, with
    // approve replaying through the VAULT provider handle.
    const { base, history } = buildVaultBackend({
      vault: config.memoryVault,
      storage: wiringCtx.storage,
      logger: log,
    });
    return composeGatedMemory({
      base,
      history,
      ...(config.memoryApproval ? { approval: config.memoryApproval } : {}),
      dataDir: dir,
      storage: wiringCtx.storage,
      observability: pendingCapObservability,
    }).provider;
  });

  // Storage backend registry — built-ins registered here; plugins add more
  // via registerStorage.
  const storageBackends = new DefaultStorageRegistry();
  storageBackends.register('fs', () => new FsStorage());
  // Dynamic import keeps the AWS SDK out of every boot — it loads only when the
  // s3 backend is actually resolved.
  storageBackends.register('s3', async (ctx) => {
    const { createS3Storage } = await import('@ethosagent/storage-s3');
    return createS3Storage(ctx.config, ctx.secrets);
  });

  // Voice provider registries — the built-in roster lives in one place
  // (`createBuiltinVoiceRegistries`) so diagnostics report exactly what the
  // running system has; plugins add more via registerSttProvider /
  // registerTtsProvider.
  const { sttProviders, ttsProviders, realtimeProviders } = createBuiltinVoiceRegistries();

  // -------------------------------------------------------------------------
  // Personalities
  // -------------------------------------------------------------------------

  const { personalities, activePerson } = await composePersonalities(wiringCtx, {
    personality: config.personality,
  });

  // ---------------------------------------------------------------------------
  // Constitution — operator-authoritative ceiling layered over personalities.
  // Malformed constitution → SAFE MODE: only built-ins load, read-only tools.
  // Hard violations throw ConstitutionViolationError and abort the run.
  // ---------------------------------------------------------------------------
  const constLoad = await loadConstitution(wiringCtx.storage, dataDir);
  let constitutionEnforcement: ConstitutionEnforcement | undefined;
  let constitution: Constitution | undefined;
  let effectiveActivePerson = activePerson;
  if (constLoad.status === 'malformed') {
    log.error(
      `Constitution malformed — entering SAFE MODE: ${constLoad.error} (see docs/content/using/how-to/safe-mode.md)`,
    );
    const safe = applySafeMode(personalities.list(), BUILTIN_PERSONALITY_IDS);
    const survivors = new Set(safe.map((p) => p.id));
    for (const p of personalities.list()) {
      if (!survivors.has(p.id)) personalities.remove(p.id);
    }
    effectiveActivePerson = personalities.getDefault();
  } else {
    constitution = constLoad.constitution;
    const result = enforceConstitution({
      constitution: constLoad.constitution,
      personalities: personalities.list(),
      ethosHome: dataDir,
      workingDir: wiringCtx.workingDir,
      log,
    });
    constitutionEnforcement = result.enforcement;
  }

  // -------------------------------------------------------------------------
  // Call-capture single-personality binding (decision 3) — validated against
  // the FINAL effective personality set (post safe-mode filtering).
  // -------------------------------------------------------------------------

  validateCallCaptureBinding(personalities.list(), config.callCapture);

  // -------------------------------------------------------------------------
  // Sandbox — shared by browser and code tools
  // -------------------------------------------------------------------------

  // init() is non-blocking when Docker is absent; tool sets gate themselves on isAvailable().
  const sandbox = new DockerSandbox();
  if (!opts.disableDocker) {
    await sandbox.init();
    if (!sandbox.isAvailable()) log.warn('Docker not available — run_code tool disabled');
  }

  // -------------------------------------------------------------------------
  // Hook registry — created early so kanban tools can be wired with it
  // -------------------------------------------------------------------------

  const hooks = new DefaultHookRegistry();

  // -------------------------------------------------------------------------
  // Session compose — session store + kvStore share the same DB path
  // -------------------------------------------------------------------------

  const sessionCompose = composeSession(wiringCtx);

  // -------------------------------------------------------------------------
  // Capability backends
  // -------------------------------------------------------------------------

  const resolver = config.secretsResolver;
  const { safeFetch } = await import('@ethosagent/safety-network');
  const { defaultAlwaysDeny } = await import('@ethosagent/storage-fs');

  const capabilityBackends: CapabilityBackends = {
    kvStoreFactory: sessionCompose.kvStoreFactory,
    secretsBackend: async (ref: string) => {
      if (resolver) {
        const val = await resolver.get(ref);
        if (val !== null) return val;
      }
      // Self-contained env fallback so callers without MergedSecretsResolver still get env support
      const envKey = REF_TO_ENV.get(ref);
      if (envKey) {
        const envVal = process.env[envKey];
        if (envVal) return envVal;
      }
      throw new Error(`Secret ${ref} not found`);
    },
    storage: await storageBackends.resolve(config.storage?.backend ?? 'fs', {
      config: config.storage ?? {},
      secrets: config.secretsResolver ?? {
        get: async () => null,
        set: async () => {},
        delete: async () => {},
        list: async () => [],
      },
      logger: log,
    }),
    personalityFsReach: createPersonalityFsReachResolver(
      personalities,
      { ethosHome: dataDir, cwd: wiringCtx.workingDir },
      log,
    ),
    personalityNetworkPolicy: effectiveActivePerson.safety?.network ?? {},
    safeFetch,
    alwaysDenyPaths: defaultAlwaysDeny(),
    attachmentCache: new FsAttachmentCache(new FsStorage(), join(dataDir, 'cache', 'attachments')),
  };

  // -------------------------------------------------------------------------
  // Tool registry with reducers
  // -------------------------------------------------------------------------

  const reducerRegistry = new DefaultToolResultReducerRegistry();
  reducerRegistry.register(bashReducer);
  reducerRegistry.register(readFileReducer);
  reducerRegistry.register(kanbanListReducer);
  const tools = new DefaultToolRegistry(capabilityBackends, reducerRegistry);

  // -------------------------------------------------------------------------
  // Clarify bridge
  // -------------------------------------------------------------------------

  const clarifyBridge = new ClarifyBridge(
    new FileClarifyStore(new FsStorage(), join(dataDir, 'clarify')),
  );

  return {
    llmProviders,
    executionBackends,
    memoryProviders,
    storageBackends,
    personalities,
    activePerson: effectiveActivePerson,
    sandbox,
    hooks,
    sessionCompose,
    capabilityBackends,
    tools,
    clarifyBridge,
    sttProviders,
    ttsProviders,
    realtimeProviders,
    constitutionEnforcement,
    constitution,
  };
}
