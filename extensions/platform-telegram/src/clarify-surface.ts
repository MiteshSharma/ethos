// TelegramClarifySurface — wires a Telegram bot to the clarify protocol:
//
//   1. When the agent calls `clarify(...)`, the bridge fires `present()`. The
//      surface sends an inline-keyboard prompt (with `options`) or a
//      force-reply prompt (free-form), then writes the resulting
//      `(chatId, messageId, botKey, originatorUserId?)` back into the
//      persisted row so a force-reply (or a post-restart sweep) can find it.
//   2. Button taps arrive as Telegram `callback_query` updates; the surface
//      parses `clr:<requestId>:<choice|cancel>`, gates by `answerableBy`,
//      and calls `bridge.respond()`.
//   3. Free-form replies arrive as regular messages — the gateway calls
//      `correlateMessage()` BEFORE the safety filter; a match short-circuits
//      the normal pipeline and resolves the clarify directly.
//   4. On every resolution (answer / timeout / cancel) the bridge notifies
//      `onResolved` and the surface edits the original prompt in place to
//      its resolved state — buttons gone, choice shown.
//
// See plan/phases/tool_clarity_plan.md Surface 4.

import type { ClarifyBridge } from '@ethosagent/core';
import type {
  ClarifyResponse,
  ClarifyStore,
  InboundMessage,
  PendingClarify,
} from '@ethosagent/types';
import type { CallbackQueryEvent, InlineButton } from './index';

const SURFACE: 'telegram' = 'telegram';
const CALLBACK_PREFIX = 'clr';
const CANCEL_MARKER = 'cancel';

/** Subset of the Telegram adapter the surface depends on — structural so
 *  tests can pass a stub without touching grammy. */
export interface TelegramClarifyAdapter {
  readonly botKey: string;
  readonly id: string;
  sendInlineKeyboard(
    chatId: string,
    text: string,
    rows: InlineButton[][],
  ): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  sendForceReply(
    chatId: string,
    text: string,
  ): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  editToPlainText(
    chatId: string,
    messageId: string,
    text: string,
  ): Promise<{ ok: true; messageId?: string } | { ok: false; error: string }>;
  onCallbackQuery(handler: (event: CallbackQueryEvent) => void): void;
}

/** Per-session routing slice the surface needs to send the prompt. */
export interface SessionRoutingForClarify {
  chatId: string;
  /** Platform user id that triggered this turn — the `answerable_by:
   *  'originator'` gate. Absent when the adapter didn't stamp one. */
  requesterUserId?: string;
}

export type SessionRoutingResolver = (sessionId: string) => SessionRoutingForClarify | undefined;

export interface TelegramClarifySurfaceConfig {
  adapter: TelegramClarifyAdapter;
  bridge: ClarifyBridge;
  store: ClarifyStore;
  getSessionRouting: SessionRoutingResolver;
}

export class TelegramClarifySurface {
  private readonly adapter: TelegramClarifyAdapter;
  private readonly bridge: ClarifyBridge;
  private readonly store: ClarifyStore;
  private readonly getSessionRouting: SessionRoutingResolver;

  constructor(cfg: TelegramClarifySurfaceConfig) {
    this.adapter = cfg.adapter;
    this.bridge = cfg.bridge;
    this.store = cfg.store;
    this.getSessionRouting = cfg.getSessionRouting;

    this.bridge.registerPresenter(SURFACE, (row) => this.present(row));
    this.bridge.onResolved((row, resp) => {
      void this.onResolved(row, resp);
    });
    this.adapter.onCallbackQuery((evt) => {
      void this.handleCallback(evt);
    });
  }

