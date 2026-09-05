// Pure-builder tests for the clarify Block Kit blocks.

import type { PendingClarify } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  CLARIFY_ANSWER_ACTION_ID,
  CLARIFY_CANCEL_ACTION_ID,
  CLARIFY_CHOICE_ACTION_ID,
  CLARIFY_MODAL_CALLBACK_ID,
  CLARIFY_MODAL_INPUT_ACTION_ID,
  CLARIFY_MODAL_INPUT_BLOCK_ID,
  clarifyHomeEntryBlocks,
  clarifyModalView,
  clarifyPendingBlocks,
  clarifyResolvedBlocks,
  clarifyTakeoverNoticeView,
} from '../blocks/clarify';

const DEADLINE = '2026-05-15T00:15:00.000Z';

describe('clarifyPendingBlocks', () => {
  it('renders one button per option plus a Cancel button', () => {
    const blocks = clarifyPendingBlocks({
      requestId: 'r1',
      question: 'Which database?',
      options: ['postgres', 'sqlite', 'mysql'],
      default: 'postgres',
      defaultDeadlineAt: DEADLINE,
    });
    const actions = blocks.find((b) => b.type === 'actions') as
      | { elements: Array<{ action_id: string; value: string; text: { text: string } }> }
      | undefined;
    expect(actions).toBeDefined();
    const labels = actions?.elements.map((e) => e.text.text);
    expect(labels).toEqual(['postgres', 'sqlite', 'mysql', 'Cancel']);
    // Choice button values are `<requestId>:<idx>`; cancel is just <requestId>.
    expect(actions?.elements[0]?.value).toBe('r1:0');
    expect(actions?.elements[1]?.value).toBe('r1:1');
    expect(actions?.elements[2]?.value).toBe('r1:2');
    expect(actions?.elements[3]?.action_id).toBe(CLARIFY_CANCEL_ACTION_ID);
    expect(actions?.elements[3]?.value).toBe('r1');
  });

  it('renders Answer + Cancel for free-form (no options)', () => {
    const blocks = clarifyPendingBlocks({
      requestId: 'r2',
      question: 'Describe the schema',
      defaultDeadlineAt: DEADLINE,
    });
    const actions = blocks.find((b) => b.type === 'actions') as
      | { elements: Array<{ action_id: string }> }
      | undefined;
    expect(actions?.elements.map((e) => e.action_id)).toEqual([
      CLARIFY_ANSWER_ACTION_ID,
      CLARIFY_CANCEL_ACTION_ID,
    ]);
  });

  it('escapes mrkdwn special chars in the question', () => {
    const blocks = clarifyPendingBlocks({
      requestId: 'r3',
      question: '<@U999> what about <http://x|click here>?',
      defaultDeadlineAt: DEADLINE,
    });
    const sectionTexts = blocks
      .filter((b) => b.type === 'section')
      .map((b) => (b.text as { text: string }).text);
    // escaped `<` / `>` so live mentions / links can't be injected
    expect(sectionTexts.some((t) => t.includes('&lt;@U999&gt;'))).toBe(true);
    expect(sectionTexts.some((t) => t.includes('&lt;http://x|click here&gt;'))).toBe(true);
  });

  it('caps options at 24 to leave room for Cancel within Slack action limits', () => {
    const many = Array.from({ length: 30 }, (_, i) => `opt-${i}`);
    const blocks = clarifyPendingBlocks({
      requestId: 'r4',
      question: 'pick one',
      options: many,
      defaultDeadlineAt: DEADLINE,
    });
    const actions = blocks.find((b) => b.type === 'actions') as { elements: unknown[] } | undefined;
    expect(actions?.elements.length).toBe(25); // 24 options + 1 cancel
  });

  // `answerable: false` is what a `browser_takeover` renders as. Slack can't
  // hand a browser back (`isClarifyAnswerableOn`), so the card must not invite
  // it: no Answer button, and no line telling the reader to answer.
  it('renders Cancel alone when answerable is false — no Answer button', () => {
    const blocks = clarifyPendingBlocks({
      requestId: 'r5',
      question: "I'm stuck on a login at accounts.example.com",
      defaultDeadlineAt: DEADLINE,
      answerable: false,
    });
    const actions = blocks.find((b) => b.type === 'actions') as
      | { elements: Array<{ action_id: string; value: string }> }
      | undefined;
    expect(actions?.elements.map((e) => e.action_id)).toEqual([CLARIFY_CANCEL_ACTION_ID]);
    expect(actions?.elements[0]?.value).toBe('r5');
    expect(JSON.stringify(blocks)).not.toContain(CLARIFY_ANSWER_ACTION_ID);
  });

  it('replaces the "answer by" line with a cancel-only line when answerable is false', () => {
    const blocks = clarifyPendingBlocks({
      requestId: 'r6',
      question: 'stuck on a login',
      defaultDeadlineAt: DEADLINE,
      answerable: false,
    });
    const ctx = blocks.find((b) => b.type === 'context') as
      | { elements: Array<{ text: string }> }
      | undefined;
    const line = ctx?.elements[0]?.text ?? '';
    expect(line).not.toContain('answer by');
    expect(line).toContain('cancel to give up');
  });
});

