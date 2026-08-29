// Block Kit builders for the clarify card. Mirrors `blocks/approval.ts` —
// pure functions, no Slack client, no I/O. The Slack clarify surface posts
// `clarifyPendingBlocks(...)` when the agent calls the `clarify` tool, then
// `chat.update`s the same message with `clarifyResolvedBlocks(...)` once the
// user answers, the timeout fires, or the user cancels. Buttons carry the
// `requestId` (and choice index, when present) in their `value` so the
// interaction handler can correlate clicks back to the pending row without
// parsing anything out of the message itself. See plan/phases/tool_clarity_plan.md
// Surface 5.

import type { ClarifyResponseSource, PendingClarify } from '@ethosagent/types';
import { context, escapeMrkdwn, header, type SlackBlock, section, truncate } from './shared';

/** `action_id` for an option button (one of the multiple-choice options). The
 *  button `value` is `<requestId>:<choiceIndex>`. */
export const CLARIFY_CHOICE_ACTION_ID = 'ethos_clarify_choice';
/** `action_id` for the Cancel button. The button `value` is `<requestId>`. */
export const CLARIFY_CANCEL_ACTION_ID = 'ethos_clarify_cancel';
/** `action_id` for the "Answer" button on free-form clarifies. Opens a modal.
 *  The button `value` is `<requestId>`. */
export const CLARIFY_ANSWER_ACTION_ID = 'ethos_clarify_answer';
/** `callback_id` for the free-form modal `views.open` payload. The modal's
 *  `private_metadata` carries the `<requestId>` JSON-encoded so the
 *  `view_submission` handler can correlate without trusting the user's input. */
export const CLARIFY_MODAL_CALLBACK_ID = 'ethos_clarify_modal';
/** `block_id` for the modal's `plain_text_input` block. Used to find the
 *  user's answer inside the `view.state.values` payload. */
export const CLARIFY_MODAL_INPUT_BLOCK_ID = 'ethos_clarify_modal_input';
/** `action_id` for the modal input element inside its block. */
export const CLARIFY_MODAL_INPUT_ACTION_ID = 'ethos_clarify_modal_value';

/**
 * Slack user / bot ids start with `U` or `W` followed by uppercase
 * alphanumerics. Anything else (a `'system'` resolution, a malformed
 * payload, a test fake) must NOT be interpolated into a `<@…>` mention —
 * see the same guard on the approval card.
 */
const SLACK_USER_ID = /^[UW][A-Z0-9]{2,}$/;

function renderUser(userId: string): string {
  return SLACK_USER_ID.test(userId) ? `<@${userId}>` : 'someone';
}

// Slack `section.text` caps at 3000 chars; option buttons cap their text
// at 75 chars. Cap the inputs once at the boundary and let everything
// downstream just read the truncated values.
const QUESTION_MAX = 2500;
const OPTION_LABEL_MAX = 75;
const DEFAULT_LABEL_MAX = 200;
const ANSWER_TEXT_MAX = 2500;

export interface ClarifyPendingInput {
  requestId: string;
  question: string;
  options?: string[];
  default?: string;
  /** ISO 8601 — shown in the context line so the user knows when default fires. */
  defaultDeadlineAt: string;
}

export function clarifyPendingBlocks(input: ClarifyPendingInput): SlackBlock[] {
  const blocks: SlackBlock[] = [
    header('Question'),
    section(escapeMrkdwn(truncate(input.question, QUESTION_MAX))),
  ];

  const options = (input.options ?? []).filter((o) => o.length > 0);
  if (options.length > 0) {
    // Slack actions blocks cap at 25 elements. We need to fit option buttons
    // plus the Cancel button — cap options at 24 to leave room. In practice
    // a clarify with >24 options is a misuse anyway.
    const capped = options.slice(0, 24);
    const elements: unknown[] = capped.map((label, idx) => ({
      type: 'button',
      action_id: CLARIFY_CHOICE_ACTION_ID,
      text: {
        type: 'plain_text',
        text: truncate(escapeMrkdwn(label), OPTION_LABEL_MAX),
        emoji: true,
      },
      value: `${input.requestId}:${idx}`,
    }));
    elements.push({
      type: 'button',
      action_id: CLARIFY_CANCEL_ACTION_ID,
      text: { type: 'plain_text', text: 'Cancel', emoji: true },
      style: 'danger',
      value: input.requestId,
    });
    blocks.push({ type: 'actions', elements });
  } else {
    // Free-form: Answer (opens modal) + Cancel.
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          action_id: CLARIFY_ANSWER_ACTION_ID,
          text: { type: 'plain_text', text: 'Answer', emoji: true },
          style: 'primary',
          value: input.requestId,
        },
        {
          type: 'button',
          action_id: CLARIFY_CANCEL_ACTION_ID,
          text: { type: 'plain_text', text: 'Cancel', emoji: true },
          style: 'danger',
          value: input.requestId,
        },
      ],
    });
  }

  // Context line — what the default is and when it fires. Visible-default
  // semantics per plan Q9 (transparency).
  const ctx: string[] = [];
  if (input.default !== undefined) {
    ctx.push(
      `default at <!date^${epoch(input.defaultDeadlineAt)}^{time}|${escapeMrkdwn(input.defaultDeadlineAt)}>: \`${escapeMrkdwn(truncate(input.default, DEFAULT_LABEL_MAX))}\``,
    );
  } else {
    ctx.push(
      `no default — answer by <!date^${epoch(input.defaultDeadlineAt)}^{time}|${escapeMrkdwn(input.defaultDeadlineAt)}> or cancel`,
    );
  }
  blocks.push(context(ctx));

  return blocks;
}

