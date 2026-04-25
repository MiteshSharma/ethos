import { checkSsrf } from '@ethosagent/tools-web';
import type { Tool, ToolResult } from '@ethosagent/types';
import type { Browser, Page } from 'playwright';
import { type A11yRef, parseAriaSnapshot } from './a11y';

// ---------------------------------------------------------------------------
// Availability check (synchronous — just checks package presence)
// ---------------------------------------------------------------------------

function isPlaywrightInstalled(): boolean {
  try {
    // import.meta.resolve is synchronous in Node 22+ and throws if not found
    import.meta.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Session management: one browser + page per sessionId
// ---------------------------------------------------------------------------

interface BrowserSession {
  browser: Browser;
  page: Page;
  refs: Map<string, A11yRef>;
  lastUrl: string;
}

const sessions = new Map<string, BrowserSession>();

async function getChromium() {
  const { chromium } = await import('playwright');
  return chromium;
}

async function getOrCreateSession(sessionId: string): Promise<BrowserSession> {
  const existing = sessions.get(sessionId);
  if (existing) return existing;

  const chromium = await getChromium();
  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'],
  });
  const page = await browser.newPage();

  const session: BrowserSession = { browser, page, refs: new Map(), lastUrl: '' };
  sessions.set(sessionId, session);
  return session;
}

async function closeSession(sessionId: string): Promise<void> {
  const s = sessions.get(sessionId);
  if (!s) return;
  sessions.delete(sessionId);
  await s.browser.close().catch(() => {});
}

// Cleanup all sessions on process exit
process.on('SIGTERM', () => {
  for (const s of sessions.values()) {
    s.browser.close().catch(() => {});
  }
  sessions.clear();
});

// ---------------------------------------------------------------------------
// Take an accessibility snapshot and format it
// ---------------------------------------------------------------------------

async function snapshotPage(
  page: Page,
): Promise<{ text: string; refs: Map<string, A11yRef>; title: string; url: string }> {
  const title = await page.title();
  const url = page.url();

  // page.locator('body').ariaSnapshot() is the Playwright 1.44+ recommended API.
  // It returns a YAML string; parseAriaSnapshot injects @e{n} refs.
  const yaml = await page.locator('body').ariaSnapshot();
  const { text, refs } = parseAriaSnapshot(yaml);

  return { text, refs, title, url };
}

// ---------------------------------------------------------------------------
// browse_url
// ---------------------------------------------------------------------------

const browseUrlTool: Tool = {
  name: 'browse_url',
  description:
    'Navigate a browser to a URL and return an accessibility tree with @e{n} element references. Use browser_click and browser_type to interact with elements.',
  toolset: 'browser',
  maxResultChars: 20_000,
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
      return { ok: false, error: 'Only http and https URLs are supported', code: 'input_invalid' };
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
      const session = await getOrCreateSession(ctx.sessionId);
      await session.page.goto(url, {
        waitUntil: wait_for,
        timeout: 30_000,
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

// ---------------------------------------------------------------------------
// browser_click
// ---------------------------------------------------------------------------

const browserClickTool: Tool = {
  name: 'browser_click',
  description:
    'Click an element in the browser identified by its @e{n} reference from browse_url. Returns the updated page accessibility tree.',
  toolset: 'browser',
  maxResultChars: 20_000,
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

    if (!element_ref) return { ok: false, error: 'element_ref is required', code: 'input_invalid' };

    const session = sessions.get(ctx.sessionId);
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
        .click({ timeout: 10_000 });

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

// ---------------------------------------------------------------------------
// browser_type
// ---------------------------------------------------------------------------

const browserTypeTool: Tool = {
  name: 'browser_type',
  description:
    'Type text into an input element identified by its @e{n} reference. Use browse_url first to get element refs.',
  toolset: 'browser',
  maxResultChars: 20_000,
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

    if (!element_ref) return { ok: false, error: 'element_ref is required', code: 'input_invalid' };
    if (text === undefined) return { ok: false, error: 'text is required', code: 'input_invalid' };

    const session = sessions.get(ctx.sessionId);
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
      await locator.click({ timeout: 10_000 });
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBrowserTools(): Tool[] {
  return [browseUrlTool, browserClickTool, browserTypeTool];
}

export type { A11yRef, A11yResult, RawA11yNode } from './a11y';
export { buildA11yTree, parseAriaSnapshot } from './a11y';
