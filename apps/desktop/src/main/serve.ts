import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import { createWebApi } from '@ethosagent/web-api';
import type { WiringConfig } from '@ethosagent/wiring';
import {
  APPROVAL_SURFACE_ALWAYS_ASK,
  createAgentLoop,
  createApprovalDangerPredicate,
  createLazyProvider,
  createLLM,
  createMemoryProvider,
  createSessionStore,
  IdentityMap,
} from '@ethosagent/wiring';
import { serve as honoServe } from '@hono/node-server';
import { getKeychainValue } from './keychain';
import { store } from './store';

type ServerHandle = ReturnType<typeof honoServe>;

let serverHandle: ServerHandle | null = null;
let boundPort: number | null = null;

function getDataDir(): string {
  return store.get('dataDir') ?? join(homedir(), '.ethos');
}

export async function startServer(port: number): Promise<number> {
  if (serverHandle) return boundPort ?? port;

  const dataDir = getDataDir();

  const provider = (store.get('provider') as string) ?? 'anthropic';
  const model = (store.get('model') as string) ?? 'claude-sonnet-4-20250514';
  const baseUrl = store.get('baseUrl') as string | undefined;

  // Prefer keychain; fall back to secrets file (written by the onboarding handler)
  const apiKey = (await getKeychainValue('api-key')) ?? '';

  const wiringConfig: WiringConfig = {
    provider,
    model,
    apiKey,
    personality: (store.get('personalityId') as string | undefined) ?? 'operator',
    memory: store.get('memory') ?? 'markdown',
    ...(baseUrl ? { baseUrl } : {}),
  };

  const {
    loop,
    toolRegistry,
    sttProviders,
    ttsProviders,
    voiceConfig,
    refreshPersonalities,
    skillsInjector,
    onMemoryCaptured,
  } = await createAgentLoop(wiringConfig, {
    dataDir,
    profile: 'web',
    disableDocker: true,
  });

  const session = createSessionStore({ dataDir });

  const personalities = await createPersonalityRegistry({
    storage: new FsStorage(),
    userPersonalitiesDir: dataDir,
  });

  // Load built-in personalities from the bundled data directory.
  // import.meta.dirname inside loadBuiltins() points to the bundled output dir
  // after electron-vite, so we resolve the data dir ourselves.
  const builtinPersonalitiesDir = (() => {
    const candidates = [
      join(__dirname, '..', '..', 'extensions', 'personalities', 'data'),
      join(__dirname, '..', '..', '..', '..', 'extensions', 'personalities', 'data'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return undefined;
  })();
  if (builtinPersonalitiesDir) {
    await personalities.loadFromDirectory(builtinPersonalitiesDir);
  }

  await personalities.loadFromDirectory(join(dataDir, 'personalities'));

  const identityMap = new IdentityMap({ storage: new FsStorage(), dataDir });
  await identityMap.resolve('desktop', 'desktop', 'Desktop');

  const skillsCatalogDir = (() => {
    const candidates = [
      join(__dirname, '..', '..', 'skills'),
      join(__dirname, '..', '..', '..', '..', 'skills'),
    ];
    for (const c of candidates) {
      if (existsSync(c)) return c;
    }
    return undefined;
  })();

  const webDistDir = (() => {
    const candidates = [
      // Packaged app: extraResources lands under process.resourcesPath
      join(process.resourcesPath ?? '', 'web-dist'),
      // Dev: relative to bundled output
      join(__dirname, '..', '..', 'apps', 'web', 'dist'),
      join(__dirname, '..', '..', '..', '..', 'apps', 'web', 'dist'),
    ];
    for (const c of candidates) {
      if (existsSync(join(c, 'index.html'))) return c;
    }
    return undefined;
  })();

  const { app: webApp } = createWebApi({
    dataDir,
    sessionStore: session,
    memoryProvider: createMemoryProvider({
      dataDir,
      storage: new FsStorage(),
      source: 'web-editor',
    }),
    // Backend selection for the approve-before-store queue — a web approve
    // replays into the configured backend (vault under memory: vault).
    memoryBackend: wiringConfig,
    identityMap,
    agentLoop: loop,
    personalities,
    refreshPersonalities,
    // Renderer-capability seam for `personalities.renderers` (the loop's own
    // injector — one scanner, one mtime cache for the process).
    skillsInjector,
    chatDefaults: { model, provider },
    // Threaded with the turn's personality (learned from the loop's
    // `session_start`) so `denyRules` and `approvalMode` are enforced, plus a
    // lazy provider handle for `approvalMode: 'smart'` — nothing is
    // constructed unless a flagged call actually reaches the reviewer.
    dangerPredicate: createApprovalDangerPredicate({
      hooks: [loop.hooks],
      personalities,
      getProvider: createLazyProvider(() => createLLM(wiringConfig)),
      model,
      alwaysAsk: APPROVAL_SURFACE_ALWAYS_ASK,
    }),
    ...(onMemoryCaptured ? { onMemoryCaptured } : {}),
    toolRegistry,
    // F1 — the desktop runs the in-process backend with Docker disabled, so the
    // character sheet must render the honest local (un-sandboxed) posture rather
    // than claiming Docker.
    dockerBuildable: false,
    sttProviderRegistry: sttProviders,
    sttProviderName: voiceConfig.sttProviderName,
    sttProviderConfig: voiceConfig.sttProviderConfig,
    ttsProviderRegistry: ttsProviders,
    ttsProviderName: voiceConfig.ttsProviderName,
    ttsProviderConfig: voiceConfig.ttsProviderConfig,
    ...(skillsCatalogDir ? { catalogDir: skillsCatalogDir } : {}),
    ...(webDistDir ? { webDist: webDistDir } : {}),
  });

  function bind(p: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const s = honoServe(
        { fetch: webApp.fetch, port: p, hostname: '127.0.0.1' },
        (info: AddressInfo) => {
          serverHandle = s;
          resolve(info.port);
        },
      );
      s.once('error', reject);
    });
  }

  let actual: number;
  try {
    actual = await bind(port);
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'EADDRINUSE') {
      actual = await bind(0);
    } else {
      throw err;
    }
  }

  boundPort = actual;
  console.log(`[ethos-backend] in-process server listening on http://127.0.0.1:${actual}`);
  return actual;
}

export async function stopServer(): Promise<void> {
  if (!serverHandle) return;
  const s = serverHandle;
  serverHandle = null;
  boundPort = null;
  await new Promise<void>((resolve) => s.close(() => resolve()));
}

export function getPort(): number | null {
  return boundPort;
}