  /**
   * Present a pending clarify to the Telegram chat. With `options` the user
   * gets an inline keyboard; without, a force-reply prompt. Writes the
   * Telegram message id back into the persisted row so later replies and
   * sweeps can find it.
   */
  async present(row: PendingClarify): Promise<void> {
    if (row.surfaceType !== SURFACE) return;
    const routing = this.getSessionRouting(row.sessionId);
    if (!routing) {
      // No routing means the gateway lost track of which chat — the turn
      // will time out and the bridge will fire `timeout-no-default` or
      // `timeout-default`. Nothing to send; nothing to wedge.
      return;
    }

    const text = formatPrompt(row);
    const result =
      row.options && row.options.length > 0
        ? await this.adapter.sendInlineKeyboard(routing.chatId, text, buildButtonRows(row))
        : await this.adapter.sendForceReply(routing.chatId, text);

    if (!result.ok || !result.messageId) {
      // A send failure (e.g. user blocked the bot) leaves the row persisted;
      // the bridge timer will still fire and clean up. Don't throw — we
      // mustn't wedge the turn.
      return;
    }

    await this.store.update(row.requestId, {
      surfaceContext: {
        ...row.surfaceContext,
        chatId: routing.chatId,
        botKey: this.adapter.botKey,
        messageId: result.messageId,
        ...(routing.requesterUserId !== undefined
          ? { originatorUserId: routing.requesterUserId }
          : {}),
      },
    });
  }

