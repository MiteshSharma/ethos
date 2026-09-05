// ---------------------------------------------------------------------------
// browser_screenshot tool
// ---------------------------------------------------------------------------

import type { Tool, ToolResult } from '@ethosagent/types';
import {
  acquireAgentLease,
  findActiveSession,
  isPlaywrightInstalled,
  takeoverRefusalResult,
} from './sessions';

export const browserScreenshotTool: Tool = {
  name: 'browser_screenshot',
  description: 'Take a screenshot of the current browser page. Returns base64-encoded JPEG.',
  toolset: 'browser',
  maxResultChars: 75_000,
  capabilities: {
    network: { allowedHosts: ['*'] }, // browser navigates agent-supplied URLs
    process: { allowedBinaries: ['docker'] },
  },
  isAvailable: isPlaywrightInstalled,
  schema: { type: 'object', properties: {}, required: [] },
  async execute(_, ctx): Promise<ToolResult> {
    const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
    if (!session) {
      return {
        ok: false,
        error:
          'No active browser session under the current network policy. Call browse_url first (a personality / network policy switch tears down prior sessions).',
        code: 'execution_failed',
      };
    }
    // Shared lease for the WHOLE screenshot, not just up to the first await —
    // a takeover starting mid-capture waits for it rather than racing it.
    const release = acquireAgentLease(ctx.sessionId, session);
    if (!release) return takeoverRefusalResult();

    try {
      const screenshot = await session.page.screenshot({ type: 'jpeg', quality: 60 });
      const b64 = screenshot.toString('base64');
      if (b64.length > 70_000) {
        return {
          ok: false,
          error: `Screenshot too large (${Math.round(b64.length / 1024)}KB base64). The per-call budget is 75KB. Try reducing the viewport or page complexity.`,
          code: 'execution_failed',
        };
      }
      const viewport = session.page.viewportSize() ?? { width: 1280, height: 720 };
      return {
        ok: true,
        value: JSON.stringify({
          image_base64: b64,
          dimensions: viewport,
          url: session.lastUrl,
        }),
      };
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
