import type { CaptureState, DoctorProbeRow } from '@ethosagent/voice-satellite';

export interface OnboardingState {
  configured: boolean;
}

/**
 * Lifecycle of the desktop wake-satellite host — deliberately NOT derived from
 * "is the socket open". `wake_off` is a first-class state because the persisted
 * off-switch must be distinguishable from a failure, and `degraded` is one
 * because a failing preflight has to be able to say why.
 */
export type SatelliteState = 'stopped' | 'running' | 'degraded' | 'wake_off';

export interface SatelliteStatus {
  state: SatelliteState;
  /** The persisted switch, not a live inference. */
  wakeEnabled: boolean;
  /** Stable across restarts; the gateway lane key derives from it. */
  nodeId: string;
  /** What the capture machine reports. `null` when no machine was built. */
  capture: CaptureState | null;
  /** Why the host is degraded or off. */
  reason?: string;
  /** Preflight rows, so a Settings row can name the failing probe inline. */
  probes: DoctorProbeRow[];
  /** Enabled wake phrases from the gateway's pushed routing table. */
  phrases: string[];
}

export interface ValidateProviderRequest {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'azure' | 'codex';
  apiKey: string;
  baseUrl?: string;
  model?: string;
}

export interface ValidateProviderResponse {
  valid: boolean;
  completionTested: boolean;
  error?: string;
  errorCode?: 'invalid_key' | 'no_credits' | 'model_not_found' | 'other';
  models?: string[];
}

export interface OnboardingCompleteRequest {
  provider: 'anthropic' | 'openai' | 'openrouter' | 'azure' | 'codex';
  model: string;
  apiKey: string;
  personalityId: string;
  baseUrl?: string;
}

export interface PersonalityListItem {
  id: string;
  name: string;
  description: string;
  accent: string;
  isBuiltin: boolean;
}

export interface ChatSendRequest {
  message: string;
  sessionId?: string;
}

export type ProviderType = 'anthropic' | 'openai' | 'openrouter' | 'azure' | 'ollama' | 'codex';

