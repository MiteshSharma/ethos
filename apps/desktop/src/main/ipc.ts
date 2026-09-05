import type { EventEmitter } from 'node:events';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import { getDefaultModel, getModelsForProvider } from '@ethosagent/wiring/model-catalog';
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, session, shell } from 'electron';
import type { RetentionValues } from '../shared/ipc-contract';
import { IPC_CHANNELS } from '../shared/ipc-contract';
import { restartBackend, startBackend } from './backend';
import {
  applyRemoteAuthCookie,
  getConnectionMode,
  normalizeRemoteUrl,
  resolveBackendBaseUrl,
  testConnection,
} from './connection';
import { getGatewayLogPath, getGatewayStatus, startGateway, stopGateway } from './gateway-control';
import { getKeychainValue, setKeychainValue } from './keychain';
import { getLoginItem, setLoginItem } from './login-item';
import { testDiscord, testImap, testSmtp, testTelegram } from './platform-validator';
import {
  getSatelliteStatus,
  probeSatellite,
  setWakeEnabled,
  startSatellite,
  stopSatellite,
} from './satellite';
import { store } from './store';

/** Model ids from the wiring catalog for one provider, catalog default first. */
function catalogModelIds(providerId: string): string[] {
  const defaultId = getDefaultModel(providerId)?.modelId;
  const ids = getModelsForProvider(providerId).map((m) => m.modelId);
  return defaultId ? [defaultId, ...ids.filter((id) => id !== defaultId)] : ids;
}

const OPENAI_MODELS = catalogModelIds('openai');

const PROVIDER_MODELS: Record<string, string[]> = {
  anthropic: catalogModelIds('anthropic'),
  openai: OPENAI_MODELS,
  openrouter: [],
  azure: [],
  ollama: [],
  codex: catalogModelIds('codex'),
};

function maskApiKey(value: string): string {
  if (value.length < 8) return '••••';
  return `${value.slice(0, 3)}...${value.slice(-4)}`;
}

const ALLOWED_KEYCHAIN_KEYS = new Set(['api-key', 'remote-token']);

function getEthosDir(): string {
  const saved = store.get('dataDir');
  if (saved) return saved;
  return join(app.getPath('home'), '.ethos');
}

/** File-backed secrets resolver rooted at <ethosDir>/secrets — mirrors apps/ethos/src/wiring.ts. */
function getCodexSecrets(): FileSecretsResolver {
  const dir = join(getEthosDir(), 'secrets');
  return new FileSecretsResolver({ dir, storage: new FsStorage() });
}

