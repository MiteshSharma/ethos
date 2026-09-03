/**
 * Typed bridge describing the `window.ethos` API exposed by the Electron preload script.
 *
 * These types are standalone — they do NOT import from `apps/desktop`.
 * The SPA imports them from `@ethosagent/web-contracts` and augments `Window`.
 */

// ---------------------------------------------------------------------------
// Shared value types
// ---------------------------------------------------------------------------

export interface EthosConnection {
  mode: 'local' | 'remote';
  url?: string;
  /** Whether a web token is stored in the OS keychain. The token never crosses the bridge. */
  hasToken: boolean;
  /** ISO timestamp of when that token was stored. */
  tokenSavedAt?: string;
}

export interface DesktopConfig {
  provider: string;
  model: string;
  compressionModel?: string;
  visionModel?: string;
  baseUrl?: string;
  apiKeyPreview: string | null;
  memory: 'markdown' | 'vector';
  approvalMode: 'manual' | 'smart' | 'off';
  contextLayering: boolean;
  debugMode: boolean;
  verbosity: 'concise' | 'balanced' | 'verbose';
  messageFontSize: number;
  codeBlockFontSize: number;
  theme: 'dark' | 'light' | 'system';
  retentionDays: number;
  traceLogDays: number;
  observabilityDays: number;
  autoUpdate: boolean;
  launchAtLogin: boolean;
  hasShownLoginItemHint: boolean;
  providers: Record<string, string[]>;
}

// ---------------------------------------------------------------------------
// Onboarding
// ---------------------------------------------------------------------------

interface OnboardingState {
  configured: boolean;
}

interface ValidateProviderResponse {
  valid: boolean;
  completionTested: boolean;
  error?: string;
  errorCode?: 'invalid_key' | 'no_credits' | 'model_not_found' | 'other';
  models?: string[];
}

// ---------------------------------------------------------------------------
// Personality list
// ---------------------------------------------------------------------------

interface PersonalityListItem {
  id: string;
  name: string;
  description: string;
  accent: string;
  isBuiltin: boolean;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

interface PluginListItem {
  id: string;
  name: string;
  version: string;
  description: string | null;
  hasHomePanel?: boolean;
}

// ---------------------------------------------------------------------------
// Bridge interface
// ---------------------------------------------------------------------------

export interface EthosDesktopBridge {
  platform: string;
  port: number;

  onboarding: {
    state: () => Promise<OnboardingState>;
    validateProvider: (req: {
      provider: string;
      apiKey: string;
      baseUrl?: string;
      model?: string;
    }) => Promise<ValidateProviderResponse>;
    complete: (req: {
      provider: string;
      model: string;
      apiKey: string;
      personalityId: string;
    }) => Promise<{ success: boolean; error?: string }>;
  };

  personalities: {
    list: () => Promise<PersonalityListItem[]>;
  };

  backend: {
    getPort: () => Promise<number>;
    start: (req: { port: number }) => Promise<{ started: boolean }>;
    restart: () => Promise<{ ok: boolean }>;
    getAuthToken: () => Promise<string | null>;
  };

  health: {
    check: (req: { port: number }) => Promise<{ healthy: boolean }>;
  };

  theme: {
    get: () => Promise<'dark' | 'light'>;
    onChange: (cb: (theme: 'dark' | 'light') => void) => () => void;
  };

  settings: {
    getAdvancedMode: () => Promise<boolean>;
    setAdvancedMode: (req: { enabled: boolean }) => Promise<{ ok: boolean }>;
    setTheme: (req: { theme: 'dark' | 'light' | 'system' }) => Promise<{ ok: boolean }>;
    getConfig: () => Promise<DesktopConfig>;
    updateConfig: (req: Record<string, unknown>) => Promise<{ ok: boolean; error?: string }>;
    openConfigFolder: () => Promise<{ ok: boolean }>;
    exportData: () => Promise<{ ok: boolean; path?: string; error?: string }>;
    pruneRetention: (req: {
      retentionDays: number;
      traceLogDays: number;
      observabilityDays: number;
    }) => Promise<{ ok: boolean; freedBytes?: number; error?: string }>;
    getDataDir: () => Promise<{ path: string }>;
    setDataDir: (req: { path: string }) => Promise<{ ok: boolean; restartRequired: boolean }>;
  };