export interface ClarifyResolvedInput {
  question: string;
  /** The chosen / submitted / default value. Empty for cancel and timeout-no-default. */
  answer: string;
  source: ClarifyResponseSource;
  /** Slack user id of whoever answered, when `source === 'user'`. Else absent. */
  answeredBy?: string;
}

export function clarifyResolvedBlocks(input: ClarifyResolvedInput): SlackBlock[] {
  const question = section(`*Question:* ${escapeMrkdwn(truncate(input.question, QUESTION_MAX))}`);
  const blocks: SlackBlock[] = [question];

  switch (input.source) {
    case 'user': {
      blocks.push(section(`*Answer:* ${escapeMrkdwn(truncate(input.answer, ANSWER_TEXT_MAX))}`));
      if (input.answeredBy) {
        blocks.push(context([`answered by ${renderUser(input.answeredBy)}`]));
      }
      break;
    }
    case 'timeout-default':
      blocks.push(
        section(
          `_(timed out — used default \`${escapeMrkdwn(truncate(input.answer, ANSWER_TEXT_MAX))}\`)_`,
        ),
      );
      break;
    case 'timeout-no-default':
      blocks.push(section('_(timed out — no default)_'));
      break;
    case 'cancel':
      blocks.push(section('_(cancelled)_'));
      break;
  }
  return blocks;
}

/** Builders for the App Home "Waiting on you" entry. One pending row per
 *  bot session is rendered as a section + buttons; the section is omitted
 *  entirely when there are no pending rows. */
export function clarifyHomeEntryBlocks(row: PendingClarify): SlackBlock[] {
  // Reuse the pending builder so the home tab and the channel card stay in
  // sync — same buttons, same value encoding, same caps. `listPendingForBot`
  // only ever returns rows that were actually presented (a still-queued row
  // has no `surfaceContext.botKey` yet, so it's filtered out there) — the
  // `?? row.createdAt` fallback is defensive only, for the type.
  return clarifyPendingBlocks({
    requestId: row.requestId,
    question: row.question,
    options: row.options,
    default: row.default,
    defaultDeadlineAt: row.defaultDeadlineAt ?? row.createdAt,
  });
}

/** Build the modal payload for a free-form clarify. Slack `views.open`
 *  expects a `view` object; this returns it. `private_metadata` carries the
 *  requestId so the `view_submission` handler can correlate without trusting
 *  the user's input. */
export interface ClarifyModalInput {
  requestId: string;
  question: string;
  default?: string;
}

export function clarifyModalView(input: ClarifyModalInput): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: CLARIFY_MODAL_CALLBACK_ID,
    private_metadata: JSON.stringify({ requestId: input.requestId }),
    title: { type: 'plain_text', text: 'Answer', emoji: true },
    submit: { type: 'plain_text', text: 'Submit', emoji: true },
    close: { type: 'plain_text', text: 'Cancel', emoji: true },
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: escapeMrkdwn(truncate(input.question, QUESTION_MAX)) },
      },
      {
        type: 'input',
        block_id: CLARIFY_MODAL_INPUT_BLOCK_ID,
        label: { type: 'plain_text', text: 'Your answer', emoji: true },
        element: {
          type: 'plain_text_input',
          action_id: CLARIFY_MODAL_INPUT_ACTION_ID,
          multiline: true,
          ...(input.default !== undefined
            ? {
                placeholder: {
                  type: 'plain_text',
                  text: truncate(input.default, OPTION_LABEL_MAX),
                  emoji: true,
                },
              }
            : {}),
        },
      },
    ],
  };
}

/** Convert an ISO timestamp to a Slack `<!date>` epoch (seconds). */
function epoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}