export function registerIpcHandlers(): void {
  ipcMain.handle(IPC_CHANNELS['onboarding:state'], () => {
    return { configured: store.get('onboardingComplete', false) };
  });

  ipcMain.handle(
    IPC_CHANNELS['onboarding:validateProvider'],
    async (
      _event,
      req: {
        provider: 'anthropic' | 'openai' | 'openrouter' | 'azure';
        apiKey: string;
        baseUrl?: string;
        model?: string;
      },
    ) => {
      try {
        if (req.provider === 'anthropic') {
          const modelsRes = await fetch('https://api.anthropic.com/v1/models', {
            headers: {
              'x-api-key': req.apiKey,
              'anthropic-version': '2023-06-01',
            },
            signal: AbortSignal.timeout(15000),
          });
          if (modelsRes.status === 401) {
            return {
              valid: false,
              completionTested: false,
              error: 'API key invalid — check and re-enter.',
              errorCode: 'invalid_key' as const,
            };
          }
          if (modelsRes.status === 402 || modelsRes.status === 403) {
            return {
              valid: false,
              completionTested: false,
              error: 'Your account has no credits or limited access.',
              errorCode: 'no_credits' as const,
            };
          }

          const completionRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
              'x-api-key': req.apiKey,
              'anthropic-version': '2023-06-01',
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (completionRes.status === 402) {
            return {
              valid: true,
              completionTested: false,
              error: 'Your API key is valid but your account has no credits.',
              errorCode: 'no_credits' as const,
            };
          }
          if (completionRes.status === 403) {
            return {
              valid: true,
              completionTested: false,
              error: "This model isn't available on your plan.",
              errorCode: 'model_not_found' as const,
            };
          }
          if (!completionRes.ok) {
            const errText = await completionRes.text();
            return {
              valid: true,
              completionTested: false,
              error: `API key validated, but a test message failed: ${errText}`,
              errorCode: 'other' as const,
            };
          }

          return {
            valid: true,
            completionTested: true,
            models: ['claude-sonnet-4-20250514', 'claude-haiku-4-5-20251001'],
          };
        }

        if (req.provider === 'openai') {
          const modelsRes = await fetch('https://api.openai.com/v1/models', {
            headers: { Authorization: `Bearer ${req.apiKey}` },
            signal: AbortSignal.timeout(15000),
          });
          if (modelsRes.status === 401) {
            return {
              valid: false,
              completionTested: false,
              error: 'API key invalid — check and re-enter.',
              errorCode: 'invalid_key' as const,
            };
          }

          const completionRes = await fetch('https://api.openai.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${req.apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              model: OPENAI_MODELS[0],
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
            signal: AbortSignal.timeout(15000),
          });

          if (completionRes.status === 402 || completionRes.status === 429) {
            return {
              valid: true,
              completionTested: false,
              error: 'Your API key is valid but your account has no credits.',
              errorCode: 'no_credits' as const,
            };
          }
          if (!completionRes.ok) {
            const errText = await completionRes.text();
            return {
              valid: true,
              completionTested: false,
              error: `API key validated, but a test message failed: ${errText}`,
              errorCode: 'other' as const,
            };
          }

          return { valid: true, completionTested: true, models: OPENAI_MODELS };
        }

        if (req.provider === 'openrouter') {
          const base = 'https://openrouter.ai/api/v1';
          const modelsRes = await fetch(`${base}/models`, {
            headers: { Authorization: `Bearer ${req.apiKey}` },
            signal: AbortSignal.timeout(15000),
          });
          if (modelsRes.status === 401) {
            return {
              valid: false,
              completionTested: false,
              error: 'API key invalid — check and re-enter.',
              errorCode: 'invalid_key' as const,
            };
          }
          const completionRes = await fetch(`${base}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${req.apiKey}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: req.model || 'openai/gpt-4o-mini',
              max_tokens: 1,
              messages: [{ role: 'user', content: 'hi' }],
            }),
            signal: AbortSignal.timeout(15000),
          });
          if (completionRes.status === 402 || completionRes.status === 429) {
            return {
              valid: true,
              completionTested: false,
              error: 'Your API key is valid but your account has no credits.',
              errorCode: 'no_credits' as const,
            };
          }
          return { valid: true, completionTested: completionRes.ok, models: [] };
        }

        if (req.provider === 'azure') {
          if (!req.baseUrl || !req.model) {
            return {
              valid: false,
              completionTested: false,
              error: 'Resource URL and deployment name are required.',
              errorCode: 'other' as const,
            };
          }
          const baseUrl = req.baseUrl.replace(/\/$/, '');
          const endpoint = `${baseUrl}/openai/deployments/${req.model}/chat/completions?api-version=2024-10-21`;
          try {
            const res = await fetch(endpoint, {
              method: 'POST',
              headers: { 'api-key': req.apiKey, 'Content-Type': 'application/json' },
              body: JSON.stringify({
                messages: [{ role: 'user', content: 'hi' }],
                max_tokens: 1,
              }),
              signal: AbortSignal.timeout(15000),
            });
            if (res.status === 401 || res.status === 403) {
              return {
                valid: false,
                completionTested: false,
                error: 'API key invalid — check and re-enter.',
                errorCode: 'invalid_key' as const,
              };
            }
            if (res.status === 404) {
              return {
                valid: false,
                completionTested: false,
                error: 'Deployment not found — check the resource URL and deployment name.',
                errorCode: 'other' as const,
              };
            }
            if (!res.ok) {
              let detail = `HTTP ${res.status}`;
              try {
                const t = await res.text();
                if (t) detail = t;
              } catch {
                /* ignore */
              }
              return {
                valid: false,
                completionTested: false,
                error: `Azure request failed: ${detail}`,
                errorCode: 'other' as const,
              };
            }
            return { valid: true, completionTested: true, models: [req.model] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
              valid: false,
              completionTested: false,
              error: `Cannot reach Azure endpoint: ${msg}`,
              errorCode: 'other' as const,
            };
          }
        }

        return {
          valid: false,
          completionTested: false,
          error: 'Unknown provider',
          errorCode: 'other' as const,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          valid: false,
          completionTested: false,
          error: message,
          errorCode: 'other' as const,
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['onboarding:complete'],
    async (
      event,
      req: {
        provider: string;
        model: string;
        apiKey: string;
        personalityId: string;
      },
    ) => {
      // The preload is attached to the window, not to a URL, so the REMOTE
      // server's SPA also sees `window.ethos`. Its onboarding wizard must not be
      // able to write this Mac's ~/.ethos config or start a local backend.
      if (getConnectionMode() === 'remote') {
        return {
          success: false,
          error: 'Connected to a remote server — set up that server, not this Mac.',
        };
      }

      const validProviders = ['anthropic', 'openai', 'openrouter', 'azure', 'codex'];
      const validPersonalities = ['researcher', 'engineer', 'operator', 'coach'];

      if (!validProviders.includes(req.provider)) {
        return { success: false, error: 'Invalid provider' };
      }
      if (!req.model || typeof req.model !== 'string') {
        return { success: false, error: 'Invalid model' };
      }
      if (!/^[a-zA-Z0-9._:/-]+$/.test(req.model)) {
        return { success: false, error: 'Invalid model name' };
      }
      if (!validPersonalities.includes(req.personalityId)) {
        return { success: false, error: 'Invalid personality' };
      }

      if (req.apiKey) {
        await setKeychainValue('api-key', req.apiKey);
      }

      const ethosDir = getEthosDir();
      mkdirSync(ethosDir, { recursive: true });

      if (req.apiKey) {
        const secretsDir = join(ethosDir, 'secrets');
        mkdirSync(secretsDir, { recursive: true });
        writeFileSync(join(secretsDir, 'api-key'), `${req.apiKey}\n`, { mode: 0o600 });
      }

      const lines = [
        'schemaVersion: 1',
        `provider: ${req.provider}`,
        `model: ${req.model}`,
        `personality: ${req.personalityId}`,
      ];
      if (req.apiKey) {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: literal YAML secrets ref, not a JS template
        lines.push('apiKey: ${secrets:api-key}');
      }
      writeFileSync(join(ethosDir, 'config.yaml'), `${lines.join('\n')}\n`);

      store.set('provider', req.provider as 'anthropic' | 'openai' | 'openrouter' | 'azure');
      store.set('model', req.model);
      store.set('personalityId', req.personalityId);
      store.set('onboardingComplete', true);

      const win = BrowserWindow.fromWebContents(event.sender);
      if (win) {
        win.setResizable(true);
        win.setSize(1200, 800);
        win.center();
      }
      (app as unknown as EventEmitter).emit('ethos:onboarding-complete');
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS['personalities:list'], () => {
    return [
      {
        id: 'researcher',
        name: 'Researcher',
        description: 'Deep analysis, research, and synthesis',
        accent: '#4A9EFF',
        isBuiltin: true,
      },
      {
        id: 'engineer',
        name: 'Engineer',
        description: 'Code, architecture, debugging',
        accent: '#4ADE80',
        isBuiltin: true,
      },
      {
        id: 'operator',
        name: 'Assistant',
        description: 'General-purpose help with anything',
        accent: '#94A3B8',
        isBuiltin: true,
      },
      {
        id: 'coach',
        name: 'Coach',
        description: 'Guidance, encouragement, clarity',
        accent: '#E879F9',
        isBuiltin: true,
      },
    ];
  });

  ipcMain.handle(IPC_CHANNELS['health:check'], async (_event, req: { port: number }) => {
    const port = Number(req.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { healthy: false };
    }
    try {
      const res = await fetch(`http://localhost:${port}/healthz`, {
        signal: AbortSignal.timeout(2000),
      });
      return { healthy: res.status < 600 };
    } catch {
      return { healthy: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS['backend:port'], () => {
    return store.get('backendPort', 3001);
  });

  ipcMain.handle(IPC_CHANNELS['backend:authToken'], () => {
    try {
      const tokenPath = join(getEthosDir(), 'web-token');
      const token = readFileSync(tokenPath, 'utf-8').trim();
      return token || null;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC_CHANNELS['backend:start'], (_event, req: { port: number }) => {
    const port = Number(req.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return { started: false };
    }
    startBackend(port);
    return { started: true };
  });

  ipcMain.handle(IPC_CHANNELS['backend:restart'], () => {
    const port = store.get('backendPort', 3001) as number;
    restartBackend(port);
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS['theme:get'], () => {
    const pref = store.get('theme', 'dark');
    if (pref === 'system') {
      return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
    }
    return pref;
  });

  ipcMain.handle(IPC_CHANNELS['advancedMode:get'], () => {
    return store.get('advancedMode', false);
  });

  ipcMain.handle(IPC_CHANNELS['advancedMode:set'], (_event, req: { enabled: boolean }) => {
    store.set('advancedMode', req.enabled);
    return { ok: true };
  });

  ipcMain.handle(
    IPC_CHANNELS['theme:set'],
    (_event, req: { theme: 'dark' | 'light' | 'system' }) => {
      nativeTheme.themeSource = req.theme;
      store.set('theme', req.theme);

      const resolved =
        req.theme === 'system' ? (nativeTheme.shouldUseDarkColors ? 'dark' : 'light') : req.theme;

      const mainWindow = BrowserWindow.getFocusedWindow();
      if (mainWindow) {
        mainWindow.webContents.send('theme:changed', resolved);
      }

      return { ok: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['keychain:set'],
    async (_event, req: { key: string; value: string }) => {
      if (!ALLOWED_KEYCHAIN_KEYS.has(req.key)) {
        return { ok: false };
      }
      await setKeychainValue(req.key, req.value);

      // For the API key, also sync to ~/.ethos/secrets/api-key so the
      // backend subprocess (which uses FileSecretsResolver) picks it up,
      // then restart the backend to load the new key.
      if (req.key === 'api-key') {
        const ethosDir = getEthosDir();
        const secretsDir = join(ethosDir, 'secrets');
        mkdirSync(secretsDir, { recursive: true });
        writeFileSync(join(secretsDir, 'api-key'), `${req.value}\n`, { mode: 0o600 });
        const port = store.get('backendPort', 3001) as number;
        restartBackend(port);
      }

      return { ok: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS['keychain:preview'], async (_event, req: { key: string }) => {
    if (!ALLOWED_KEYCHAIN_KEYS.has(req.key)) {
      return { preview: null };
    }
    const value = await getKeychainValue(req.key);
    if (!value) return { preview: null };
    return { preview: maskApiKey(value) };
  });

  ipcMain.handle(IPC_CHANNELS['config:get'], async () => {
    const apiKey = await getKeychainValue('api-key');
    return {
      provider: store.get('provider', 'anthropic'),
      model: store.get('model', 'claude-sonnet-4-20250514'),
      compressionModel: store.get('compressionModel'),
      visionModel: store.get('visionModel'),
      baseUrl: store.get('baseUrl'),
      apiKeyPreview: apiKey ? maskApiKey(apiKey) : null,
      memory: store.get('memory', 'markdown'),
      approvalMode: store.get('approvalMode', 'manual'),
      contextLayering: store.get('contextLayering', false),
      debugMode: store.get('debugMode', false),
      verbosity: store.get('verbosity', 'balanced'),
      messageFontSize: store.get('messageFontSize', 14),
      codeBlockFontSize: store.get('codeBlockFontSize', 13),
      theme: store.get('theme', 'dark'),
      retentionDays: store.get('retentionDays', 90),
      traceLogDays: store.get('traceLogDays', 30),
      observabilityDays: store.get('observabilityDays', 7),
      autoUpdate: store.get('autoUpdate', true),
      launchAtLogin: store.get('launchAtLogin', false),
      hasShownLoginItemHint: store.get('hasShownLoginItemHint', false),
      providers: PROVIDER_MODELS,
    };
  });

  ipcMain.handle(IPC_CHANNELS['config:update'], async (_event, req: Record<string, unknown>) => {
    const validProviders = new Set([
      'anthropic',
      'openai',
      'openrouter',
      'azure',
      'ollama',
      'codex',
    ]);
    const validMemory = new Set(['markdown', 'vector']);
    const validApproval = new Set(['manual', 'smart', 'off']);
    const validVerbosity = new Set(['concise', 'balanced', 'verbose']);
    const validTheme = new Set(['dark', 'light', 'system']);

    if (req.provider !== undefined) {
      if (!validProviders.has(req.provider as string))
        return { ok: false, error: 'Invalid provider' };
      store.set('provider', req.provider as string);
    }
    if (req.model !== undefined) {
      if (typeof req.model !== 'string' || !/^[a-zA-Z0-9._:/-]+$/.test(req.model))
        return { ok: false, error: 'Invalid model' };
      store.set('model', req.model);
    }
    if (req.compressionModel !== undefined) {
      if (req.compressionModel !== null && typeof req.compressionModel === 'string') {
        if (req.compressionModel === '') {
          store.delete('compressionModel' as never);
        } else {
          store.set('compressionModel', req.compressionModel);
        }
      }
    }
    if (req.visionModel !== undefined) {
      if (req.visionModel !== null && typeof req.visionModel === 'string') {
        if (req.visionModel === '') {
          store.delete('visionModel' as never);
        } else {
          store.set('visionModel', req.visionModel);
        }
      }
    }
    if (req.baseUrl !== undefined) {
      if (req.baseUrl !== null && typeof req.baseUrl === 'string') {
        if (req.baseUrl === '') {
          store.delete('baseUrl' as never);
        } else {
          store.set('baseUrl', req.baseUrl);
        }
      }
    }
    if (req.memory !== undefined) {
      if (!validMemory.has(req.memory as string))
        return { ok: false, error: 'Invalid memory backend' };
      store.set('memory', req.memory as 'markdown' | 'vector');
    }
    if (req.approvalMode !== undefined) {
      if (!validApproval.has(req.approvalMode as string))
        return { ok: false, error: 'Invalid approval mode' };
      store.set('approvalMode', req.approvalMode as 'manual' | 'smart' | 'off');
    }
    if (req.verbosity !== undefined) {
      if (!validVerbosity.has(req.verbosity as string))
        return { ok: false, error: 'Invalid verbosity' };
      store.set('verbosity', req.verbosity as 'concise' | 'balanced' | 'verbose');
    }
    if (req.theme !== undefined) {
      if (!validTheme.has(req.theme as string)) return { ok: false, error: 'Invalid theme' };
      const theme = req.theme as 'dark' | 'light' | 'system';
      store.set('theme', theme);
      nativeTheme.themeSource = theme;
    }

    // Boolean fields
    for (const key of [
      'contextLayering',
      'debugMode',
      'autoUpdate',
      'launchAtLogin',
      'hasShownLoginItemHint',
    ] as const) {
      if (req[key] !== undefined) {
        if (typeof req[key] !== 'boolean') return { ok: false, error: `Invalid ${key}` };
        store.set(key, req[key] as boolean);
      }
    }

    if (req.launchAtLogin !== undefined && typeof req.launchAtLogin === 'boolean') {
      try {
        await setLoginItem(req.launchAtLogin);
      } catch {
        // store preference is already saved; OS login item is best-effort
      }
    }

    // Numeric fields with clamping
    const numericFields: Array<{ key: string; min: number; max: number; storeKey: string }> = [
      { key: 'messageFontSize', min: 12, max: 18, storeKey: 'messageFontSize' },
      { key: 'codeBlockFontSize', min: 11, max: 15, storeKey: 'codeBlockFontSize' },
      { key: 'retentionDays', min: 7, max: 365, storeKey: 'retentionDays' },
      { key: 'traceLogDays', min: 1, max: 90, storeKey: 'traceLogDays' },
      { key: 'observabilityDays', min: 1, max: 30, storeKey: 'observabilityDays' },
    ];
    for (const { key, min, max, storeKey } of numericFields) {
      if (req[key] !== undefined) {
        const val = Number(req[key]);
        if (!Number.isFinite(val)) return { ok: false, error: `Invalid ${key}` };
        store.set(storeKey, Math.max(min, Math.min(max, Math.round(val))));
      }
    }

    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS['shell:openConfigFolder'], async () => {
    const ethosDir = getEthosDir();
    await shell.openPath(ethosDir);
    return { ok: true };
  });

  // Not implemented. Asking for a destination first would prompt for a file
  // this handler will never write, so it answers before opening any dialog.
  ipcMain.handle(IPC_CHANNELS['export:data'], async () => {
    return { ok: false, error: 'Export is not implemented yet' };
  });

  // Not implemented. Reporting `ok` with zero bytes freed is a success message
  // for an operation that did not happen.
  ipcMain.handle(IPC_CHANNELS['retention:prune'], (_event, _req: RetentionValues) => {
    return { ok: false, error: 'Pruning is not implemented yet' };
  });

  ipcMain.handle(
    IPC_CHANNELS['dialog:showOpen'],
    async (_event: unknown, req: { properties: string[] }) => {
      const allowed = new Set(['openDirectory', 'openFile', 'multiSelections']);
      const properties = req.properties.filter((p) => allowed.has(p)) as Array<
        'openDirectory' | 'openFile' | 'multiSelections'
      >;
      const result = await dialog.showOpenDialog({ properties });
      return { canceled: result.canceled, filePaths: result.filePaths };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['dialog:showMessage'],
    async (
      _event: unknown,
      req: { type?: string; title?: string; message: string; buttons?: string[] },
    ) => {
      const allowedTypes = new Set(['none', 'info', 'error', 'question', 'warning']);
      const type =
        req.type && allowedTypes.has(req.type)
          ? (req.type as 'none' | 'info' | 'error' | 'question' | 'warning')
          : undefined;
      const buttons = req.buttons ? req.buttons.slice(0, 4) : undefined;
      const result = await dialog.showMessageBox({
        type,
        title: req.title,
        message: req.message,
        buttons,
      });
      return { response: result.response };
    },
  );

  ipcMain.handle(IPC_CHANNELS['shell:openExternal'], async (_event, req: { url: string }) => {
    if (!req.url.startsWith('https://')) {
      return { ok: false };
    }
    await shell.openExternal(req.url);
    return { ok: true };
  });

  ipcMain.handle(
    IPC_CHANNELS['dialog:showOpenDialog'],
    async (_event, req: { properties: string[] }) => {
      const win = BrowserWindow.getFocusedWindow();
      if (!win) return { canceled: true, filePaths: [] };
      const allowed = new Set(['openFile', 'openDirectory', 'multiSelections']);
      const validated = req.properties.filter((p) => allowed.has(p));
      const result = await dialog.showOpenDialog(win, {
        properties: validated as Array<'openFile' | 'openDirectory' | 'multiSelections'>,
      });
      return { canceled: result.canceled, filePaths: result.filePaths };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['file:save'],
    async (_event, req: { defaultName: string; content: string }) => {
      const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: req.defaultName,
      });
      if (canceled || !filePath) return { ok: false };
      await writeFile(filePath, req.content, 'utf-8');
      return { ok: true, path: filePath };
    },
  );

  ipcMain.handle(IPC_CHANNELS['gateway:platformStatus'], async () => {
    return { telegram: false, slack: false, discord: false, whatsapp: false };
  });

  ipcMain.handle(IPC_CHANNELS['login-item:get'], async () => {
    return getLoginItem();
  });

  ipcMain.handle(IPC_CHANNELS['login-item:set'], async (_event, req: { enabled: boolean }) => {
    try {
      await setLoginItem(req.enabled);
      store.set('launchAtLogin', req.enabled);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  });

  ipcMain.handle(IPC_CHANNELS['platform:testTelegram'], async (_event, req: { token: string }) => {
    return testTelegram(req.token);
  });

  ipcMain.handle(IPC_CHANNELS['platform:testDiscord'], async (_event, req: { token: string }) => {
    return testDiscord(req.token);
  });

  ipcMain.handle(IPC_CHANNELS['platform:testImap'], async (_event, req) => {
    return testImap(req);
  });

  ipcMain.handle(IPC_CHANNELS['platform:testSmtp'], async (_event, req) => {
    return testSmtp(req);
  });

  ipcMain.handle(IPC_CHANNELS['settings:getDataDir'], () => {
    return { path: getEthosDir() };
  });

  ipcMain.handle(IPC_CHANNELS['settings:setDataDir'], (_event, req: { path: string }) => {
    if (!req.path || typeof req.path !== 'string') return { ok: false };
    store.set('dataDir', req.path);
    return { ok: true, restartRequired: true };
  });

  // -------------------------------------------------------------------------
  // Plugin IPC handlers — proxy to backend HTTP API
  // -------------------------------------------------------------------------

  const pluginFetch = async (rpcMethod: string, body: Record<string, unknown> = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (getConnectionMode() === 'remote') {
      // The stored remote credential is a WEB token, so it goes on the
      // `ethos_auth` cookie. As an `Authorization: Bearer` header it would be
      // read as an `sk-ethos-` API key instead, and `dual-auth.ts` scope-gates
      // those — the plugins namespace has no scope, so every call would 403.
      const remoteToken = await getKeychainValue('remote-token');
      if (remoteToken) headers.Cookie = `ethos_auth=${remoteToken}`;
      headers.Origin = resolveBackendBaseUrl();
    }
    const res = await fetch(`${resolveBackendBaseUrl()}/rpc/${rpcMethod.replace(/\./g, '/')}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ json: body }),
    });
    return res.json();
  };

  ipcMain.handle(IPC_CHANNELS['plugin:list'], async () => {
    return pluginFetch('plugins.list');
  });

  ipcMain.handle(
    IPC_CHANNELS['plugin:getCredential'],
    async (_event, req: { pluginId: string; ref: string }) => {
      return pluginFetch('plugins.getCredential', { pluginId: req.pluginId, ref: req.ref });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['plugin:setCredential'],
    async (_event, req: { pluginId: string; ref: string; value: string }) => {
      return pluginFetch('plugins.setCredential', {
        pluginId: req.pluginId,
        ref: req.ref,
        value: req.value,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['plugin:credentialPreview'],
    async (_event, req: { pluginId: string; ref: string }) => {
      return pluginFetch('plugins.credentialPreview', { pluginId: req.pluginId, ref: req.ref });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['plugin:requestOAuth'],
    async (_event, req: { pluginId: string; oauthRef: string }) => {
      const result = await pluginFetch('plugins.requestOAuth', {
        pluginId: req.pluginId,
        oauthRef: req.oauthRef,
      });
      if (result && typeof result.url === 'string') {
        await shell.openExternal(result.url);
      }
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['plugin:executeTool'],
    async (_event, req: { pluginId: string; toolName: string; args: Record<string, unknown> }) => {
      return pluginFetch('plugins.executeTool', {
        pluginId: req.pluginId,
        toolName: req.toolName,
        args: req.args,
      });
    },
  );

  // -------------------------------------------------------------------------
  // Codex device auth IPC handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS['codex:startAuth'], async () => {
    try {
      const { requestDeviceCode, pollForAuthorization, exchangeForTokens, CodexTokenStore } =
        await import('@ethosagent/llm-codex');
      const store = new CodexTokenStore(getCodexSecrets());
      const { deviceAuthId, userCode } = await requestDeviceCode(fetch);
      // Open the auth URL in the user's default browser
      await shell.openExternal('https://auth.openai.com/codex/device');
      // Background poll — sends a one-time notification to renderer on completion
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 16 * 60 * 1000);
      pollForAuthorization(fetch, deviceAuthId, userCode, controller.signal)
        .then(({ authorizationCode, codeVerifier }) =>
          exchangeForTokens(fetch, authorizationCode, codeVerifier),
        )
        .then((credentials) => store.save(credentials))
        .then(() => {
          BrowserWindow.getAllWindows()[0]?.webContents.send('codex:authComplete', { ok: true });
        })
        .catch((err: unknown) => {
          BrowserWindow.getAllWindows()[0]?.webContents.send('codex:authComplete', {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return { ok: true, userCode };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Failed to start device auth',
      };
    }
  });

  ipcMain.handle(IPC_CHANNELS['codex:authStatus'], async () => {
    const { CodexTokenStore } = await import('@ethosagent/llm-codex');
    const store = new CodexTokenStore(getCodexSecrets());
    const tokens = await store.load();
    return { authorized: !!tokens };
  });

  // -------------------------------------------------------------------------
  // Connection mode IPC handlers
  // -------------------------------------------------------------------------

  // The token itself is never returned to the renderer — only whether one is
  // stored, and when it was stored.
  ipcMain.handle(IPC_CHANNELS['connection:get'], async () => {
    const url = store.get('remoteUrl');
    const tokenSavedAt = store.get('remoteTokenSavedAt');
    return {
      mode: getConnectionMode(),
      hasToken: (await getKeychainValue('remote-token')) !== null,
      ...(url ? { url } : {}),
      ...(tokenSavedAt ? { tokenSavedAt } : {}),
    };
  });

  ipcMain.handle(
    IPC_CHANNELS['connection:set'],
    async (_event, req: { mode: 'local' | 'remote'; url?: string; token?: string }) => {
      const previousMode = getConnectionMode();
      const previousUrl = store.get('remoteUrl');

      let url: string | undefined;
      if (req.url !== undefined) {
        const normalized = normalizeRemoteUrl(req.url);
        if (!normalized) return { ok: false, error: 'Enter an http:// or https:// server URL.' };
        url = normalized;
      }
      if (req.mode === 'remote' && !(url ?? previousUrl)) {
        return { ok: false, error: 'A remote server needs a URL.' };
      }

      store.set('connectionMode', req.mode);
      if (url) store.set('remoteUrl', url);
      if (req.token) {
        await setKeychainValue('remote-token', req.token);
        store.set('remoteTokenSavedAt', new Date().toISOString());
      }
      await applyRemoteAuthCookie();

      // Which backend the window is pointed at is decided at navigation time,
      // so a change of mode or address only takes effect on the next launch.
      const relaunchRequired =
        req.mode !== previousMode || (url !== undefined && url !== previousUrl);
      return { ok: true, ...(relaunchRequired ? { relaunchRequired: true } : {}) };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS['connection:test'],
    async (_event, req: { url: string; token?: string }) => {
      // Falls back to the saved token so Settings can re-test an existing
      // connection without making the user paste the token again.
      const token = req.token ?? (await getKeychainValue('remote-token'));
      return testConnection(req.url, token ?? undefined);
    },
  );

  ipcMain.handle(IPC_CHANNELS['connection:reload'], async () => {
    await session.defaultSession.clearCache();
    BrowserWindow.getAllWindows()[0]?.webContents.reload();
    return { ok: true };
  });

  ipcMain.handle(IPC_CHANNELS['app:relaunch'], () => {
    app.relaunch();
    app.quit();
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Gateway control IPC handlers
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS['gateway:status'], async () => {
    return getGatewayStatus();
  });

  ipcMain.handle(IPC_CHANNELS['gateway:start'], async () => {
    try {
      await startGateway();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS['gateway:stop'], async () => {
    try {
      await stopGateway();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS['gateway:logPath'], () => {
    return { path: getGatewayLogPath() };
  });

  // -------------------------------------------------------------------------
  // Wake-satellite IPC handlers
  //
  // Same never-throw convention as the gateway block above: an action answers
  // {ok} and the status read answers whatever the host currently believes. The
  // host itself never throws, so the try/catch here is belt-and-braces around
  // the IPC boundary rather than the host's error handling.
  // -------------------------------------------------------------------------

  ipcMain.handle(IPC_CHANNELS['satellite:status'], () => {
    return getSatelliteStatus();
  });

  ipcMain.handle(IPC_CHANNELS['satellite:start'], async () => {
    try {
      await startSatellite();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS['satellite:stop'], async () => {
    try {
      await stopSatellite();
      return { ok: true };
    } catch {
      return { ok: false };
    }
  });

  ipcMain.handle(IPC_CHANNELS['satellite:doctor'], async () => {
    return probeSatellite();
  });

  ipcMain.handle(
    IPC_CHANNELS['satellite:setWakeEnabled'],
    async (_event, req: { enabled: boolean }) => {
      try {
        await setWakeEnabled(req.enabled);
        return { ok: true };
      } catch {
        return { ok: false };
      }
    },
  );
}
