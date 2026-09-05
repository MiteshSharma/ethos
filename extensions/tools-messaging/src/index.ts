import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

/**
 * Every platform `send_message` can address. Single source of truth: the
 * schema enum the model sees and the rejection message a bad call gets are
 * both derived from it, so the two can never disagree about what is supported.
 */
export const SEND_MESSAGE_PLATFORMS = [
  'slack',
  'telegram',
  'discord',
  'whatsapp',
  'email',
] as const;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type MessagingSendFn = (
  platform: string,
  target: string,
  body: string,
  botKey?: string,
) => Promise<{
  ok: boolean;
  error?: string;
}>;

export interface MessagingToolsOptions {
  send: MessagingSendFn;
  getAllowedTargets?: (personalityId?: string) => string[] | null;
}

// ---------------------------------------------------------------------------
// Tool factory
// ---------------------------------------------------------------------------

export function createMessagingTools(opts: MessagingToolsOptions): Tool[] {
  return [makeSendMessage(opts)];
}

// ---------------------------------------------------------------------------
// send_message
// ---------------------------------------------------------------------------

function makeSendMessage(opts: MessagingToolsOptions): Tool {
  return {
    name: 'send_message',
    description:
      'Send a message to a configured channel — Slack, Telegram, Discord, WhatsApp, or email. ' +
      'Use this whenever the user asks you to post / send / forward / relay something to another channel; ' +
      'do not refuse for permission reasons unless the tool itself returns an error. ' +
      'If the target is outside the operator-configured allowlist the call fails with a clear message that you should surface verbatim.',
    toolset: 'messaging',
    maxResultChars: 1024,
    capabilities: {},
    schema: {
      type: 'object',
      properties: {
        platform: {
          type: 'string',
          enum: [...SEND_MESSAGE_PLATFORMS],
          description: 'Target platform',
        },
        target: {
          type: 'string',
          description:
            'Target identifier (channel ID, chat ID, user ID, WhatsApp JID, or email address)',
        },
        body: {
          type: 'string',
          description: 'Message content (supports markdown on platforms that allow it)',
        },
      },
      required: ['platform', 'target', 'body'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      return await executeSendMessage(args as SendMessageArgs, ctx, opts);
    },
  };
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface SendMessageArgs {
  platform: string;
  target: string;
  body: string;
}

// ---------------------------------------------------------------------------
// execute()
// ---------------------------------------------------------------------------

async function executeSendMessage(
  args: SendMessageArgs,
  ctx: ToolContext,
  opts: MessagingToolsOptions,
): Promise<ToolResult> {
  const { platform, target, body } = args;

  if (!platform || !target || !body) {
    return { ok: false, error: 'platform, target, and body are required', code: 'input_invalid' };
  }

  if (!(SEND_MESSAGE_PLATFORMS as readonly string[]).includes(platform)) {
    return {
      ok: false,
      error: `Unknown platform "${platform}". Supported platforms: ${SEND_MESSAGE_PLATFORMS.join(', ')}.`,
      code: 'input_invalid',
    };
  }

  // Check allowed targets.
  if (opts.getAllowedTargets) {
    const allowed = opts.getAllowedTargets(ctx.personalityId);
    if (allowed !== null) {
      const targetKey = `${platform}:${target}`;
      if (!allowed.includes(targetKey) && !allowed.includes('*')) {
        return {
          ok: false,
          error: `Target "${targetKey}" is not in the personality's allowed messaging targets. Allowed: ${allowed.join(', ') || 'none'}`,
          code: 'input_invalid',
        };
      }
    }
  }

  try {
    const result = await opts.send(platform, target, body);
    if (!result.ok) {
      return { ok: false, error: result.error ?? 'Send failed', code: 'execution_failed' };
    }
    return { ok: true, value: `Message sent to ${platform}:${target}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      code: 'execution_failed',
    };
  }
}
