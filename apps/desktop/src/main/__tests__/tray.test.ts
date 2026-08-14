import type { Tray } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createdImages: string[] = [];
let reducedMotion = false;
const menuTemplates: Array<Array<{ label?: string; type?: string; click?: () => void }>> = [];

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => '/app',
    quit: vi.fn(),
  },
  nativeImage: {
    createFromPath: (p: string) => {
      createdImages.push(p);
      return { path: p };
    },
  },
  systemPreferences: {
    getAnimationSettings: () => ({ prefersReducedMotion: reducedMotion }),
  },
  Menu: {
    buildFromTemplate: (template: Array<{ label?: string; type?: string; click?: () => void }>) => {
      menuTemplates.push(template);
      return { template };
    },
  },
  Tray: class {},
}));

// The tray module pulls in auto-update for its "restart to update" item.
vi.mock('../auto-update', () => ({
  checkForUpdates: vi.fn(),
  getPendingUpdateVersion: () => null,
  onUpdateReady: vi.fn(),
  quitAndInstall: vi.fn(),
}));

import { formatWakeTooltip, setTrayState } from '../tray';

function fakeTray(): Tray & { images: string[] } {
  const images: string[] = [];
  return {
    images,
    setImage: (image: unknown) => {
      images.push((image as { path: string }).path);
    },
  } as unknown as Tray & { images: string[] };
}

beforeEach(() => {
  createdImages.length = 0;
  menuTemplates.length = 0;
  reducedMotion = false;
  vi.useFakeTimers();
});

afterEach(() => {
  // Leaves no interval behind for the next test to inherit.
  setTrayState(fakeTray(), 'idle');
  vi.useRealTimers();
});

describe('setTrayState', () => {
  it('sets the listening image', () => {
    const tray = fakeTray();
    setTrayState(tray, 'listening');
    // No dedicated Listening glyph ships yet — `listening` deliberately borrows
    // the Active icon and carries its meaning in the tooltip.
    expect(tray.images).toEqual([expect.stringContaining('Active')]);
  });

  it('sets the muted image', () => {
    const tray = fakeTray();
    setTrayState(tray, 'muted');
    expect(tray.images).toEqual([expect.stringContaining('Idle')]);
  });

  it('animates the thinking state when motion is allowed', () => {
    const tray = fakeTray();
    setTrayState(tray, 'thinking');
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(300);
    expect(tray.images.length).toBeGreaterThan(1);
  });

  it('DR5 — creates no interval when prefers-reduced-motion is on', () => {
    reducedMotion = true;
    const tray = fakeTray();
    setTrayState(tray, 'thinking');

    expect(vi.getTimerCount()).toBe(0);
    // Still shows the state, as a single static frame.
    expect(tray.images).toEqual([expect.stringContaining('Thinking00')]);
    vi.advanceTimersByTime(1000);
    expect(tray.images).toHaveLength(1);
  });

  it('clears a running animation when the state changes', () => {
    const tray = fakeTray();
    setTrayState(tray, 'thinking');
    expect(vi.getTimerCount()).toBe(1);
    setTrayState(tray, 'listening');
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('formatWakeTooltip', () => {
  it('names the configured phrases (DR2)', () => {
    const tooltip = formatWakeTooltip({
      wakeEnabled: true,
      phrases: ['hey engineer', 'hey swing trader'],
    });
    expect(tooltip).toContain('hey engineer');
    expect(tooltip).toContain('hey swing trader');
  });

  it('falls back to the default statement when no routes are configured', () => {
    const tooltip = formatWakeTooltip({ wakeEnabled: true, phrases: [] });
    expect(tooltip).toContain('hey <name>');
  });

  it('says wake is off rather than implying it is listening', () => {
    const tooltip = formatWakeTooltip({ wakeEnabled: false, phrases: ['hey engineer'] });
    expect(tooltip).toBe('Ethos — wake word off');
    expect(tooltip).not.toContain('listening');
  });

  it('surfaces the failing probe when the host is not listening', () => {
    const tooltip = formatWakeTooltip({
      wakeEnabled: true,
      phrases: [],
      detail: 'no capture device configured',
    });
    expect(tooltip).toContain('no capture device configured');
  });

  it('caps the phrase list rather than growing without bound', () => {
    const tooltip = formatWakeTooltip({
      wakeEnabled: true,
      phrases: ['one', 'two', 'three', 'four', 'five', 'six'],
    });
    expect(tooltip).toContain('+2 more');
    expect(tooltip).not.toContain('“five”');
  });
});