  /**
   * Inbound-message correlator: returns a clarify response when the message
   * resolves a pending Telegram clarify (force-reply matching a stored
   * messageId, or `/cancel [requestId]` in a chat with a pending row);
   * otherwise null. Run by the gateway BEFORE the channel safety filter so
   * a tap from an approved sender's force-reply doesn't get treated as a
   * normal agent prompt.
   */
  async correlateMessage(message: InboundMessage): Promise<ClarifyResponse | null> {
    if (message.platform !== SURFACE) return null;
    if (message.botKey !== this.adapter.botKey) return null;

    const text = (message.text ?? '').trim();
    const parts = text.split(/\s+/);
    const head = parts[0];
    if (head === '/cancel' || head?.startsWith('/cancel@')) {
      const explicit = parts[1];
      const target = await this.findCancelTarget(message.chatId, explicit);
      if (!target) return null;
      if (!gateAnswerer(target, message.userId)) return null;
      // D7 — a human acted on this surface; a background job's next question
      // may route here instead of always falling back to its origin lane.
      this.bridge.recordPresence(SURFACE);
      return { requestId: target.requestId, answer: '', source: 'cancel' };
    }

    if (!message.replyToId) return null;
    const rows = await this.store.list({ surfaceType: SURFACE });
    const target = rows.find(
      (r) =>
        r.surfaceContext.chatId === message.chatId &&
        r.surfaceContext.botKey === this.adapter.botKey &&
        String(r.surfaceContext.messageId ?? '') === message.replyToId,
    );
    if (!target) return null;
    if (!gateAnswerer(target, message.userId)) return null;
    this.bridge.recordPresence(SURFACE);
    return { requestId: target.requestId, answer: text, source: 'user' };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async handleCallback(evt: CallbackQueryEvent): Promise<void> {
    const parsed = parseCallback(evt.data);
    if (!parsed) {
      await evt.answer();
      return;
    }
    const row = await this.store.get(parsed.requestId);
    if (!row || row.surfaceType !== SURFACE) {
      // Row already resolved or never belonged to us — dismiss the spinner
      // with a hint so the user isn't left staring at a frozen button.
      await evt.answer('Already resolved.');
      return;
    }
    // Cross-tenant gate: a stale, forwarded, or otherwise replayed callback
    // must not resolve a row whose stored (botKey, chatId, messageId) doesn't
    // match the click's origin. The plan calls this out explicitly for
    // multi-bot/multi-chat correctness.
    if (
      row.surfaceContext.botKey !== this.adapter.botKey ||
      row.surfaceContext.chatId !== evt.chatId ||
      row.surfaceContext.messageId !== evt.messageId
    ) {
      await evt.answer('Already resolved.');
      return;
    }
    if (!gateAnswerer(row, evt.userId)) {
      await evt.answer('Only the original asker can answer this.');
      return;
    }
    let response: ClarifyResponse;
    if (parsed.kind === 'cancel') {
      response = { requestId: row.requestId, answer: '', source: 'cancel' };
    } else {
      const answer = row.options?.[parsed.choiceIndex];
      if (answer === undefined) {
        // Out-of-range / stale callback — refuse rather than silently
        // resolve with an empty string (which the LLM would treat as a
        // valid answer).
        await evt.answer('That choice is no longer available.');
        return;
      }
      response = { requestId: row.requestId, answer, source: 'user' };
    }
    this.bridge.recordPresence(SURFACE);
    await this.bridge.respond(response);
    await evt.answer();
  }

  private async onResolved(row: PendingClarify, response: ClarifyResponse | null): Promise<void> {
    if (row.surfaceType !== SURFACE) return;
    if (row.surfaceContext.botKey !== this.adapter.botKey) return;
    const chatId = row.surfaceContext.chatId;
    const messageId = row.surfaceContext.messageId;
    if (typeof chatId !== 'string' || typeof messageId !== 'string') return;
    await this.adapter.editToPlainText(chatId, messageId, formatResolved(row, response));
  }

  private async findCancelTarget(
    chatId: string,
    requestId: string | undefined,
  ): Promise<PendingClarify | undefined> {
    const rows = await this.store.list({ surfaceType: SURFACE });
    const sameChat = rows.filter(
      (r) => r.surfaceContext.chatId === chatId && r.surfaceContext.botKey === this.adapter.botKey,
    );
    if (requestId) return sameChat.find((r) => r.requestId === requestId);
    return sameChat[0];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Two-column inline keyboard (scannable) plus a Cancel row. */
function buildButtonRows(row: PendingClarify): InlineButton[][] {
  const options = row.options ?? [];
  const rows: InlineButton[][] = [];
  for (let i = 0; i < options.length; i += 2) {
    const r: InlineButton[] = [];
    for (let j = 0; j < 2 && i + j < options.length; j++) {
      const idx = i + j;
      const label = options[idx];
      if (label === undefined) continue;
      r.push({ label, data: `${CALLBACK_PREFIX}:${row.requestId}:${idx}` });
    }
    if (r.length > 0) rows.push(r);
  }
  rows.push([{ label: 'Cancel', data: `${CALLBACK_PREFIX}:${row.requestId}:${CANCEL_MARKER}` }]);
  return rows;
}

type ParsedCallback =
  | { kind: 'choice'; requestId: string; choiceIndex: number }
  | { kind: 'cancel'; requestId: string };

function parseCallback(data: string): ParsedCallback | null {
  const parts = data.split(':');
  if (parts.length !== 3) return null;
  const [prefix, requestId, tail] = parts;
  if (prefix !== CALLBACK_PREFIX || !requestId || tail === undefined) return null;
  if (tail === CANCEL_MARKER) return { kind: 'cancel', requestId };
  const idx = Number(tail);
  if (!Number.isInteger(idx) || idx < 0) return null;
  return { kind: 'choice', requestId, choiceIndex: idx };
}

function gateAnswerer(row: PendingClarify, userId: string | undefined): boolean {
  if (row.answerableBy === 'anyone') return true;
  const originator = row.surfaceContext.originatorUserId;
  if (typeof originator !== 'string') return false; // originator-only with no originator stamp → reject
  return userId === originator;
}

function formatPrompt(row: PendingClarify): string {
  // `present()` only fires once a row is actually presented (D2), at which
  // point `defaultDeadlineAt` is always set — the `?? row.createdAt` fallback
  // is defensive only, for the type (null while merely queued).
  const minutes = Math.max(
    1,
    Math.round(
      (new Date(row.defaultDeadlineAt ?? row.createdAt).getTime() -
        new Date(row.createdAt).getTime()) /
        60_000,
    ),
  );
  const lines: string[] = [row.question, ''];
  if (row.default !== undefined) {
    lines.push(`default in ${minutes}m: ${row.default}`);
  } else {
    lines.push(`no default — answer within ${minutes}m or cancel`);
  }
  return lines.join('\n');
}

function formatResolved(row: PendingClarify, response: ClarifyResponse | null): string {
  if (!response) return `${row.question}\n\n(timed out — no default)`;
  switch (response.source) {
    case 'user':
      return `${row.question}\n\n→ ${response.answer}`;
    case 'cancel':
      return `${row.question}\n\n(cancelled)`;
    case 'timeout-default':
      return `${row.question}\n\n(timed out — used ${response.answer})`;
    case 'timeout-no-default':
      return `${row.question}\n\n(timed out — no default)`;
  }
}
