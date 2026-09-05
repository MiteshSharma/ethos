// Pure builders for the Discord clarify components. Returns lightweight
// objects matching discord.js's APIComponent serialization shape so this
// module is unit-testable without spinning up a real Client. The adapter
// converts these to discord.js builders at the call site.
//
// Custom-id encoding (used by both buttons and modal):
//   - Choice button: `clr:choice:<requestId>:<choiceIndex>`
//   - Cancel button: `clr:cancel:<requestId>`
//   - Answer button: `clr:answer:<requestId>` (opens the modal)
//   - Modal:         `clr:modal:<requestId>`
//   - Modal input:   `clr:answer-input`
//
// Discord caps custom_id at 100 chars; with a UUID requestId (36) and our
// prefixes (≤ 12) we stay well within the limit.

import type { ClarifyResponseSource, PendingClarify } from '@ethosagent/types';

/** Discord button styles per the API. We use Primary, Secondary, Danger. */
export const BUTTON_STYLE = {
  primary: 1,
  secondary: 2,
  success: 3,
  danger: 4,
} as const;

/** Component types per discord.js v14. */
const COMPONENT_TYPE = {
  actionRow: 1,
  button: 2,
  textInput: 4,
} as const;

const TEXT_INPUT_STYLE = {
  short: 1,
  paragraph: 2,
} as const;

export const CLARIFY_BUTTON_PREFIX = 'clr';
export const CLARIFY_CHOICE_KIND = 'choice';
export const CLARIFY_CANCEL_KIND = 'cancel';
export const CLARIFY_ANSWER_KIND = 'answer';
export const CLARIFY_MODAL_KIND = 'modal';
export const CLARIFY_MODAL_INPUT_ID = 'clr:answer-input';

// Discord limits. Cap inputs at the boundary so callers don't have to.
const LABEL_MAX = 80;
const QUESTION_MAX = 1900; // message content cap is 2000; leave headroom
const ANSWER_MAX = 1900;
const MODAL_QUESTION_MAX = 245; // modal label limit
const MODAL_TITLE_MAX = 45;

export interface APIButton {
  type: 2;
  style: 1 | 2 | 3 | 4;
  label: string;
  custom_id: string;
}

export interface APIActionRow {
  type: 1;
  components: APIButton[];
}

export interface ClarifyPendingInput {
  requestId: string;
  question: string;
  options?: string[];
  default?: string;
  defaultDeadlineAt: string;
  /**
   * Whether this card may carry an ANSWER affordance. Default `true`.
   *
   * `false` for a `browser_takeover` (the caller decides — see
   * `isClarifyAnswerableOn` in `@ethosagent/core`): the free-form branch below
   * otherwise draws an "Answer" button that opens a text modal, and whatever
   * someone typed into it told the agent the login it is parked on had been
   * completed. Cancel stays either way — giving up is the one thing Discord
   * CAN do about a browser it cannot see.
   */
  answerable?: boolean;
}

export interface ClarifyPendingMessage {
  /** Plaintext content of the message (Discord requires content or embeds). */
  content: string;
  components: APIActionRow[];
}

/** Build the message payload for a pending clarify. */
export function clarifyPendingMessage(input: ClarifyPendingInput): ClarifyPendingMessage {
  const lines: string[] = [`**${truncate(escapeMd(input.question), QUESTION_MAX)}**`];
  if (input.default !== undefined) {
    lines.push(
      `_default by <t:${epoch(input.defaultDeadlineAt)}:t>: \`${truncate(escapeMd(input.default), LABEL_MAX)}\`_`,
    );
  } else if (input.answerable === false) {
    // Don't tell someone to answer a card this surface will refuse to answer.
    lines.push(`_waiting until <t:${epoch(input.defaultDeadlineAt)}:t> — cancel to give up_`);
  } else {
    lines.push(`_no default — answer by <t:${epoch(input.defaultDeadlineAt)}:t> or cancel_`);
  }
  return {
    content: lines.join('\n'),
    components: buildActionRows(input.requestId, input.options, input.answerable !== false),
  };
}

export interface ClarifyResolvedInput {
  question: string;
  answer: string;
  source: ClarifyResponseSource;
  /** Discord user id of whoever answered, when `source === 'user'`. */
  answeredBy?: string;
}

/** Build the message payload for a resolved clarify (no components — buttons gone). */
export function clarifyResolvedMessage(input: ClarifyResolvedInput): ClarifyPendingMessage {
  const head = `**${truncate(escapeMd(input.question), QUESTION_MAX)}**`;
  let tail: string;
  switch (input.source) {
    case 'user': {
      const answerText = `→ ${truncate(escapeMd(input.answer), ANSWER_MAX)}`;
      const id = input.answeredBy ? digitsOnly(input.answeredBy) : '';
      tail = id ? `${answerText} _(answered by <@${id}>)_` : answerText;
      break;
    }
    case 'cancel':
      tail = '_(cancelled)_';
      break;
    case 'timeout-default':
      tail = `_(timed out — used \`${truncate(escapeMd(input.answer), ANSWER_MAX)}\`)_`;
      break;
    case 'timeout-no-default':
      tail = '_(timed out — no default)_';
      break;
  }
  return { content: `${head}\n\n${tail}`, components: [] };
}