// The App Home "Waiting on you" entry reuses the pending builder, and its
// buttons reach the same handler as a channel card's. A takeover must lose its
// Answer button here too, or the Home tab keeps the invitation the channel
// card just dropped.
describe('clarifyHomeEntryBlocks', () => {
  function homeRow(overrides: Partial<PendingClarify> = {}): PendingClarify {
    return {
      requestId: 'home-1',
      sessionId: 'sess-1',
      surfaceType: 'slack',
      surfaceContext: { chatId: 'C1', botKey: 'k', messageTs: 'ts-1' },
      question: 'Which database?',
      answerableBy: 'anyone',
      createdAt: '2026-05-15T00:00:00.000Z',
      defaultDeadlineAt: DEADLINE,
      ...overrides,
    };
  }

  it('drops the Answer button for a browser_takeover row', () => {
    const blocks = clarifyHomeEntryBlocks(homeRow({ kind: 'browser_takeover' }));
    const actions = blocks.find((b) => b.type === 'actions') as
      | { elements: Array<{ action_id: string }> }
      | undefined;
    expect(actions?.elements.map((e) => e.action_id)).toEqual([CLARIFY_CANCEL_ACTION_ID]);
  });

  it('keeps Answer + Cancel for an ordinary free-form row', () => {
    const blocks = clarifyHomeEntryBlocks(homeRow());
    const actions = blocks.find((b) => b.type === 'actions') as
      | { elements: Array<{ action_id: string }> }
      | undefined;
    expect(actions?.elements.map((e) => e.action_id)).toEqual([
      CLARIFY_ANSWER_ACTION_ID,
      CLARIFY_CANCEL_ACTION_ID,
    ]);
  });
});

describe('clarifyTakeoverNoticeView', () => {
  // Shown when someone clicks Answer on a stale takeover card. It must be
  // close-only: a submit button would produce a `view_submission` the bridge
  // refuses, which is the silent no-op this whole change exists to remove.
  it('is a close-only modal that names the web chat and carries the prompt text', () => {
    const view = clarifyTakeoverNoticeView({
      question:
        "I'm stuck on a login at accounts.example.com — open the web chat to hand back: https://ethos.local/chat/sess-1",
    });
    expect(view.submit).toBeUndefined();
    expect(view.callback_id).toBeUndefined();
    expect(view.close).toBeDefined();
    const text = JSON.stringify(view.blocks);
    expect(text).toContain("can't be handed back from Slack");
    expect(text).toContain('accounts.example.com');
    expect(text).toContain('https://ethos.local/chat/sess-1');
  });
});

describe('clarifyResolvedBlocks', () => {
  it('renders a user-answered card with the answerer mention', () => {
    const blocks = clarifyResolvedBlocks({
      question: 'Which db?',
      answer: 'postgres',
      source: 'user',
      answeredBy: 'U12345',
    });
    const sections = blocks
      .filter((b) => b.type === 'section')
      .map((b) => (b.text as { text: string }).text);
    expect(sections[0]).toContain('Question:');
    expect(sections[1]).toContain('postgres');
    const ctx = blocks.find((b) => b.type === 'context') as
      | { elements: Array<{ text: string }> }
      | undefined;
    expect(ctx?.elements[0]?.text).toContain('<@U12345>');
  });

  it('renders timeout-default with the default value', () => {
    const blocks = clarifyResolvedBlocks({
      question: 'Q?',
      answer: 'postgres',
      source: 'timeout-default',
    });
    const last = blocks[blocks.length - 1] as unknown as { text: { text: string } };
    expect(last.text.text).toMatch(/timed out.*postgres/);
  });

  it('renders cancel without an answer', () => {
    const blocks = clarifyResolvedBlocks({ question: 'Q?', answer: '', source: 'cancel' });
    const last = blocks[blocks.length - 1] as unknown as { text: { text: string } };
    expect(last.text.text).toMatch(/cancelled/);
  });

  it('refuses to render an unrecognized user id as a live mention', () => {
    const blocks = clarifyResolvedBlocks({
      question: 'Q?',
      answer: 'a',
      source: 'user',
      answeredBy: 'definitely-not-a-slack-user-id',
    });
    const ctx = blocks.find((b) => b.type === 'context') as
      | { elements: Array<{ text: string }> }
      | undefined;
    expect(ctx?.elements[0]?.text).not.toContain('<@');
  });
});

describe('clarifyModalView', () => {
  it('encodes requestId in private_metadata and uses the contracted block_id/action_id', () => {
    const view = clarifyModalView({ requestId: 'r9', question: 'free-form?' }) as {
      callback_id: string;
      private_metadata: string;
      blocks: Array<{
        type: string;
        block_id?: string;
        element?: { action_id: string };
      }>;
    };
    expect(view.callback_id).toBe(CLARIFY_MODAL_CALLBACK_ID);
    expect(JSON.parse(view.private_metadata)).toEqual({ requestId: 'r9' });
    const input = view.blocks.find((b) => b.type === 'input');
    expect(input?.block_id).toBe(CLARIFY_MODAL_INPUT_BLOCK_ID);
    expect(input?.element?.action_id).toBe(CLARIFY_MODAL_INPUT_ACTION_ID);
  });
});

describe('action_id constants — stable contract', () => {
  it('keeps the choice/cancel/answer ids that adapter.start() registers on', () => {
    expect(CLARIFY_CHOICE_ACTION_ID).toBe('ethos_clarify_choice');
    expect(CLARIFY_CANCEL_ACTION_ID).toBe('ethos_clarify_cancel');
    expect(CLARIFY_ANSWER_ACTION_ID).toBe('ethos_clarify_answer');
  });
});
