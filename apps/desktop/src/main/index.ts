import type { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import { WebTokenRepository } from '@ethosagent/web-api';
import { app, BrowserWindow, nativeTheme, session, type Tray } from 'electron';
import type { SatelliteStatus } from '../shared/ipc-contract';
import { initAutoUpdater } from './auto-update';
import { restartBackendAsync, startBackend, startBackendAsync, stopBackend } from './backend';
import {
  applyRemoteAuthCookie,
  getConnectionMode,
  isConfigured,
  remoteHost,
  remoteOrigin,
  resolveBackendBaseUrl,
  wsOriginFor,
} from './connection';
import { showConnectionWindow } from './connection-window';
import { showErrorWindow } from './error-window';
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './global-shortcut';
import { registerIpcHandlers } from './ipc';
import { setKeychainValue } from './keychain';
import { showMinimizeNotification } from './notifications';
import { registerProtocolHandler } from './protocol-handler';
import { registerQuickChatIpc, showQuickChat } from './quick-chat-window';
import { onSatelliteStatus, setWakeEnabled, startSatellite, stopSatellite } from './satellite';
import { isBackgroundMode, logBackgroundStartup } from './startup-mode';
import { store } from './store';
import { createTray, destroyTray, setTrayState, setWakeTray, type TrayState } from './tray';

let mainWindow: BrowserWindow | null = null;
let trayInstance: Tray | null = null;
let isQuitting = false;
let desktopActivated = false;

function getDataDir(): string {
  return store.get('dataDir') ?? join(homedir(), '.ethos');
}

/**
 * `onboardingComplete` tracks setup of the LOCAL backend, and only the
 * `onboarding:complete` IPC flips it. A remote deployment is already set up —
 * on its own server — so gating the window shape, the close-to-tray behaviour
 * and tray activation on that flag alone would leave remote mode permanently
 * in the onboarding window with no tray.
 */
export function needsLocalOnboarding(): boolean {
  return getConnectionMode() === 'local' && !store.get('onboardingComplete', false);
}

async function loadSpaUrl(win: BrowserWindow, port: number): Promise<void> {
  const baseUrl = `http://127.0.0.1:${port}`;
  // The embedded web-api gates /rpc behind the ethos_auth cookie matching the
  // stored web-token. Read (or create) that token and set the cookie directly,
  // every load, so it can never go stale. We avoid /auth/exchange because it
  // rotates the token and relies on Electron persisting a 302 Set-Cookie.
  const tokens = new WebTokenRepository({ dataDir: getDataDir(), storage: new FsStorage() });
  const token = await tokens.getOrCreate();
  await session.defaultSession.cookies.set({
    url: baseUrl,
    name: 'ethos_auth',
    value: token,
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  });
  win.loadURL(baseUrl);
}

/**
 * In remote mode the SPA is served BY the remote origin, so a loopback
 * `connect-src` would block every RPC and SSE call it makes. The rest of the
 * policy is identical in both modes.
 */
function spaConnectSrc(): string {
  if (getConnectionMode() === 'remote') {
    const origin = remoteOrigin(store.get('remoteUrl') ?? '');
    if (origin) return `'self' ${origin} ${wsOriginFor(origin)}`;
  }
  const isDev = process.env.NODE_ENV === 'development';
  const localConnect = isDev ? ' http://localhost:* ws://localhost:*' : '';
  return `'self' http://127.0.0.1:* ws://127.0.0.1:*${localConnect}`;
}

function setupSpaCsp(): void {
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    `connect-src ${spaConnectSrc()}`,
    "img-src 'self' data: https:",
    "font-src 'self'",
  ].join('; ');

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}

async function startBackendWithRetry(port: number): Promise<number> {
  const logPath = join(getDataDir(), 'ethos.log');
  for (;;) {
    try {
      return await startBackendAsync(port);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const result = await showErrorWindow({
        title: 'Backend Failed',
        message: `Could not start the backend server.\n${message}`,
        logPath,
      });
      if (result === 'quit') {
        app.quit();
        throw err;
      }
    }
  }
}

