// ---------------------------------------------------------------------------
// browser_vision_type tool
// ---------------------------------------------------------------------------

import type { Tool, ToolResult } from '@ethosagent/types';
import {
  acquireAgentLease,
  findActiveSession,
  isPlaywrightInstalled,
  takeoverRefusalResult,
} from './sessions';
import type { BrowserTimeouts } from './timeouts';
import type { VisionResolverOptions } from './vision-resolver';
import { resolveByA11y, resolveByVision } from './vision-resolver';

export function createBrowserVisionTypeTool(
  visionOpts: VisionResolverOptions,
  timeouts: BrowserTimeouts,
): Tool {
  return {
    name: 'browser_vision_type',
    description:
      'Type text into an element described in natural language. Uses accessibility tree first, falls back to vision model.',
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
          description: 'Natural language description of the element to type into',
        },
        text: {
          type: 'string',
          description: 'Text to type',
        },
        submit: {
          type: 'boolean',
          description: 'Press Enter after typing (default false)',
        },
      },
      required: ['description', 'text'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const {
        description,
        text,
        submit = false,
      } = args as {
        description: string;
        text: string;
        submit?: boolean;
      };

      if (!description) {
        return { ok: false, error: 'description is required', code: 'input_invalid' };
      }
      if (text === undefined) {
        return { ok: false, error: 'text is required', code: 'input_invalid' };
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
      // The vision path runs an LLM call between reading the page and acting
      // on it — the widest check-then-act window of any browser tool, and the
      // reason the lease spans the whole operation rather than the first await.
      const release = acquireAgentLease(ctx.sessionId, session);
      if (!release) return takeoverRefusalResult();

      try {
        // 1. Try a11y snapshot first
        const yaml = await session.page.locator('body').ariaSnapshot();
        const matchedName = resolveByA11y(yaml, description);

        if (matchedName) {
          await session.page
            .getByText(matchedName, { exact: false })
            .first()
            .click({ timeout: timeouts.commandMs });
          await session.page.keyboard.type(text);
          if (submit) {
            await session.page.keyboard.press('Enter');
          }
          return {
            ok: true,
            value: JSON.stringify({
              typed: true,
              strategy: 'a11y',
            }),
          };
        }

        // 2. Fall back to vision if apiKey available
        if (visionOpts.apiKey) {
          const screenshot = await session.page.screenshot({ type: 'png' });
          const b64 = screenshot.toString('base64');
          const visionResult = await resolveByVision(b64, description, undefined, visionOpts);

          if (visionResult) {
            await session.page.mouse.click(visionResult.x, visionResult.y);
            await session.page.keyboard.type(text);
            if (submit) {
              await session.page.keyboard.press('Enter');
            }
            return {
              ok: true,
              cost_usd: visionResult.cost_usd,
              value: JSON.stringify({
                typed: true,
                strategy: 'vision',
              }),
            };
          }

          // Both a11y and vision failed
          return {
            ok: true,
            value: JSON.stringify({
              typed: false,
              strategy: 'failed',
            }),
          };
        }

        // No apiKey — a11y only mode
        return {
          ok: true,
          value: JSON.stringify({
            typed: false,
            strategy: 'a11y_only',
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
}
