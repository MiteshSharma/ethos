import Store from 'electron-store';

export interface AppStoreType {
  theme: 'dark' | 'light' | 'system';
  onboardingComplete: boolean;
  advancedMode: boolean;
  provider?: 'anthropic' | 'openai' | 'openrouter' | 'azure' | 'ollama';
  model?: string;
  compressionModel?: string;
  visionModel?: string;
  baseUrl?: string;
  personalityId?: string;
  backendPort: number;
  windowBounds?: { x: number; y: number; width: number; height: number };
  hasShownMinimizeHint?: boolean;
  hasShownHotkeyConflict?: boolean;
  memory: 'markdown' | 'vector';
  approvalMode: 'manual' | 'smart' | 'off';
  contextLayering: boolean;
  debugMode: boolean;
  verbosity: 'concise' | 'balanced' | 'verbose';
  messageFontSize: number;
  codeBlockFontSize: number;
  retentionDays: number;
  traceLogDays: number;
  observabilityDays: number;
  autoUpdate: boolean;
  launchAtLogin: boolean;
  hasShownLoginItemHint: boolean;
  dataDir?: string;
  connectionMode?: 'local' | 'remote';
  remoteUrl?: string;
  /**
   * ISO 8601 timestamp of the last remote web-token save. Exists so Settings
   * can show WHEN the token was stored without ever reading the token itself —
   * that value stays in the keychain and never reaches the renderer.
   */
  remoteTokenSavedAt?: string;
  useSpaMode: boolean;
  /**
   * Wake-word enabled state. Persisted because the mic indicator has to be
   * honest across restarts: a user who switched wake off must not come back to
   * an app that quietly started listening again (Hermes #81531).
   */
  wakeEnabled: boolean;
  /**
   * Self-assigned satellite node id, generated once and kept. The gateway lane
   * key derives from it (`voice:<node>:<personality>`), so a per-boot id would
   * fork the conversation on every restart and orphan yesterday's history under
   * an id nothing will ask for again.
   */
  satelliteNodeId?: string;
  /**
   * Personality bound to the desktop-owned call-capture daemon
   * (`apps/desktop/src/main/call-capture.ts`). Desktop-specific override —
   * wins over the shared `~/.ethos/config.yaml`'s `callCapture.personalityId`
   * when both are set (see `readSharedVoiceAndCallCaptureConfig` in
   * `serve.ts`). There is currently no Settings UI to set this field; today
   * it's only ever set by hand-editing the Electron store's JSON file
   * directly.
   *
   * Undefined/unset here does NOT by itself mean call-capture is disabled
   * for this desktop instance: `serve.ts` falls back to the shared config's
   * `callCapture.personalityId` — the same file/field `ethos serve`/`ethos
   * gateway` read — when this field is absent. Both absent, and no
   * personality unconditionally declaring the `call_capture` toolset
   * capability, is what actually disables it.
   */
  callCapturePersonalityId?: string;
}

let storeInstance: Store<AppStoreType> | null = null;

function getStore(): Store<AppStoreType> {
  if (!storeInstance) {
    storeInstance = new Store<AppStoreType>({
      defaults: {
        theme: 'dark',
        onboardingComplete: false,
        advancedMode: false,
        backendPort: 3001,
        memory: 'markdown',
        approvalMode: 'manual',
        contextLayering: false,
        debugMode: false,
        verbosity: 'balanced',
        messageFontSize: 14,
        codeBlockFontSize: 13,
        retentionDays: 90,
        traceLogDays: 30,
        observabilityDays: 7,
        autoUpdate: true,
        launchAtLogin: false,
        hasShownLoginItemHint: false,
        useSpaMode: true,
        wakeEnabled: true,
      },
    });
  }
  return storeInstance;
}

export const store = new Proxy({} as Store<AppStoreType>, {
  get(_target, prop, receiver) {
    const value = Reflect.get(getStore(), prop, receiver);
    return typeof value === 'function' ? value.bind(getStore()) : value;
  },
  set(_target, prop, value) {
    return Reflect.set(getStore(), prop, value);
  },
});
