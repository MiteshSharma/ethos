import { lookup } from 'node:dns/promises';
import type { ClarifyBridge } from '@ethosagent/core';
import { validateUrl } from '@ethosagent/safety-network';
import { checkSsrf } from '@ethosagent/tools-web';
import type { Tool, ToolResult } from '@ethosagent/types';
import type { CDPSession, Page } from 'playwright';
import { describeBlock, detectBlock } from './block-detector';
import {
  browserConsoleTool,
  browserDialogTool,
  browserGetImagesTool,
  browserPressTool,
  browserScrollTool,
  createBrowserBackTool,
  createBrowserNavigateTool,
} from './browser-actions';
import { browserScreenshotTool } from './browser-screenshot';
import { createBrowserTakeoverTool } from './browser-takeover';
import { createBrowserVisionClickTool } from './browser-vision-click';
import { createBrowserVisionTypeTool } from './browser-vision-type';
import { type BrowserLaunchConfig, buildLaunchOptions } from './launch-options';
import {
  acquireAgentLease,
  closeSession,
  findActiveSession,
  getOrCreateSessionWithRoute,
  isPlaywrightInstalled,
  onTakeoverSettled,
  sessions,
  takeoverRefusalResult,
} from './sessions';
import { snapshotPage } from './snapshot';
import { type BrowserTimeouts, resolveBrowserTimeouts } from './timeouts';

async function resolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

// ---------------------------------------------------------------------------
// browse_url
// ---------------------------------------------------------------------------

