// ---------------------------------------------------------------------------
// browser_vision_click tool
// ---------------------------------------------------------------------------

import type { Tool, ToolResult } from '@ethosagent/types';
import { findActiveSession, isPlaywrightInstalled } from './sessions';
import type { BrowserTimeouts } from './timeouts';
import type { VisionResolverOptions } from './vision-resolver';
import { resolveByA11y, resolveByVision } from './vision-resolver';

export function createBrowserVisionClickTool(
  visionOpts: VisionResolverOptions,
  timeouts: BrowserTimeouts,
): Tool {
  return {
    name: 'browser_vision_click',
    description:
      'Click an element described in natural language. Uses accessibility tree first, falls back to vision model.',
    toolset: 'browser',
    maxResultChars: 500,
    capabilities: {
      network: { allowedHosts: ['*'] }, // browser navigates agent-supplied URLs
      process: { allowedBinaries: ['docker'] },
    },
    isAvailable: isPlaywrightInstalled,
    schema: {
      type: 'object',
      properties: {
        description: {
          type: 'string',
          description: 'Natural language description of the element to click',
        },
        context: {
          type: 'string',
          description: 'Optional context, e.g. "in the top nav"',
        },
      },
      required: ['description'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { description, context } = args as { description: string; context?: string };

      if (!description) {
        return { ok: false, error: 'description is required', code: 'input_invalid' };
      }

      const session = findActiveSession(ctx.sessionId, ctx.networkPolicy ?? {});
      if (!session) {
        return {
          ok: false,
          error:
            'No active browser session under the current network policy. Call browse_url first.',
          code: 'execution_failed',
        };
      }

      try {
        // 1. Try a11y snapshot first
        const yaml = await session.page.locator('body').ariaSnapshot();
        const matchedName = resolveByA11y(yaml, description);

        if (matchedName) {
          await session.page
            .getByText(matchedName, { exact: false })
            .first()
            .click({ timeout: timeouts.commandMs });
          return {
            ok: true,
            value: JSON.stringify({
              clicked: true,
              element_description: matchedName,
              strategy: 'a11y',
            }),
          };
        }

        // 2. Fall back to vision if apiKey available
        if (visionOpts.apiKey) {
          const screenshot = await session.page.screenshot({ type: 'png' });
          const b64 = screenshot.toString('base64');
          const visionResult = await resolveByVision(b64, description, context, visionOpts);

          if (visionResult) {
            await session.page.mouse.click(visionResult.x, visionResult.y);
            return {
              ok: true,
              cost_usd: visionResult.cost_usd,
              value: JSON.stringify({
                clicked: true,
                element_description: description,
                strategy: 'vision',
              }),
            };
          }

          // Both a11y and vision failed
          return {
            ok: true,
            value: JSON.stringify({
              clicked: false,
              element_description: 'no match',
              strategy: 'failed',
            }),
          };
        }

        // No apiKey — a11y only mode
        return {
          ok: true,
          value: JSON.stringify({
            clicked: false,
            element_description: 'no match',
            strategy: 'a11y_only',
          }),
        };
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
