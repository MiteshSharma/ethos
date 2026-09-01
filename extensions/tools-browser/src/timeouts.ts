// ---------------------------------------------------------------------------
// Playwright timeout budgets, resolved once at tool-construction time
// ---------------------------------------------------------------------------

/** Budget for one page load (`goto` / `goBack`). */
export const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
/** Budget for one element interaction (`click`). */
export const DEFAULT_COMMAND_TIMEOUT_MS = 10_000;

/**
 * The two budgets every browser tool passes to Playwright. Resolved once by
 * `createBrowserTools` and captured by each tool's closure, so a tool never
 * reads config at execute time.
 */
export interface BrowserTimeouts {
  navigationMs: number;
  commandMs: number;
}

/**
 * Fill in the defaults these call sites hardcoded before they became
 * configurable — an absent option must not change behaviour.
 */
export function resolveBrowserTimeouts(opts?: {
  navigationTimeoutMs?: number;
  commandTimeoutMs?: number;
}): BrowserTimeouts {
  return {
    navigationMs: opts?.navigationTimeoutMs ?? DEFAULT_NAVIGATION_TIMEOUT_MS,
    commandMs: opts?.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS,
  };
}
