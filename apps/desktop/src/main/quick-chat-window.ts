import { join } from 'node:path';
import { BrowserWindow, ipcMain, screen } from 'electron';
import { resolveBackendBaseUrl } from './connection';

let quickChatWindow: BrowserWindow | null = null;

function getQuickChatPosition(width: number, height: number): { x: number; y: number } {
  const display = screen.getPrimaryDisplay();
  const workArea = display.workArea;
  const bounds = display.bounds;

  if (process.platform === 'darwin') {
    // Below menu bar, horizontally centered
    const x = Math.round(workArea.x + (workArea.width - width) / 2);
    const y = workArea.y;
    return { x, y };
  }

  if (process.platform === 'win32') {
    // Above taskbar, horizontally centered
    const x = Math.round(bounds.x + (bounds.width - width) / 2);
    const taskbarHeight = bounds.height - workArea.height - (workArea.y - bounds.y);
    const y = bounds.y + bounds.height - taskbarHeight - height;
    return { x, y };
  }

  // Linux: center of screen
  const x = Math.round(workArea.x + (workArea.width - width) / 2);
  const y = Math.round(workArea.y + (workArea.height - height) / 2);
  return { x, y };
}

function createQuickChatWindow(): BrowserWindow {
  const width = 480;
  const height = 300;
  const { x, y } = getQuickChatPosition(width, height);

  const isMac = process.platform === 'darwin';

  const win = new BrowserWindow({
    width,
    height,
    x,
    y,
    frame: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    show: false,
    ...(isMac ? { vibrancy: 'hud' as const } : { transparent: true, backgroundColor: '#00000000' }),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: join(__dirname, '..', 'preload', 'index.js'),
    },
  });

  win.loadURL(`${resolveBackendBaseUrl()}?mode=quickchat`);

  win.on('blur', () => {
    win.hide();
  });

  return win;
}

export function showQuickChat(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    if (quickChatWindow.isVisible()) {
      quickChatWindow.focus();
      return;
    }

    const { x, y } = getQuickChatPosition(480, 300);
    quickChatWindow.setPosition(x, y);
    quickChatWindow.show();
    return;
  }

  quickChatWindow = createQuickChatWindow();
  quickChatWindow.once('ready-to-show', () => {
    quickChatWindow?.show();
  });

  quickChatWindow.on('closed', () => {
    quickChatWindow = null;
  });
}

export function hideQuickChat(): void {
  if (quickChatWindow && !quickChatWindow.isDestroyed()) {
    quickChatWindow.hide();
  }
}

export function registerQuickChatIpc(mainWindow: BrowserWindow): void {
  ipcMain.on('quick-chat:close', () => {
    hideQuickChat();
  });

  ipcMain.on('quick-chat:open-in-main', () => {
    mainWindow.show();
    mainWindow.focus();
    hideQuickChat();
  });
}