function createBrowseUrlTool(
  timeouts: BrowserTimeouts,
  launchCfg: BrowserLaunchConfig,
  escalationTool?: string,
): Tool {
  return {
    name: 'browse_url',
    description:
      'Navigate a browser to a URL and return an accessibility tree with @e{n} element references. Use browser_click and browser_type to interact with elements.',
    toolset: 'browser',
    maxResultChars: 20_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // browser navigates agent-supplied URLs
      process: { allowedBinaries: ['docker'] },
    },
    outputIsUntrusted: true,
    isAvailable: isPlaywrightInstalled,
    schema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
        wait_for: {
          type: 'string',
          enum: ['load', 'domcontentloaded', 'networkidle'],
          description: 'Wait condition (default: domcontentloaded)',
        },
      },
      required: ['url'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { url, wait_for = 'domcontentloaded' } = args as {
        url: string;
        wait_for?: 'load' | 'domcontentloaded' | 'networkidle';
      };

      if (!url) return { ok: false, error: 'url is required', code: 'input_invalid' };

      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return { ok: false, error: `Invalid URL: ${url}`, code: 'input_invalid' };
      }

      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return {
          ok: false,
          error: 'Only http and https URLs are supported',
          code: 'input_invalid',
        };
      }

      // Ch.7 — initial-URL gate. The page.route interceptor below enforces
      // the SAME policy on every redirect target and subresource fetched
      // by Playwright, so the network boundary covers the full navigation
      // (not just `page.goto`'s first request).
      const policy = ctx.networkPolicy ?? {};
      const policyCheck = await validateUrl(url, policy, resolveHost);
      if (!policyCheck.ok) {
        return { ok: false, error: policyCheck.reason ?? 'blocked', code: 'execution_failed' };
      }
      const ssrf = await checkSsrf(url);
      if (ssrf.blocked) {
        return { ok: false, error: ssrf.reason, code: 'execution_failed' };
      }

      if (!isPlaywrightInstalled()) {
        return {
          ok: false,
          error: 'Playwright is not installed. Run: npx playwright install chromium',
          code: 'not_available',
        };
      }

      // Declared out here so the `finally` below covers the failure path too:
      // that `catch` calls `closeSession`, which is cleanup, and cleanup is
      // part of the operation the lease has to span.
      let release: (() => void) | null = null;
      try {
        // Session is keyed by (sessionId, policy fingerprint). A policy
        // change tears down and rebuilds the BrowserContext so the page-
        // route handler is fresh and serviceWorkers stay blocked. New
        // sessions install the route on a context-level handler before
        // any page navigation.
        const session = await getOrCreateSessionWithRoute(
          ctx.sessionId,
          policy,
          buildLaunchOptions(launchCfg, ctx.personalityId),
        );

        // The lease is taken AFTER the session exists — creation lock outside,
        // lease strictly inside, never the reverse (see sessions.ts). It is
        // held for the goto, the snapshot and the cleanup below, so a takeover
        // that starts mid-navigation waits for this call to finish instead of
        // sharing the page with it.
        release = acquireAgentLease(ctx.sessionId, session);
        if (!release) return takeoverRefusalResult();

        // If the caller aborts mid-navigation, close the session so the
        // headless Chromium instance doesn't leak.
        if (ctx.abortSignal.aborted) {
          await closeSession(ctx.sessionId);
          return { ok: false, error: 'Aborted', code: 'execution_failed' };
        }
        const abortHandler = () => {
          closeSession(ctx.sessionId);
        };
        ctx.abortSignal.addEventListener('abort', abortHandler, { once: true });

        try {
          const response = await session.page.goto(url, {
            waitUntil: wait_for,
            timeout: timeouts.navigationMs,
          });
          session.lastUrl = url;

          const { text, refs, title } = await snapshotPage(session.page);
          session.refs = refs;

          // One-shot launch notices (no-display fallback, profile in use).
          const notices = session.pendingWarnings.splice(0).map((w) => `⚠ ${w}`);

          // T4 — a bot wall answers with a real page, so Playwright reports
          // success and the snapshot above is an interstitial. Report the
          // block; never retry, never escalate on the agent's behalf.
          const blocked = detectBlock({
            ...(response ? { status: response.status(), headers: response.headers() } : {}),
            title,
            text,
          });
          if (blocked) {
            return {
              ok: false,
              error: [...notices, describeBlock(url, blocked, escalationTool)].join('\n'),
              code: 'execution_failed',
            };
          }

          const refSummary =
            refs.size > 0
              ? `\n\nInteractive elements (${refs.size}): ${[...refs.keys()].join(', ')}`
              : '';

          const header = `[${title}] ${url}\n\n`;
          const noticeBlock = notices.length > 0 ? `${notices.join('\n')}\n\n` : '';
          return { ok: true, value: noticeBlock + header + text + refSummary };
        } finally {
          ctx.abortSignal.removeEventListener('abort', abortHandler);
        }
      } catch (err) {
        await closeSession(ctx.sessionId);
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      } finally {
        release?.();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// browser_click
// ---------------------------------------------------------------------------

function createBrowserClickTool(timeouts: BrowserTimeouts): Tool {
  return {
    name: 'browser_click',
    description:
      'Click an element in the browser identified by its @e{n} reference from browse_url. Returns the updated page accessibility tree.',
    toolset: 'browser',
    maxResultChars: 20_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // browser navigates agent-supplied URLs
      process: { allowedBinaries: ['docker'] },
    },
    isAvailable: isPlaywrightInstalled,
    schema: {
      type: 'object',
      properties: {
        element_ref: {
          type: 'string',
          description: 'Element reference like @e1, @e2, etc.',
        },
      },
      required: ['element_ref'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { element_ref } = args as { element_ref: string };

      if (!element_ref)
        return { ok: false, error: 'element_ref is required', code: 'input_invalid' };

      const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
      if (!session) {
        return {
          ok: false,
          error: 'No active browser session. Call browse_url first.',
          code: 'execution_failed',
        };
      }
      const release = acquireAgentLease(ctx.sessionId, session);
      if (!release) return takeoverRefusalResult();

      try {
        const ref = session.refs.get(element_ref);
        if (!ref) {
          return {
            ok: false,
            error: `Unknown element ref '${element_ref}'. Available: ${[...session.refs.keys()].join(', ') || 'none'}`,
            code: 'input_invalid',
          };
        }

        await session.page
          // biome-ignore lint/suspicious/noExplicitAny: playwright AriaRole type
          .getByRole(ref.role as any, { name: ref.name })
          .first()
          .click({ timeout: timeouts.commandMs });

        // Wait briefly for navigation/re-render
        await session.page.waitForTimeout(500);

        const { text, refs, title, url } = await snapshotPage(session.page);
        session.refs = refs;
        session.lastUrl = url;

        const header = `[${title}] ${url}\n\n`;
        return { ok: true, value: header + text };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      } finally {
        release();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// browser_type
// ---------------------------------------------------------------------------

function createBrowserTypeTool(timeouts: BrowserTimeouts): Tool {
  return {
    name: 'browser_type',
    description:
      'Type text into an input element identified by its @e{n} reference. Use browse_url first to get element refs.',
    toolset: 'browser',
    maxResultChars: 20_000,
    capabilities: {
      network: { allowedHosts: ['*'] }, // browser navigates agent-supplied URLs
      process: { allowedBinaries: ['docker'] },
    },
    isAvailable: isPlaywrightInstalled,
    schema: {
      type: 'object',
      properties: {
        element_ref: {
          type: 'string',
          description: 'Element reference like @e1, @e2, etc.',
        },
        text: {
          type: 'string',
          description: 'Text to type',
        },
        press_enter: {
          type: 'boolean',
          description: 'Press Enter after typing (default false)',
        },
      },
      required: ['element_ref', 'text'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const {
        element_ref,
        text,
        press_enter = false,
      } = args as {
        element_ref: string;
        text: string;
        press_enter?: boolean;
      };

      if (!element_ref)
        return { ok: false, error: 'element_ref is required', code: 'input_invalid' };
      if (text === undefined)
        return { ok: false, error: 'text is required', code: 'input_invalid' };

      const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
      if (!session) {
        return {
          ok: false,
          error: 'No active browser session. Call browse_url first.',
          code: 'execution_failed',
        };
      }
      const release = acquireAgentLease(ctx.sessionId, session);
      if (!release) return takeoverRefusalResult();

      try {
        const ref = session.refs.get(element_ref);
        if (!ref) {
          return {
            ok: false,
            error: `Unknown element ref '${element_ref}'. Available: ${[...session.refs.keys()].join(', ') || 'none'}`,
            code: 'input_invalid',
          };
        }

        // biome-ignore lint/suspicious/noExplicitAny: playwright AriaRole type
        const locator = session.page.getByRole(ref.role as any, { name: ref.name }).first();
        await locator.click({ timeout: timeouts.commandMs });
        await locator.fill(text);

        if (press_enter) {
          await locator.press('Enter');
          await session.page.waitForTimeout(500);
        }

        const { text: treeText, refs, title, url } = await snapshotPage(session.page);
        session.refs = refs;
        session.lastUrl = url;

        const header = `[${title}] ${url}\n\n`;
        return { ok: true, value: header + treeText };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          code: 'execution_failed',
        };
      } finally {
        release();
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface BrowserToolsOptions {
  visionApiKey?: string;
  visionProvider?: string;
  visionModel?: string;
  /** Budget for one page load, ms. Default 30_000 — the previous literal. */
  navigationTimeoutMs?: number;
  /** Budget for one element interaction, ms. Default 10_000 — as before. */
  commandTimeoutMs?: number;
  /**
   * `browser.headed`, verbatim. `'auto'` (and absent) resolves here — headed
   * where a display exists, headless otherwise.
   */
  headed?: boolean | 'auto';
  /** `browser.proxy.*` — applied at launch to every session. */
  proxy?: { server: string; username?: string; password?: string };
  /** `browser.profiles.enabled` — persistent per-personality profiles (D4). */
  profilesEnabled?: boolean;
  /** Root for those profiles. Wiring passes `<dataDir>/browser-profiles`. */
  profilesDir?: string;
  /** `browser.idleTimeoutMs` — sweep budget for an untouched session. */
  idleTimeoutMs?: number;
  /**
   * Wiring's `ClarifyBridge`. Present → `browser_request_takeover` is
   * registered and the bot-wall hint names it. Absent → neither happens: a
   * deployment with no interactive surface has nobody to hand a browser to,
   * and a hint naming an unregistered tool is worse than one naming none.
   */
  clarifyBridge?: ClarifyBridge;
}

export function createBrowserTools(opts?: BrowserToolsOptions): Tool[] {
  const visionOpts = {
    apiKey: opts?.visionApiKey,
    provider: opts?.visionProvider,
    model: opts?.visionModel,
  };
  const timeouts = resolveBrowserTimeouts(opts);
  const launchCfg: BrowserLaunchConfig = {
    ...(opts?.headed !== undefined ? { headed: opts.headed } : {}),
    ...(opts?.proxy ? { proxy: opts.proxy } : {}),
    ...(opts?.profilesEnabled !== undefined ? { profilesEnabled: opts.profilesEnabled } : {}),
    ...(opts?.profilesDir !== undefined ? { profilesDir: opts.profilesDir } : {}),
  };
  // The block hint may only name a tool this process actually registers.
  // `as Tool` for the same reason `createInteractiveTools` needs it: a
  // `Tool<TakeoverArgs>` is not assignable to the registry's `Tool<unknown>`
  // (execute's parameter is contravariant), and the args are `unknown` at the
  // registry boundary anyway.
  const takeoverTool = opts?.clarifyBridge
    ? (createBrowserTakeoverTool(opts.clarifyBridge) as Tool)
    : undefined;
  const escalationTool = takeoverTool?.name;
  return [
    createBrowseUrlTool(timeouts, launchCfg, escalationTool),
    createBrowserClickTool(timeouts),
    createBrowserTypeTool(timeouts),
    browserPressTool,
    browserScrollTool,
    createBrowserBackTool(timeouts),
    browserConsoleTool,
    browserGetImagesTool,
    browserDialogTool,
    createBrowserNavigateTool(timeouts, launchCfg, escalationTool),
    browserScreenshotTool,
    createBrowserVisionClickTool(visionOpts, timeouts),
    createBrowserVisionTypeTool(visionOpts, timeouts),
    ...(takeoverTool ? [takeoverTool] : []),
  ];
}

// ---------------------------------------------------------------------------
// Takeover session registry (B3)
// ---------------------------------------------------------------------------

/**
 * One browser session as the screencast takeover socket
 * (`apps/web-api/src/browser/takeover-socket.ts`) needs it.
 *
 * Reads go through getters on purpose. The socket resolves a target ONCE, on
 * `hello`, and then keeps reading `page` and `takeover` off it for the life of
 * the lane; a snapshot taken at lookup time would pin the page an in-place
 * relaunch (D5) has since replaced, and would report a lock that has since
 * been released as still held.
 */
export interface BrowserTakeoverTarget {
  readonly page: Page;
  newCDPSession(): Promise<CDPSession>;
  readonly takeover: { requestId?: string } | undefined;
}

/** Structurally the socket's `TakeoverSessionRegistry`, without the import. */
export interface BrowserTakeoverRegistry {
  find(sessionId: string): BrowserTakeoverTarget | null;
  /**
   * Watch for takeovers ending, so a live lane is CLOSED rather than left to
   * notice on its next frame. Returns an unsubscribe. See `onTakeoverSettled`.
   */
  onSettled(listener: (sessionId: string, requestId: string) => void): () => void;
}

/**
 * Hand the screencast socket THE SESSION `browser_request_takeover` LOCKED.
 *
 * Deliberately NOT `findActiveSession(sessionId, policy)`: that lookup is keyed
 * by (sessionId, network policy), and a policy change tears a session down and
 * builds a replacement — so a re-lookup can answer with a different browser
 * than the one the agent handed over. The takeover tool captures a session
 * reference for exactly that reason, and this registry has to reach the same
 * object. The scan over the map's internal key format lives here rather than
 * at a composition root because that format is `sessions.ts`'s business.
 *
 * At most one session exists per `sessionId` while a takeover is live:
 * `getOrCreateSession` returns a locked session as-is instead of replacing it.
 *
 * Only sessions in THIS process are reachable, which is the whole reason the
 * socket takes this as an injected seam — an `ethos gateway` deployment opens
 * its Chromium elsewhere and gets an honest `session_unavailable` instead.
 */
export function createBrowserTakeoverRegistry(): BrowserTakeoverRegistry {
  return {
    find(sessionId: string): BrowserTakeoverTarget | null {
      for (const [key, session] of sessions) {
        if (key !== sessionId && !key.startsWith(`${sessionId}::`)) continue;
        return {
          get page() {
            return session.page;
          },
          get takeover() {
            return session.takeover;
          },
          newCDPSession: () => session.context.newCDPSession(session.page),
        };
      }
      return null;
    },
    onSettled: onTakeoverSettled,
  };
}

export type { A11yRef, A11yResult, RawA11yNode } from './a11y';
export { buildA11yTree, parseAriaSnapshot } from './a11y';
export { type BlockSignal, describeBlock, detectBlock } from './block-detector';
export { createBrowserTakeoverTool } from './browser-takeover';
export {
  type BrowserLaunchConfig,
  buildLaunchOptions,
  hasDisplay,
  resolveHeadless,
} from './launch-options';
export {
  closeAllSessions,
  getOrCreateSessionWithRoute,
  startIdleSweeper,
  takeoverRefusal,
} from './sessions';
export { snapshotPage } from './snapshot';
