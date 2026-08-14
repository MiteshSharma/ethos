import path from 'node:path';
import type { BrowserWindow, NativeImage } from 'electron';
import { app, Menu, nativeImage, systemPreferences, Tray } from 'electron';
import {
  checkForUpdates,
  getPendingUpdateVersion,
  onUpdateReady,
  quitAndInstall,
} from './auto-update';

function getIconDir(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'assets', 'tray');
  }
  return path.join(app.getAppPath(), 'assets', 'tray');
}

function iconPath(baseName: string): string {
  const dir = getIconDir();
  if (process.platform === 'darwin') {
    return path.join(dir, `${baseName}Template.png`);
  }
  return path.join(dir, `${baseName}.png`);
}

const icons = {
  idle: () => nativeImage.createFromPath(iconPath('Idle')),
  botActive: () => nativeImage.createFromPath(iconPath('Active')),
  error: () => nativeImage.createFromPath(iconPath('Error')),
  // NO DEDICATED WAKE ICONS SHIP YET. `assets/tray/` holds Idle, Active, Error
  // and the 16 Thinking frames — nothing else. Rather than invent binary assets
  // in a code lane, the two wake states borrow the closest existing glyph and
  // carry their real meaning in the tooltip and the context menu, which say
  // "Listening for …" / "Wake word off" in words. Swap these two lines the day
  // a Listening/Muted glyph lands; nothing else changes.
  listening: () => nativeImage.createFromPath(iconPath('Active')),
  muted: () => nativeImage.createFromPath(iconPath('Idle')),
  thinking: (frame: number): NativeImage => {
    const padded = String(frame).padStart(2, '0');
    return nativeImage.createFromPath(path.join(getIconDir(), `Thinking${padded}.png`));
  },
};

let tray: Tray | null = null;
let thinkingTimer: ReturnType<typeof setInterval> | null = null;

export type TrayState = 'idle' | 'botActive' | 'error' | 'thinking' | 'listening' | 'muted';

function clearThinkingTimer(): void {
  if (thinkingTimer !== null) {
    clearInterval(thinkingTimer);
    thinkingTimer = null;
  }
}

/**
 * DR5. The animated tray state is a pulse like any other, and the OS already
 * knows whether this user wants pulses. `getAnimationSettings()` is the API that
 * answers (Electron ≥ 12); it is read at each transition rather than cached
 * because the preference can change while the app is running.
 *
 * Fails OPEN — on an Electron build that does not expose it, we animate. A
 * missing accessibility signal is not consent to assume the strictest setting;
 * the visible-but-unwanted animation is the recoverable error, and the user can
 * still turn the whole tray animation off at the OS level.
 */
function prefersReducedMotion(): boolean {
  try {
    return systemPreferences.getAnimationSettings?.().prefersReducedMotion === true;
  } catch {
    return false;
  }
}

export function setTrayState(trayInstance: Tray, state: TrayState): void {
  clearThinkingTimer();

  if (state === 'thinking') {
    trayInstance.setImage(icons.thinking(0));
    if (prefersReducedMotion()) return;
    let frame = 0;
    thinkingTimer = setInterval(() => {
      frame = (frame + 1) % 16;
      trayInstance.setImage(icons.thinking(frame));
    }, 100);
    return;
  }

  trayInstance.setImage(icons[state]());
}

let cachedGetWindow: (() => BrowserWindow | null) | null = null;
let cachedEnsureWindow: (() => void) | null = null;

/** What the tray knows about wake. Mirrors the persisted state, never infers it. */
export interface WakeTrayState {
  wakeEnabled: boolean;
  /** Enabled phrases from the gateway's pushed routing table. */
  phrases: readonly string[];
  /** Why the host is not listening, when it is not. */
  detail?: string;
}

/** Beyond this the tooltip is a wall of text rather than a reminder. */
const TOOLTIP_PHRASE_LIMIT = 4;

let wakeState: WakeTrayState = { wakeEnabled: true, phrases: [] };
let wakeToggleHandler: ((enabled: boolean) => void) | null = null;

/**
 * DR2 — the tray says on hover what the room answers to. Exported for tests and
 * kept pure: no Electron, no module state.
 */
export function formatWakeTooltip(state: WakeTrayState): string {
  if (!state.wakeEnabled) return 'Ethos — wake word off';
  if (state.detail !== undefined) return `Ethos — not listening: ${state.detail}`;
  if (state.phrases.length === 0) {
    return 'Ethos — every personality answers to “hey <name>”';
  }
  const shown = state.phrases.slice(0, TOOLTIP_PHRASE_LIMIT).map((p) => `“${p}”`);
  const rest = state.phrases.length - shown.length;
  const suffix = rest > 0 ? `, +${rest} more` : '';
  return `Ethos — listening for ${shown.join(', ')}${suffix}`;
}

/**
 * Push the wake state into the tray: tooltip on hover, toggle in the menu.
 * `onToggle` is re-registered each call so the caller stays the only owner of
 * what "toggle" means (persist, then restart the host).
 */
export function setWakeTray(state: WakeTrayState, onToggle?: (enabled: boolean) => void): void {
  wakeState = state;
  if (onToggle) wakeToggleHandler = onToggle;
  if (!tray) return;
  tray.setToolTip(formatWakeTooltip(state));
  rebuildTrayMenu();
}

function buildContextMenu(): Menu {
  const getWindow = cachedGetWindow;
  const ensureWindow = cachedEnsureWindow;

  function showWindow(): void {
    const win = getWindow?.();
    if (win && !win.isDestroyed()) {
      win.show();
      win.focus();
    } else {
      ensureWindow?.();
    }
  }

  const pendingVersion = getPendingUpdateVersion();

  const updateItem = pendingVersion
    ? {
        label: `Restart to update to v${pendingVersion}`,
        click: () => {
          quitAndInstall();
        },
      }
    : {
        label: 'Check for updates',
        click: () => {
          checkForUpdates();
        },
      };

  const wakeItem = {
    label: wakeState.wakeEnabled ? 'Disable wake word' : 'Enable wake word',
    click: () => {
      wakeToggleHandler?.(!wakeState.wakeEnabled);
    },
  };

  return Menu.buildFromTemplate([
    {
      label: 'Open Ethos',
      click: showWindow,
    },
    { type: 'separator' },
    wakeItem,
    { type: 'separator' },
    updateItem,
    { type: 'separator' },
    {
      label: 'Quit Ethos',
      click: () => {
        app.quit();
      },
    },
  ]);
}

export function rebuildTrayMenu(): void {
  if (tray) {
    tray.setContextMenu(buildContextMenu());
  }
}

export function createTray(getWindow: () => BrowserWindow | null, ensureWindow: () => void): Tray {
  if (tray) {
    return tray;
  }

  cachedGetWindow = getWindow;
  cachedEnsureWindow = ensureWindow;

  tray = new Tray(icons.idle());
  tray.setToolTip(formatWakeTooltip(wakeState));

  tray.setContextMenu(buildContextMenu());

  onUpdateReady(() => {
    rebuildTrayMenu();
  });

  if (process.platform === 'darwin') {
    tray.on('click', () => {
      const win = getWindow();
      if (win && !win.isDestroyed()) {
        win.show();
        win.focus();
      } else {
        ensureWindow();
      }
    });
  }

  return tray;
}

export function destroyTray(): void {
  clearThinkingTimer();
  if (tray) {
    tray.destroy();
    tray = null;
  }
}