/**
 * Remote mode is a THIN CLIENT: the window navigates to the remote server,
 * which serves its own SPA same-origin. No local backend is started.
 */
async function loadRemoteUrl(win: BrowserWindow): Promise<void> {
  await applyRemoteAuthCookie();
  // Deliberately not awaited, same as `loadSpaUrl`: a failed load both rejects
  // here and fires `did-fail-load`, which is where recovery lives. Awaiting
  // would surface the same failure a second time as an unhandled rejection.
  win.loadURL(resolveBackendBaseUrl());
}

let remoteRecoveryOpen = false;

async function handleRemoteLoadFailure(reason: string): Promise<void> {
  if (remoteRecoveryOpen) return;
  remoteRecoveryOpen = true;
  try {
    const host = remoteHost(store.get('remoteUrl') ?? '') ?? 'the remote server';
    const action = await showErrorWindow({
      title: 'Connection Failed',
      message: `Can't reach ${host} — ${reason}.`,
      altLabel: 'Switch to local',
    });
    if (action === 'alt') {
      store.set('connectionMode', 'local');
      app.relaunch();
      app.quit();
      return;
    }
    if (action === 'quit') {
      app.quit();
      return;
    }
    const win = mainWindow;
    if (win && !win.isDestroyed()) await loadRemoteUrl(win);
  } finally {
    remoteRecoveryOpen = false;
  }
}

/**
 * The saved web token stopped working — most often because someone signed into
 * that server from a browser with a `?t=` URL, which rotates it. Ask for a
 * fresh one rather than leaving the window on a SPA that cannot authenticate.
 */
async function handleRemoteAuthRejected(): Promise<void> {
  if (remoteRecoveryOpen) return;
  remoteRecoveryOpen = true;
  try {
    const choice = await showConnectionWindow({
      ...(store.get('remoteUrl') ? { url: store.get('remoteUrl') } : {}),
      message: 'This server no longer accepts the saved token. Paste a fresh one from ethos serve.',
    });
    if (!choice) {
      app.quit();
      return;
    }
    await persistConnectionChoice(choice);
    app.relaunch();
    app.quit();
  } finally {
    remoteRecoveryOpen = false;
  }
}

function wireRemoteRecovery(win: BrowserWindow): void {
  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription, _url, isMainFrame) => {
    // ERR_ABORTED (-3) is a superseded or cancelled navigation, not a failure.
    if (!isMainFrame || errorCode === -3) return;
    void handleRemoteLoadFailure(errorDescription || `error ${errorCode}`);
  });

  // A 401 never reaches a navigation event: web-api serves index.html
  // UNAUTHENTICATED (`staticRoutes` is mounted after the auth middleware and
  // owns `/*`), so the top-level document is always a 200 and the rejection
  // only surfaces on the SPA's first `/rpc/*` call. `onCompleted` on that
  // request is therefore the only signal that actually fires.
  const origin = remoteOrigin(store.get('remoteUrl') ?? '');
  if (!origin) return;
  session.defaultSession.webRequest.onCompleted({ urls: [`${origin}/rpc/*`] }, (details) => {
    if (details.statusCode === 401) void handleRemoteAuthRejected();
  });
}

async function persistConnectionChoice(choice: {
  mode: 'local' | 'remote';
  url?: string;
  token?: string;
}): Promise<void> {
  store.set('connectionMode', choice.mode);
  if (choice.url) store.set('remoteUrl', choice.url);
  if (choice.token) {
    await setKeychainValue('remote-token', choice.token);
    store.set('remoteTokenSavedAt', new Date().toISOString());
  }
}

/** Toggle wake from the tray. The host persists before it restarts anything. */
function toggleWake(enabled: boolean): void {
  setWakeEnabled(enabled).catch((err: unknown) => {
    console.error('[ethos] failed to toggle wake:', err);
  });
}

/**
 * What the menu bar shows for a satellite status.
 *
 * A host that is not RUNNING leaves the tray at `idle` rather than painting an
 * error glyph: on every desktop without a microphone binding the satellite is
 * permanently degraded, and a red icon in the menu bar for a feature the user
 * never turned on is noise, not information. The diagnosis lives in the tooltip
 * and in Settings → Voice, which is where someone looking for it will look.
 */
