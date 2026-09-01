import { lookup } from 'node:dns/promises';
import { validateUrl } from '@ethosagent/safety-network';
import { checkSsrf } from '@ethosagent/tools-web';
import type { Tool, ToolResult } from '@ethosagent/types';
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
import { createBrowserVisionClickTool } from './browser-vision-click';
import { createBrowserVisionTypeTool } from './browser-vision-type';
import { getOrCreateSessionWithRoute } from './session-route';
import { closeSession, findActiveSession, isPlaywrightInstalled } from './sessions';
import { snapshotPage } from './snapshot';
import { type BrowserTimeouts, resolveBrowserTimeouts } from './timeouts';

async function resolveHost(host: string): Promise<string[]> {
  const records = await lookup(host, { all: true });
  return records.map((r) => r.address);
}

// ---------------------------------------------------------------------------
// browse_url
// ---------------------------------------------------------------------------

function createBrowseUrlTool(timeouts: BrowserTimeouts): Tool {
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

      try {
        // Session is keyed by (sessionId, policy fingerprint). A policy
        // change tears down and rebuilds the BrowserContext so the page-
        // route handler is fresh and serviceWorkers stay blocked. New
        // sessions install the route on a context-level handler before
        // any page navigation.
        const session = await getOrCreateSessionWithRoute(ctx.sessionId, policy);

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
          await session.page.goto(url, {
            waitUntil: wait_for,
            timeout: timeouts.navigationMs,
          });
          session.lastUrl = url;

          const { text, refs, title } = await snapshotPage(session.page);
          session.refs = refs;

          const refSummary =
            refs.size > 0
              ? `\n\nInteractive elements (${refs.size}): ${[...refs.keys()].join(', ')}`
              : '';

          const header = `[${title}] ${url}\n\n`;
          return { ok: true, value: header + text + refSummary };
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

      const ref = session.refs.get(element_ref);
      if (!ref) {
        return {
          ok: false,
          error: `Unknown element ref '${element_ref}'. Available: ${[...session.refs.keys()].join(', ') || 'none'}`,
          code: 'input_invalid',
        };
      }

      try {
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

      const ref = session.refs.get(element_ref);
      if (!ref) {
        return {
          ok: false,
          error: `Unknown element ref '${element_ref}'. Available: ${[...session.refs.keys()].join(', ') || 'none'}`,
          code: 'input_invalid',
        };
      }

      try {
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
}

export function createBrowserTools(opts?: BrowserToolsOptions): Tool[] {
  const visionOpts = {
    apiKey: opts?.visionApiKey,
    provider: opts?.visionProvider,
    model: opts?.visionModel,
  };
  const timeouts = resolveBrowserTimeouts(opts);
  return [
    createBrowseUrlTool(timeouts),
    createBrowserClickTool(timeouts),
    createBrowserTypeTool(timeouts),
    browserPressTool,
    browserScrollTool,
    createBrowserBackTool(timeouts),
    browserConsoleTool,
    browserGetImagesTool,
    browserDialogTool,
    createBrowserNavigateTool(timeouts),
    browserScreenshotTool,
    createBrowserVisionClickTool(visionOpts, timeouts),
    createBrowserVisionTypeTool(visionOpts, timeouts),
  ];
}

export type { A11yRef, A11yResult, RawA11yNode } from './a11y';
export { buildA11yTree, parseAriaSnapshot } from './a11y';
export { getOrCreateSessionWithRoute } from './session-route';
export { closeAllSessions } from './sessions';
export { snapshotPage } from './snapshot';