/** Build the modal payload for a free-form clarify. */
export interface ClarifyModalInput {
  requestId: string;
  question: string;
}

export function clarifyModalPayload(input: ClarifyModalInput): {
  custom_id: string;
  title: string;
  components: Array<{
    type: 1;
    components: Array<{
      type: 4;
      custom_id: string;
      label: string;
      style: 1 | 2;
      required: boolean;
    }>;
  }>;
} {
  return {
    custom_id: `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_MODAL_KIND}:${input.requestId}`,
    title: truncate(input.question, MODAL_TITLE_MAX),
    components: [
      {
        type: COMPONENT_TYPE.actionRow,
        components: [
          {
            type: COMPONENT_TYPE.textInput,
            custom_id: CLARIFY_MODAL_INPUT_ID,
            label: truncate(input.question, MODAL_QUESTION_MAX),
            style: TEXT_INPUT_STYLE.paragraph,
            required: true,
          },
        ],
      },
    ],
  };
}

/** For listing in DM "waiting on you" UX (kept symmetric with Slack helper).
 *  Currently unused; provided so future Discord features can reuse the pending
 *  builder without re-deriving. */
export function clarifyEntryComponents(row: PendingClarify): APIActionRow[] {
  return buildActionRows(row.requestId, row.options);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildActionRows(
  requestId: string,
  options: string[] | undefined,
  answerable = true,
): APIActionRow[] {
  const rows: APIActionRow[] = [];
  const opts = (options ?? []).filter((o) => o.length > 0);
  if (opts.length === 0) {
    // Free-form: Answer + Cancel — or Cancel alone when the card is not
    // answerable on this surface (see `ClarifyPendingInput.answerable`).
    const buttons: APIButton[] = [];
    if (answerable) {
      buttons.push({
        type: COMPONENT_TYPE.button,
        style: BUTTON_STYLE.primary,
        label: 'Answer',
        custom_id: `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_ANSWER_KIND}:${requestId}`,
      });
    }
    buttons.push({
      type: COMPONENT_TYPE.button,
      style: BUTTON_STYLE.danger,
      label: 'Cancel',
      custom_id: `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CANCEL_KIND}:${requestId}`,
    });
    rows.push({ type: COMPONENT_TYPE.actionRow, components: buttons });
    return rows;
  }
  // Discord caps at 5 buttons per row, 5 rows per message — so 25 total.
  // Reserve the last row for Cancel; cap options at 20.
  const capped = opts.slice(0, 20);
  for (let i = 0; i < capped.length; i += 5) {
    const row: APIButton[] = [];
    for (let j = 0; j < 5 && i + j < capped.length; j++) {
      const idx = i + j;
      const label = capped[idx];
      if (label === undefined) continue;
      row.push({
        type: COMPONENT_TYPE.button,
        style: BUTTON_STYLE.secondary,
        label: truncate(escapeMd(label), LABEL_MAX),
        custom_id: `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CHOICE_KIND}:${requestId}:${idx}`,
      });
    }
    if (row.length > 0) rows.push({ type: COMPONENT_TYPE.actionRow, components: row });
  }
  rows.push({
    type: COMPONENT_TYPE.actionRow,
    components: [
      {
        type: COMPONENT_TYPE.button,
        style: BUTTON_STYLE.danger,
        label: 'Cancel',
        custom_id: `${CLARIFY_BUTTON_PREFIX}:${CLARIFY_CANCEL_KIND}:${requestId}`,
      },
    ],
  });
  return rows;
}

/** Discord markdown escape — neutralizes `*_~|>` plus a backslash so a
 *  question containing those chars renders literally instead of being
 *  parsed as bold/italic/strikethrough/spoiler. Also escapes `@` (to
 *  prevent `@everyone`/`@here`/`@role` mention injection) and `<` (to
 *  prevent `<@id>`, `<#id>`, `<:emoji:id>` custom mention syntax). The
 *  custom_id field is not markdown-parsed and doesn't need escaping. */
export function escapeMd(text: string): string {
  return text.replace(/([\\*_~|>`@<])/g, '\\$1');
}

/** Truncate to `max` chars with an ellipsis suffix when over. */
export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

/** Convert ISO timestamp to Discord `<t:epoch:fmt>` epoch seconds. */
function epoch(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0;
}

/** Discord user-id mention guard — `<@id>` requires `id` to be a snowflake
 *  (numeric). Refuses to interpolate a non-numeric id (would render as
 *  literal text but better to be conservative). */
function digitsOnly(s: string): string {
  return /^\d+$/.test(s) ? s : '';
}