function trayStateForSatellite(status: SatelliteStatus): TrayState {
  if (status.state !== 'running') return 'idle';
  switch (status.capture) {
    case 'listening':
    case 'idle':
    case 'capturing':
      return 'listening';
    case 'thinking':
      return 'thinking';
    case 'speaking':
      return 'botActive';
    default:
      return 'muted';
  }
}

function activateDesktop(): void {
  if (desktopActivated) return;
  desktopActivated = true;
  if (getConnectionMode() !== 'remote') {
    startBackend(3001);
  }
  trayInstance = createTray(() => mainWindow, createWindow);
  // Seeded from the PERSISTED switch before the host has published anything, so
  // the tooltip cannot claim "listening" for the moment between tray creation
  // and the first status — the honesty criterion applies to that moment too.
  setWakeTray({ wakeEnabled: store.get('wakeEnabled', true), phrases: [] }, toggleWake);

  onSatelliteStatus((status) => {
    const tray = trayInstance;
    if (tray && !tray.isDestroyed()) {
      setTrayState(tray, trayStateForSatellite(status));
    }
    setWakeTray(
      {
        wakeEnabled: status.wakeEnabled,
        phrases: status.phrases,
        // A reason is only a "not listening" reason when the host is not
        // listening; a degraded transition the machine recovered from is not.
        ...(status.state === 'running' || status.reason === undefined
          ? {}
          : { detail: status.reason }),
      },
      toggleWake,
    );
    const win = mainWindow;
    if (win && !win.isDestroyed()) {
      win.webContents.send('satellite:stateChanged', status);
    }
  });

  startSatellite().catch((err: unknown) => {
    // startSatellite never rejects; this is the last line of the "must not
    // crash the app" guarantee rather than an expected path.
    console.error('[ethos] satellite host failed to start:', err);
  });

  if (mainWindow && !mainWindow.isDestroyed()) {
    registerGlobalShortcuts(mainWindow, showQuickChat);
  }
}

