// Block Kit builders for the tool-approval card. Pure functions — no Slack
// client, no I/O. The adapter posts `approvalPendingBlocks(...)` when a
// dangerous tool call is gated, then `chat.update`s the same message with
// `approvalResolvedBlocks(...)` once the user clicks Allow / Deny (or another
// surface resolves it). The buttons carry the `approvalId` in their `value`
// so the interaction handler can correlate the click back to the pending
// approval without parsing anything out of the message itself.

import { redactJson, redactString } from '@ethosagent/safety-redact';
import { context, escapeMrkdwn, header, type SlackBlock, section } from './shared';

/** `action_id` for the Allow button. The interaction handler matches on this. */
export const APPROVE_ACTION_ID = 'ethos_approval_allow';
/** `action_id` for the Deny button. */
export const DENY_ACTION_ID = 'ethos_approval_deny';

/** Slack section `text` caps at 3000 chars — keep the args preview well under. */
const ARGS_PREVIEW_MAX = 2500;

/**
 * Slack user / bot ids start with `U` or `W` followed by uppercase
 * alphanumerics. Anything else (a `'system'` resolution, a malformed
 * interaction payload, a test fake) must NOT be interpolated into a
 * `<@...>` mention — this is a privileged approval surface, so an
 * unvalidated id is a message-injection vector.
 */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

/** Render a decider as a safe mention, or a plain label when it isn't a
 *  recognizable Slack user id. */
function renderDecider(decidedBy: string): string {
  return SLACK_USER_ID.test(decidedBy) ? `<@${decidedBy}>` : 'the system';
}

// `escapeMrkdwn` (from `./shared`) hardens the inline-text fields on this card —
// every string here except Slack-typed literals is model/config-influenced
// (`toolName` from the registry, `reason` from the danger predicate). `args` is
// hardened separately by `formatArgs` below (it needs code-fence handling too).

export interface ApprovalPendingInput {
  approvalId: string;
  toolName: string;
  /** Human-readable cause, or null when the danger predicate gave none. */
  reason: string | null;
  args: unknown;
}

export function approvalPendingBlocks(input: ApprovalPendingInput): SlackBlock[] {
  const blocks: SlackBlock[] = [
    header('Approval required'),
    section(`\`${escapeMrkdwn(input.toolName)}\` wants to run.`),
  ];
  if (input.reason) {
    blocks.push(section(`*Why:* ${escapeMrkdwn(input.reason)}`));
  }
  blocks.push(section(`\`\`\`${formatArgs(input.args)}\`\`\``));
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        action_id: APPROVE_ACTION_ID,
        text: { type: 'plain_text', text: 'Allow', emoji: true },
        style: 'primary',
        value: input.approvalId,
      },
      {
        type: 'button',
        action_id: DENY_ACTION_ID,
        text: { type: 'plain_text', text: 'Deny', emoji: true },
        style: 'danger',
        value: input.approvalId,
      },
    ],
  });
  return blocks;
}

export interface ApprovalResolvedInput {
  toolName: string;
  decision: 'allow' | 'deny';
  /** Slack user id of whoever resolved it. */
  decidedBy: string;
}

export function approvalResolvedBlocks(input: ApprovalResolvedInput): SlackBlock[] {
  const verb = input.decision === 'allow' ? 'Approved' : 'Denied';
  return [
    section(`${verb}: \`${escapeMrkdwn(input.toolName)}\``),
    context([`${verb.toLowerCase()} by ${renderDecider(input.decidedBy)}`]),
  ];
}

/**
 * Redact credentials, JSON-stringify args, falling back gracefully,
 * neutralize any code-fence breakout, then cap the length.
 *
 * Two independent threats, handled in this order:
 *
 * 1. **Credential disclosure.** This card is the one place either adapter
 *    renders tool args in full rather than summarized, and it lands in a
 *    channel every member can read, with the platform's retention. A gated
 *    `terminal` or `web_fetch` call can carry a bearer token or a DSN, so
 *    args go through Tier 0 `@ethosagent/safety-redact` first. Redaction runs
 *    on the values *before* `JSON.stringify`, not on its output: the
 *    generic-secret pattern anchors on a string boundary, which JSON quoting
 *    would hide.
 * 2. **Code-fence breakout.** A literal ```` ``` ```` inside args would close
 *    the mrkdwn fence the caller wraps this in, letting the rest of the args
 *    render as live Slack markup (mentions, links) on a privileged approval
 *    surface. Slack mrkdwn has no in-fence escape, so we break up runs of
 *    backticks with a zero-width space — the text reads the same, but no
 *    substring can be parsed as a fence delimiter.
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
  // Insert a zero-width space between consecutive backticks.
  text = text.replace(/`+/g, (run) => run.split('').join('​'));
  if (text.length > ARGS_PREVIEW_MAX) {
    return `${text.slice(0, ARGS_PREVIEW_MAX)}\n… (truncated)`;
  }
  return text;
}