  navigate: {
    onSession: (cb: (sessionId: string) => void) => () => void;
  };

  keychain: {
    set: (req: { key: string; value: string }) => Promise<{ ok: boolean }>;
    preview: (req: { key: string }) => Promise<{ preview: string | null }>;
  };

  loginItem: {
    get: () => Promise<boolean>;
    set: (req: { enabled: boolean }) => Promise<{ ok: boolean; error?: string }>;
  };

  shell: {
    openExternal: (req: { url: string }) => Promise<{ ok: boolean }>;
  };

  dialog: {
    showOpen: (req: {
      properties: string[];
    }) => Promise<{ canceled: boolean; filePaths: string[] }>;
    showMessage: (req: {
      type?: string;
      title?: string;
      message: string;
      buttons?: string[];
    }) => Promise<{ response: number }>;
    showOpenDialog: (req: {
      properties: string[];
    }) => Promise<{ canceled: boolean; filePaths: string[] }>;
  };

  oauth: {
    onCallback: (cb: (data: { code: string; state: string }) => void) => () => void;
  };

  plugin: {
    list: () => Promise<{ plugins: PluginListItem[] }>;
    getCredential: (pluginId: string, ref: string) => Promise<{ value: string | null }>;
    setCredential: (pluginId: string, ref: string, value: string) => Promise<{ ok: boolean }>;
    credentialPreview: (pluginId: string, ref: string) => Promise<{ preview: string | null }>;
    requestOAuth: (pluginId: string, oauthRef: string) => Promise<{ ok: boolean }>;
    executeTool: (
      pluginId: string,
      toolName: string,
      args: Record<string, unknown>,
    ) => Promise<{ ok: boolean; value?: string; error?: string; code?: string }>;
    onOAuthComplete: (callback: (data: { oauthRef: string }) => void) => void;
  };

  file: {
    save: (req: {
      defaultName: string;
      content: string;
    }) => Promise<{ ok: boolean; path?: string; error?: string }>;
  };

  gateway: {
    platformStatus: () => Promise<{
      telegram: boolean;
      slack: boolean;
      discord: boolean;
      whatsapp: boolean;
    }>;
    status: () => Promise<{
      state: 'running' | 'stopped' | 'crashed' | 'starting';
      serviceInstalled: boolean;
    }>;
    start: () => Promise<{ ok: boolean }>;
    stop: () => Promise<{ ok: boolean }>;
    logPath: () => Promise<{ path: string }>;
  };

  connection: {
    get: () => Promise<EthosConnection>;
    set: (req: {
      mode: 'local' | 'remote';
      url?: string;
      token?: string;
    }) => Promise<{ ok: boolean; relaunchRequired?: boolean; error?: string }>;
    test: (req: {
      url: string;
      token?: string;
    }) => Promise<{ ok: boolean; latencyMs?: number; version?: string; error?: string }>;
    /** Clear the cached SPA and reload it from the configured server. */
    reload: () => Promise<{ ok: boolean }>;
  };

  app: {
    relaunch: () => Promise<{ ok: boolean }>;
  };

  codex: {
    startAuth: () => Promise<{ ok: boolean; userCode?: string; error?: string }>;
    authStatus: () => Promise<{ authorized: boolean }>;
    onAuthComplete: (cb: (data: { ok: boolean; error?: string }) => void) => () => void;
  };

  platformTest: {
    telegram: (req: {
      token: string;
    }) => Promise<{ ok: boolean; username?: string; error?: string }>;
    discord: (req: {
      token: string;
    }) => Promise<{ ok: boolean; username?: string; error?: string }>;
    imap: (req: {
      host: string;
      port: number;
      user: string;
      password: string;
      tls: boolean;
    }) => Promise<{ ok: boolean; error?: string }>;
    smtp: (req: {
      host: string;
      port: number;
      user: string;
      password: string;
      starttls: boolean;
    }) => Promise<{ ok: boolean; error?: string }>;
  };
}