function buildSplashHtml(): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0F0F0F; display: flex; flex-direction: column;
    align-items: center; justify-content: center; height: 100vh;
    font-family: 'Geist', system-ui, sans-serif; -webkit-app-region: drag;
  }
  .logo { color: #E8E8E6; font-size: 24px; font-weight: 600; margin-bottom: 24px; }
  .track { width: 120px; height: 2px; background: #333; border-radius: 1px; overflow: hidden; }
  .bar {
    width: 40%; height: 100%; background: #94A3B8; border-radius: 1px;
    animation: slide 1.2s ease-in-out infinite;
  }
  @keyframes slide { 0% { transform: translateX(-100%); } 100% { transform: translateX(350%); } }
</style></head><body>
  <div class="logo">ethos</div>
  <div class="track"><div class="bar"></div></div>
</body></html>`;
}

async function createWindow(): Promise<void> {
  const bounds = store.get('windowBounds');
  const isOnboarding = needsLocalOnboarding();

  mainWindow = new BrowserWindow({
    width: isOnboarding ? 800 : (bounds?.width ?? 1200),
    height: isOnboarding ? 560 : (bounds?.height ?? 800),
    x: bounds?.x,
    y: bounds?.y,
    resizable: !isOnboarding,
    show: false,
    webPreferences: {
      preload: join(__dirname, '..', 'preload', 'index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const splashHtml = buildSplashHtml();
  try {
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(splashHtml)}`);
  } catch (err) {
    console.error('[ethos] splash screen failed to load, continuing without it:', err);
  }
  mainWindow.show();

  mainWindow.on('close', (event: { preventDefault(): void }) => {
    if (isQuitting) return;
    if (needsLocalOnboarding()) return; // allow close during onboarding
    event.preventDefault();
    const b = mainWindow?.getBounds();
    if (b) store.set('windowBounds', b);
    if (process.platform === 'darwin') {
      app.hide();
    } else {
      mainWindow?.hide();
    }
    if (trayInstance) showMinimizeNotification(trayInstance);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const isDark = nativeTheme.shouldUseDarkColors;
  if (!store.get('theme')) {
    store.set('theme', isDark ? 'dark' : 'light');
  }

  if (getConnectionMode() === 'remote') {
    wireRemoteRecovery(mainWindow);
    await loadRemoteUrl(mainWindow);
  } else {
    const port = store.get('backendPort', 3001);
    const actualPort = await startBackendWithRetry(port);
    store.set('backendPort', actualPort);
    await loadSpaUrl(mainWindow, actualPort);
  }

  registerQuickChatIpc(mainWindow);
  if (desktopActivated) {
    registerGlobalShortcuts(mainWindow, showQuickChat);
  }
}

app
  .whenReady()
  .then(async () => {
    // Seed dataDir from --dir CLI arg (takes precedence; saved for subsequent launches)
    const dirFlagIdx = process.argv.indexOf('--dir');
    if (dirFlagIdx !== -1 && process.argv[dirFlagIdx + 1]) {
      store.set('dataDir', process.argv[dirFlagIdx + 1]);
    }

    registerIpcHandlers();

    // Asked once, before anything boots, so choosing remote never starts a local
    // backend. An unset `connectionMode` is the only trigger.
    if (!isConfigured()) {
      const choice = await showConnectionWindow();
      if (!choice) {
        app.quit();
        return;
      }
      await persistConnectionChoice(choice);
    }

    await applyRemoteAuthCookie();

    registerProtocolHandler({
      getMainWindow: () => mainWindow,
      onPluginOAuthCallback: async ({ pluginId, oauthRef, requestToken }) => {
        try {
          await fetch(`${resolveBackendBaseUrl()}/rpc/plugins/completeOAuth`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Origin: resolveBackendBaseUrl() },
            body: JSON.stringify({ json: { pluginId, oauthRef, requestToken } }),
          });
        } catch {
          // fail-open: OAuth completion errors are surfaced via panel refresh
        }
        const win = mainWindow;
        if (win && !win.isDestroyed()) {
          win.webContents.send('plugin:oauthComplete', { oauthRef });
        }
      },
    });

    setupSpaCsp();

    const hidden = isBackgroundMode();

    if (hidden && !needsLocalOnboarding()) {
      logBackgroundStartup();
      activateDesktop();
    } else {
      await createWindow();
      if (!needsLocalOnboarding()) {
        activateDesktop();
      }
    }

    (app as unknown as EventEmitter).on('ethos:onboarding-complete', () => {
      // Defence in depth: local onboarding must never boot a local backend the
      // user declined by pointing this app at a remote server.
      if (getConnectionMode() === 'remote') return;
      activateDesktop();
      if (mainWindow && !mainWindow.isDestroyed()) {
        const port = store.get('backendPort', 3001);
        restartBackendAsync(port)
          .then((actualPort) => {
            store.set('backendPort', actualPort);
            if (mainWindow && !mainWindow.isDestroyed()) {
              loadSpaUrl(mainWindow, actualPort);
            }
          })
          .catch((err: unknown) => {
            console.error('[ethos] failed to restart backend after onboarding:', err);
          });
      }
    });

    if (process.env.NODE_ENV !== 'development') {
      initAutoUpdater();
    }

    nativeTheme.on('updated', () => {
      if (store.get('theme') === 'system') {
        const resolved = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
        mainWindow?.webContents.send('theme:changed', resolved);
      }
    });

    app.on('activate', () => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow().catch((err: unknown) => {
          console.error('[ethos] failed to create window on activate:', err);
        });
      }
    });
  })
  .catch((err: unknown) => {
    console.error('[ethos] fatal error during startup:', err);
    app.quit();
  });

app.on('window-all-closed', () => {
  if (!desktopActivated) {
    stopBackend();
    app.quit();
  }
  // After activation, tray keeps app alive
});

app.on('before-quit', () => {
  isQuitting = true;
  void stopSatellite();
  stopBackend();
  unregisterGlobalShortcuts();
  destroyTray();
});
