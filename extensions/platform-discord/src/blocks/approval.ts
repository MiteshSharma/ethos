import { redactJson, redactString } from '@ethosagent/safety-redact';
import {
  actionRow,
  button,
  type DiscordActionRow,
  type DiscordEmbed,
  embed,
  escapeMarkdown,
  truncate,
} from './shared';

export const APPROVE_CUSTOM_ID_PREFIX = 'ethos:approve:';
export const DENY_CUSTOM_ID_PREFIX = 'ethos:deny:';

const ARGS_PREVIEW_MAX = 2500;

export interface ApprovalPendingInput {
  approvalId: string;
  toolName: string;
  reason: string | null;
  args: unknown;
}

export function approvalPendingEmbed(input: ApprovalPendingInput): DiscordEmbed {
  const desc = [`\`${escapeMarkdown(input.toolName)}\` wants to run.`];
  if (input.reason) {
    desc.push(`**Why:** ${escapeMarkdown(input.reason)}`);
  }
  desc.push(`\`\`\`json\n${formatArgs(input.args)}\n\`\`\``);
  return embed({ title: 'Approval Required', description: truncate(desc.join('\n\n'), 4096) });
}

export function approvalPendingButtons(approvalId: string): DiscordActionRow {
  return actionRow(
    button('Allow', `${APPROVE_CUSTOM_ID_PREFIX}${approvalId}`, 3),
    button('Deny', `${DENY_CUSTOM_ID_PREFIX}${approvalId}`, 4),
  );
}

export interface ApprovalResolvedInput {
  toolName: string;
  decision: 'allow' | 'deny';
  decidedBy: string;
}

export function approvalResolvedEmbed(input: ApprovalResolvedInput): DiscordEmbed {
  const verb = input.decision === 'allow' ? 'Approved' : 'Denied';
  return embed({
    title: verb,
    description: `\`${escapeMarkdown(input.toolName)}\` — ${verb.toLowerCase()} by ${escapeMarkdown(input.decidedBy)}`,
  });
}

/**
 * Redact credentials, JSON-stringify args, neutralize any code-fence
 * breakout, then cap the length.
 *
 * Two independent threats, handled in this order:
 *
 * 1. **Credential disclosure.** This embed is the one place the adapter
 *    renders tool args in full rather than summarized, and it lands in a
 *    guild channel every member can read, with Discord's retention. A gated
 *    `terminal` or `web_fetch` call can carry a bearer token or a DSN, so
 *    args go through Tier 0 `@ethosagent/safety-redact` first. Redaction runs
 *    on the values *before* `JSON.stringify`, not on its output: the
 *    generic-secret pattern anchors on a string boundary, which JSON quoting
 *    would hide.
 * 2. **Code-fence breakout.** A literal ```` ``` ```` inside args would close
 *    the fence the caller wraps this in, letting the rest of the args render
 *    as live Discord markup on a privileged approval surface. Runs of three
 *    or more backticks are broken up with a zero-width space — the text reads
 *    the same, but no substring can be parsed as a fence delimiter.
 *
 * Redaction is a leak-reducer, not a boundary (G-RED): a credential in a
 * shape the pattern set does not know still reaches the channel.
 */
function formatArgs(args: unknown): string {
  let text: string;
  if (args === null || args === undefined) {
    text = '(no arguments)';
  } else if (typeof args === 'string') {
    text = redactString(args);
  } else {
    try {
      // `args` is non-null here, so `typeof 'object'` means object or array —
      // both of which `redactJson` walks. Inside the `try` because a circular
      // arg would otherwise overflow the stack outside the stringify guard.
      const safe = typeof args === 'object' ? redactJson(args as Record<string, unknown>) : args;
      text = JSON.stringify(safe, null, 2);
    } catch {
      text = redactString(String(args));
    }
  }
  text = text.replace(/`{3,}/g, (run) => run.split('').join('​'));
  if (text.length > ARGS_PREVIEW_MAX) {
    return `${text.slice(0, ARGS_PREVIEW_MAX)}\n… (truncated)`;
  }
  return text;
}