export interface ConfigGetResponse {
  provider: ProviderType;
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

export interface ConfigUpdateRequest {
  provider?: ProviderType;
  model?: string;
  compressionModel?: string;
  visionModel?: string;
  baseUrl?: string;
  memory?: 'markdown' | 'vector';
  approvalMode?: 'manual' | 'smart' | 'off';
  contextLayering?: boolean;
  debugMode?: boolean;
  verbosity?: 'concise' | 'balanced' | 'verbose';
  messageFontSize?: number;
  codeBlockFontSize?: number;
  theme?: 'dark' | 'light' | 'system';
  retentionDays?: number;
  traceLogDays?: number;
  observabilityDays?: number;
  autoUpdate?: boolean;
  launchAtLogin?: boolean;
  hasShownLoginItemHint?: boolean;
}

export interface RetentionValues {
  retentionDays: number;
  traceLogDays: number;
  observabilityDays: number;
}

export interface IpcContract {
  'onboarding:state': { request: undefined; response: OnboardingState };
  'onboarding:validateProvider': {
    request: ValidateProviderRequest;
    response: ValidateProviderResponse;
  };
  'onboarding:complete': {
    request: OnboardingCompleteRequest;
    response: { success: boolean; error?: string };
  };
  'personalities:list': { request: undefined; response: PersonalityListItem[] };
  'backend:port': { request: undefined; response: number };
  'backend:start': { request: { port: number }; response: { started: boolean } };
  'backend:restart': { request: undefined; response: { ok: boolean } };
  'health:check': { request: { port: number }; response: { healthy: boolean } };
  'theme:get': { request: undefined; response: 'dark' | 'light' };
  'advancedMode:get': { request: undefined; response: boolean };
  'advancedMode:set': { request: { enabled: boolean }; response: { ok: boolean } };
  'chat:send': { request: ChatSendRequest; response: { sessionId: string } };
  'theme:set': { request: { theme: 'dark' | 'light' | 'system' }; response: { ok: boolean } };
  'keychain:set': { request: { key: string; value: string }; response: { ok: boolean } };
  'keychain:preview': { request: { key: string }; response: { preview: string | null } };
  'config:get': { request: undefined; response: ConfigGetResponse };
  'config:update': { request: ConfigUpdateRequest; response: { ok: boolean; error?: string } };
  'shell:openConfigFolder': { request: undefined; response: { ok: boolean } };
  'export:data': {
    request: undefined;
    response: { ok: boolean; path?: string; error?: string };
  };
  'retention:prune': {
    request: RetentionValues;
    response: { ok: boolean; freedBytes?: number; error?: string };
  };
  'dialog:showOpen': {
    request: { properties: string[] };
    response: { canceled: boolean; filePaths: string[] };
  };
  'dialog:showMessage': {
    request: { type?: string; title?: string; message: string; buttons?: string[] };
    response: { response: number };
  };
  'shell:openExternal': { request: { url: string }; response: { ok: boolean } };
  'dialog:showOpenDialog': {
    request: { properties: string[] };
    response: { canceled: boolean; filePaths: string[] };
  };
  'file:save': {
    request: { defaultName: string; content: string };
    response: { ok: boolean; path?: string; error?: string };
  };
  'gateway:platformStatus': {
    request: undefined;
    response: { telegram: boolean; slack: boolean; discord: boolean; whatsapp: boolean };
  };
  'backend:authToken': { request: undefined; response: string | null };
  'login-item:get': { request: undefined; response: boolean };
  'login-item:set': { request: { enabled: boolean }; response: { ok: boolean; error?: string } };
  'platform:testTelegram': {
    request: { token: string };
    response: { ok: boolean; username?: string; error?: string };
  };
  'platform:testDiscord': {
    request: { token: string };
    response: { ok: boolean; username?: string; error?: string };
  };
  'platform:testImap': {
    request: { host: string; port: number; user: string; password: string; tls: boolean };
    response: { ok: boolean; error?: string };
  };
  'platform:testSmtp': {
    request: { host: string; port: number; user: string; password: string; starttls: boolean };
    response: { ok: boolean; error?: string };
  };
  'settings:getDataDir': { request: undefined; response: { path: string } };
  'settings:setDataDir': {
    request: { path: string };
    response: { ok: boolean; restartRequired: boolean };
  };
  'plugin:list': {
    request: undefined;
    response: {
      plugins: Array<{
        id: string;
        name: string;
        version: string;
        description: string | null;
        hasHomePanel?: boolean;
      }>;
    };
  };
  'plugin:getCredential': {
    request: { pluginId: string; ref: string };
    response: { value: string | null };
  };
  'plugin:setCredential': {
    request: { pluginId: string; ref: string; value: string };
    response: { ok: boolean };
  };
  'plugin:credentialPreview': {
    request: { pluginId: string; ref: string };
    response: { preview: string | null };
  };
  'plugin:requestOAuth': {
    request: { pluginId: string; oauthRef: string };
    response: { ok: boolean };
  };
  'plugin:executeTool': {
    request: { pluginId: string; toolName: string; args: Record<string, unknown> };
    response: { ok: boolean; value?: string; error?: string; code?: string };
  };
  'codex:startAuth': {
    request: undefined;
    response: { ok: boolean; userCode?: string; error?: string };
  };
  'codex:authStatus': {
    request: undefined;
    response: { authorized: boolean };
  };
  'connection:get': {
    request: undefined;
    response: { mode: 'local' | 'remote'; url?: string; hasToken: boolean; tokenSavedAt?: string };
  };
  'connection:set': {
    request: { mode: 'local' | 'remote'; url?: string; token?: string };
    response: { ok: boolean; relaunchRequired?: boolean; error?: string };
  };
  'connection:test': {
    request: { url: string; token?: string };
    response: { ok: boolean; latencyMs?: number; version?: string; error?: string };
  };
  'connection:reload': { request: undefined; response: { ok: boolean } };
  'app:relaunch': { request: undefined; response: { ok: boolean } };
  'gateway:status': {
    request: undefined;
    response: { state: 'running' | 'stopped' | 'crashed' | 'starting'; serviceInstalled: boolean };
  };
  'gateway:start': { request: undefined; response: { ok: boolean } };
  'gateway:stop': { request: undefined; response: { ok: boolean } };
  'gateway:logPath': { request: undefined; response: { path: string } };
  'satellite:status': { request: undefined; response: SatelliteStatus };
  'satellite:start': { request: undefined; response: { ok: boolean } };
  'satellite:stop': { request: undefined; response: { ok: boolean } };
  'satellite:doctor': {
    request: undefined;
    response: { ok: boolean; probes: DoctorProbeRow[] };
  };
  'satellite:setWakeEnabled': { request: { enabled: boolean }; response: { ok: boolean } };
}

/** Main-to-renderer push events (via webContents.send, NOT ipcMain.handle) */
export interface RendererEvents {
  'chat:new': undefined;
  'navigate:session': { sessionId: string };
  'oauth:callback': { code: string; state: string };
  'plugin:oauthComplete': { oauthRef: string };
  'codex:authComplete': { ok: boolean; error?: string };
  'satellite:stateChanged': SatelliteStatus;
}

export const RENDERER_EVENTS = {
  'chat:new': 'chat:new',
  'navigate:session': 'navigate:session',
  'oauth:callback': 'oauth:callback',
  'plugin:oauthComplete': 'plugin:oauthComplete',
  'codex:authComplete': 'codex:authComplete',
  'satellite:stateChanged': 'satellite:stateChanged',
} as const;

export type IpcChannel = keyof IpcContract;

export const IPC_CHANNELS: { [K in IpcChannel]: K } = {
  'onboarding:state': 'onboarding:state',
  'onboarding:validateProvider': 'onboarding:validateProvider',
  'onboarding:complete': 'onboarding:complete',
  'personalities:list': 'personalities:list',
  'backend:port': 'backend:port',
  'backend:start': 'backend:start',
  'backend:restart': 'backend:restart',
  'health:check': 'health:check',
  'theme:get': 'theme:get',
  'advancedMode:get': 'advancedMode:get',
  'advancedMode:set': 'advancedMode:set',
  'chat:send': 'chat:send',
  'theme:set': 'theme:set',
  'keychain:set': 'keychain:set',
  'keychain:preview': 'keychain:preview',
  'config:get': 'config:get',
  'config:update': 'config:update',
  'shell:openConfigFolder': 'shell:openConfigFolder',
  'export:data': 'export:data',
  'retention:prune': 'retention:prune',
  'dialog:showOpen': 'dialog:showOpen',
  'dialog:showMessage': 'dialog:showMessage',
  'shell:openExternal': 'shell:openExternal',
  'dialog:showOpenDialog': 'dialog:showOpenDialog',
  'file:save': 'file:save',
  'gateway:platformStatus': 'gateway:platformStatus',
  'backend:authToken': 'backend:authToken',
  'login-item:get': 'login-item:get',
  'login-item:set': 'login-item:set',
  'platform:testTelegram': 'platform:testTelegram',
  'platform:testDiscord': 'platform:testDiscord',
  'platform:testImap': 'platform:testImap',
  'platform:testSmtp': 'platform:testSmtp',
  'settings:getDataDir': 'settings:getDataDir',
  'settings:setDataDir': 'settings:setDataDir',
  'plugin:list': 'plugin:list',
  'plugin:getCredential': 'plugin:getCredential',
  'plugin:setCredential': 'plugin:setCredential',
  'plugin:credentialPreview': 'plugin:credentialPreview',
  'plugin:requestOAuth': 'plugin:requestOAuth',
  'plugin:executeTool': 'plugin:executeTool',
  'codex:startAuth': 'codex:startAuth',
  'codex:authStatus': 'codex:authStatus',
  'connection:get': 'connection:get',
  'connection:set': 'connection:set',
  'connection:test': 'connection:test',
  'connection:reload': 'connection:reload',
  'app:relaunch': 'app:relaunch',
  'gateway:status': 'gateway:status',
  'gateway:start': 'gateway:start',
  'gateway:stop': 'gateway:stop',
  'gateway:logPath': 'gateway:logPath',
  'satellite:status': 'satellite:status',
  'satellite:start': 'satellite:start',
  'satellite:stop': 'satellite:stop',
  'satellite:doctor': 'satellite:doctor',
  'satellite:setWakeEnabled': 'satellite:setWakeEnabled',
};
