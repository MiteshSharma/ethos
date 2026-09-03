import { contextBridge, ipcRenderer } from 'electron';
import type { SatelliteStatus } from '../shared/ipc-contract';
import { IPC_CHANNELS, RENDERER_EVENTS } from '../shared/ipc-contract';

const api = {
  platform: process.platform,
  port: 3001,
  onboarding: {
    state: () => ipcRenderer.invoke(IPC_CHANNELS['onboarding:state']),
    validateProvider: (req: {
      provider: string;
      apiKey: string;
      baseUrl?: string;
      model?: string;
    }) => ipcRenderer.invoke(IPC_CHANNELS['onboarding:validateProvider'], req),
    complete: (req: { provider: string; model: string; apiKey: string; personalityId: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['onboarding:complete'], req),
  },
  personalities: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS['personalities:list']),
  },
  backend: {
    getPort: () => ipcRenderer.invoke(IPC_CHANNELS['backend:port']),
    start: (req: { port: number }) => ipcRenderer.invoke(IPC_CHANNELS['backend:start'], req),
    restart: () => ipcRenderer.invoke(IPC_CHANNELS['backend:restart']),
    getAuthToken: () => ipcRenderer.invoke(IPC_CHANNELS['backend:authToken']),
  },
  health: {
    check: (req: { port: number }) => ipcRenderer.invoke(IPC_CHANNELS['health:check'], req),
  },
  theme: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS['theme:get']),
    onChange: (cb: (theme: 'dark' | 'light') => void) => {
      const listener = (_e: unknown, theme: 'dark' | 'light') => cb(theme);
      ipcRenderer.on('theme:changed', listener);
      return () => {
        ipcRenderer.removeListener('theme:changed', listener);
      };
    },
  },
  settings: {
    getAdvancedMode: () => ipcRenderer.invoke(IPC_CHANNELS['advancedMode:get']),
    setAdvancedMode: (req: { enabled: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS['advancedMode:set'], req),
    setTheme: (req: { theme: 'dark' | 'light' | 'system' }) =>
      ipcRenderer.invoke(IPC_CHANNELS['theme:set'], req),
    getConfig: () => ipcRenderer.invoke(IPC_CHANNELS['config:get']),
    updateConfig: (req: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC_CHANNELS['config:update'], req),
    openConfigFolder: () => ipcRenderer.invoke(IPC_CHANNELS['shell:openConfigFolder']),
    exportData: () => ipcRenderer.invoke(IPC_CHANNELS['export:data']),
    pruneRetention: (req: {
      retentionDays: number;
      traceLogDays: number;
      observabilityDays: number;
    }) => ipcRenderer.invoke(IPC_CHANNELS['retention:prune'], req),
    getDataDir: () => ipcRenderer.invoke(IPC_CHANNELS['settings:getDataDir']),
    setDataDir: (req: { path: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['settings:setDataDir'], req),
  },
  navigate: {
    onSession: (cb: (sessionId: string) => void) => {
      const listener = (_e: unknown, sessionId: string) => cb(sessionId);
      ipcRenderer.on('navigate:session', listener);
      return () => {
        ipcRenderer.removeListener('navigate:session', listener);
      };
    },
  },
  keychain: {
    set: (req: { key: string; value: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['keychain:set'], req),
    preview: (req: { key: string }) => ipcRenderer.invoke(IPC_CHANNELS['keychain:preview'], req),
  },
  loginItem: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS['login-item:get']),
    set: (req: { enabled: boolean }) => ipcRenderer.invoke(IPC_CHANNELS['login-item:set'], req),
  },
  shell: {
    openExternal: (req: { url: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['shell:openExternal'], req),
  },
  dialog: {
    showOpen: (req: { properties: string[] }) =>
      ipcRenderer.invoke(IPC_CHANNELS['dialog:showOpen'], req),
    showMessage: (req: { type?: string; title?: string; message: string; buttons?: string[] }) =>
      ipcRenderer.invoke(IPC_CHANNELS['dialog:showMessage'], req),
    showOpenDialog: (req: { properties: string[] }) =>
      ipcRenderer.invoke(IPC_CHANNELS['dialog:showOpenDialog'], req),
  },
  oauth: {
    onCallback: (cb: (data: { code: string; state: string }) => void) => {
      const listener = (_e: unknown, data: { code: string; state: string }) => cb(data);
      ipcRenderer.on('oauth:callback', listener);
      return () => {
        ipcRenderer.removeListener('oauth:callback', listener);
      };
    },
  },
  plugin: {
    list: () => ipcRenderer.invoke(IPC_CHANNELS['plugin:list']),
    getCredential: (pluginId: string, ref: string) =>
      ipcRenderer.invoke(IPC_CHANNELS['plugin:getCredential'], { pluginId, ref }),
    setCredential: (pluginId: string, ref: string, value: string) =>
      ipcRenderer.invoke(IPC_CHANNELS['plugin:setCredential'], { pluginId, ref, value }),
    credentialPreview: (pluginId: string, ref: string) =>
      ipcRenderer.invoke(IPC_CHANNELS['plugin:credentialPreview'], { pluginId, ref }),
    requestOAuth: (pluginId: string, oauthRef: string) =>
      ipcRenderer.invoke(IPC_CHANNELS['plugin:requestOAuth'], { pluginId, oauthRef }),
    executeTool: (pluginId: string, toolName: string, args: Record<string, unknown>) =>
      ipcRenderer.invoke(IPC_CHANNELS['plugin:executeTool'], { pluginId, toolName, args }),
    onOAuthComplete: (callback: (data: { oauthRef: string }) => void) => {
      ipcRenderer.on('plugin:oauthComplete', (_event, data: { oauthRef: string }) =>
        callback(data),
      );
    },
  },
  file: {
    save: (req: { defaultName: string; content: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['file:save'], req),
  },
  gateway: {
    platformStatus: () => ipcRenderer.invoke(IPC_CHANNELS['gateway:platformStatus']),
    status: () => ipcRenderer.invoke(IPC_CHANNELS['gateway:status']),
    start: () => ipcRenderer.invoke(IPC_CHANNELS['gateway:start']),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS['gateway:stop']),
    logPath: () => ipcRenderer.invoke(IPC_CHANNELS['gateway:logPath']),
  },
  satellite: {
    status: () => ipcRenderer.invoke(IPC_CHANNELS['satellite:status']),
    start: () => ipcRenderer.invoke(IPC_CHANNELS['satellite:start']),
    stop: () => ipcRenderer.invoke(IPC_CHANNELS['satellite:stop']),
    doctor: () => ipcRenderer.invoke(IPC_CHANNELS['satellite:doctor']),
    setWakeEnabled: (req: { enabled: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS['satellite:setWakeEnabled'], req),
    // Unsubscribe-returning, like theme/navigate/oauth above — a SPA route that
    // mounts the Settings → Voice panel twice must not leave a listener behind.
    onStateChanged: (cb: (status: SatelliteStatus) => void) => {
      const listener = (_e: unknown, status: SatelliteStatus) => cb(status);
      ipcRenderer.on(RENDERER_EVENTS['satellite:stateChanged'], listener);
      return () => {
        ipcRenderer.removeListener(RENDERER_EVENTS['satellite:stateChanged'], listener);
      };
    },
  },
  connection: {
    get: () => ipcRenderer.invoke(IPC_CHANNELS['connection:get']),
    set: (req: { mode: 'local' | 'remote'; url?: string; token?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['connection:set'], req),
    test: (req: { url: string; token?: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['connection:test'], req),
    reload: () => ipcRenderer.invoke(IPC_CHANNELS['connection:reload']),
  },
  app: {
    relaunch: () => ipcRenderer.invoke(IPC_CHANNELS['app:relaunch']),
  },
  codex: {
    startAuth: () => ipcRenderer.invoke(IPC_CHANNELS['codex:startAuth']),
    authStatus: () => ipcRenderer.invoke(IPC_CHANNELS['codex:authStatus']),
    onAuthComplete: (cb: (data: { ok: boolean; error?: string }) => void) => {
      const listener = (_e: unknown, data: { ok: boolean; error?: string }) => cb(data);
      ipcRenderer.on('codex:authComplete', listener);
      return () => {
        ipcRenderer.removeListener('codex:authComplete', listener);
      };
    },
  },
  platformTest: {
    telegram: (req: { token: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['platform:testTelegram'], req),
    discord: (req: { token: string }) =>
      ipcRenderer.invoke(IPC_CHANNELS['platform:testDiscord'], req),
    imap: (req: { host: string; port: number; user: string; password: string; tls: boolean }) =>
      ipcRenderer.invoke(IPC_CHANNELS['platform:testImap'], req),
    smtp: (req: {
      host: string;
      port: number;
      user: string;
      password: string;
      starttls: boolean;
    }) => ipcRenderer.invoke(IPC_CHANNELS['platform:testSmtp'], req),
  },
};

contextBridge.exposeInMainWorld('ethos', api);

export type EthosApi = typeof api;
