// ---------------------------------------------------------------------------
// Operator launch config → SessionLaunchOptions (T3)
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import type { SessionLaunchOptions } from './sessions';

export interface BrowserLaunchConfig {
  /**
   * `browser.headed`, carried verbatim from config — `'auto'` is resolved
   * HERE, because answering it needs an environment probe config cannot do
   * without rewriting the operator's file per machine.
   */
  headed?: boolean | 'auto';
  proxy?: { server: string; username?: string; password?: string };
  /** `browser.profiles.enabled`. */
  profilesEnabled?: boolean;
  /** Root for persistent profiles — `<dataDir>/browser-profiles`. */
  profilesDir?: string;
}

/**
 * A personality id becomes a directory name under `profilesDir`, so it is
 * checked rather than trusted: a marketplace personality whose id carries a
 * `/` or `..` would otherwise plant a Chromium user-data directory anywhere on
 * the machine. Same character class as `SECRET_NAME_RE`.
 */
const PROFILE_KEY_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Whether this machine can put a window on a screen. macOS and Windows always
 * can; on Linux/BSD a session bus with no `DISPLAY`/`WAYLAND_DISPLAY` is a
 * headless server, and asking Chromium for a window there fails at launch.
 */
export function hasDisplay(
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): boolean {
  if (platform === 'darwin' || platform === 'win32') return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}

export interface HeadlessResolution {
  headless: boolean;
  /**
   * Set only when the operator asked for `true` and the machine cannot honour
   * it. `'auto'` resolving to headless is the answer they asked for, not a
   * fallback, so it warns about nothing.
   */
  warning?: string;
}

/** Default when `browser.headed` is absent — the plan's `auto`. */
export function resolveHeadless(
  headed: boolean | 'auto' | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): HeadlessResolution {
  if (headed === false) return { headless: true };

  const display = hasDisplay(env, platform);
  if (headed === undefined || headed === 'auto') return { headless: !display };

  if (display) return { headless: false };
  return {
    headless: true,
    warning:
      'browser.headed: true, but this machine has no display (no DISPLAY or WAYLAND_DISPLAY) — running headless.',
  };
}

/**
 * Build the launch options for a new session. Profiles are per personality
 * (D4): one directory per id, so a login survives `/new` and every later
 * session under that personality.
 */
export function buildLaunchOptions(
  cfg: BrowserLaunchConfig = {},
  personalityId?: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: string = process.platform,
): SessionLaunchOptions {
  const { headless, warning } = resolveHeadless(cfg.headed, env, platform);
  const useProfile =
    cfg.profilesEnabled === true &&
    cfg.profilesDir !== undefined &&
    personalityId !== undefined &&
    PROFILE_KEY_RE.test(personalityId);

  return {
    headless,
    ...(warning !== undefined ? { launchWarning: warning } : {}),
    ...(cfg.proxy ? { proxy: cfg.proxy } : {}),
    ...(useProfile && cfg.profilesDir && personalityId
      ? { profile: { key: personalityId, dir: join(cfg.profilesDir, personalityId) } }
      : {}),
  };
}
