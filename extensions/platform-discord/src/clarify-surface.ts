// DiscordClarifySurface — wires a Discord bot to the clarify protocol.
//
//   1. When the agent calls `clarify(...)`, the bridge fires `present()`. The
//      surface posts a Discord message with Button components (or an "Answer"
//      button for free-form), then writes the (channelId, messageId, botKey,
//      originatorUserId?) back into the persisted row so post-restart sweeps
//      and edits can find it.
//   2. Button clicks arrive as `interactionCreate` events; `handleEvent()`
//      validates the stored row's (botKey, channelId, messageId) match and
//      calls `bridge.respond()` (or opens a modal for free-form).
//   3. Modal submissions arrive as `interactionCreate` events of type
//      ModalSubmit; `handleEvent()` reads the answer and resolves.
//   4. On every resolution (answer / timeout / cancel) the bridge notifies
//      `onResolved` and the surface edits the original message in place to
//      its resolved state — components removed.
//
// Mirrors `TelegramClarifySurface` and `SlackClarifySurface`. See
// plan/phases/tool_clarity_plan.md Surface 6.

import { type ClarifyBridge, clarifyPromptText } from '@ethosagent/core';
import type { ClarifyResponse, ClarifyStore, PendingClarify } from '@ethosagent/types';
import {
  type ClarifyModalInput,
  type ClarifyPendingMessage,
  clarifyModalPayload,
  clarifyPendingMessage,
  clarifyResolvedMessage,
} from './clarify-blocks';
import type { ClarifyInteractionEvent } from './clarify-interactions';

const SURFACE: 'discord' = 'discord';

/** Subset of the Discord adapter the surface depends on — structural so
 *  tests can pass a stub without a real Client. */
export interface DiscordClarifyAdapter {
  readonly botKey: string;
  postClarifyCard(input: {
    chatId: string;
    content: string;
    components: unknown[];
  }): Promise<{ messageId: string } | { error: string }>;
  updateClarifyCard(input: {
    chatId: string;
    messageId: string;
    content: string;
    components: unknown[];
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  openClarifyModal(input: {
    interactionId: string;
    interactionToken: string;
    modal: ReturnType<typeof clarifyModalPayload>;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  /** Acknowledge a button click without changing the card. discord.js
   *  requires every component interaction be acknowledged within 3s. */
  ackButtonClick(input: { interactionId: string; interactionToken: string }): Promise<void>;
  /** Acknowledge a modal submission. */
  ackModalSubmit(input: { interactionId: string; interactionToken: string }): Promise<void>;
  onClarifyInteraction(handler: (event: ClarifyInteractionRaw) => void): void;
}

/** Adapter-level event — carries interaction id/token in addition to the
 *  parsed event. The surface uses the id/token to ack and (for the answer
 *  button) to open the modal via the same interaction. */
export interface ClarifyInteractionRaw {
  event: ClarifyInteractionEvent;
  interactionId: string;
  interactionToken: string;
}

export interface SessionRoutingForClarify {
  chatId: string;
  /** Discord user id that triggered this turn — gates `answerable_by:'originator'`. */
  requesterUserId?: string;
}

export type SessionRoutingResolver = (sessionId: string) => SessionRoutingForClarify | undefined;

export interface DiscordClarifySurfaceConfig {
  adapter: DiscordClarifyAdapter;
  bridge: ClarifyBridge;
  store: ClarifyStore;
  getSessionRouting: SessionRoutingResolver;
}

export class DiscordClarifySurface {
  private readonly adapter: DiscordClarifyAdapter;
  private readonly bridge: ClarifyBridge;
  private readonly store: ClarifyStore;
  private readonly getSessionRouting: SessionRoutingResolver;
  /** Captures the responding user id between `bridge.respond()` and
   *  `onResolved` so the resolved card credits the answerer. Bounded. */
  private readonly responderById = new Map<string, string>();

  constructor(cfg: DiscordClarifySurfaceConfig) {
    this.adapter = cfg.adapter;
    this.bridge = cfg.bridge;
    this.store = cfg.store;
    this.getSessionRouting = cfg.getSessionRouting;

    this.bridge.registerPresenter(SURFACE, (row) => this.present(row));
    this.bridge.onResolved((row, resp) => {
      void this.onResolved(row, resp);
    });
    this.adapter.onClarifyInteraction((raw) => {
      void this.handleInteraction(raw);
    });
  }

  async present(row: PendingClarify): Promise<void> {
    if (row.surfaceType !== SURFACE) return;
    // Fix 1 (pi-delegation.md §1b) — `getSessionRouting` only resolves a LIVE
    // foreground chat session; a background job's clarify has none. Fall
    // back to the delivery context the bridge resolved onto
    // `row.surfaceContext` so a job-originated clarify still delivers.
    const routing = this.getSessionRouting(row.sessionId) ?? routingFromSurfaceContext(row);
    if (!routing) return;

    const msg = clarifyPendingMessage({
      requestId: row.requestId,
      // D3 — a `browser_takeover` row renders as the text form; an ordinary
      // question passes through unchanged.
      question: clarifyPromptText(row),
      ...(row.options !== undefined ? { options: row.options } : {}),
      ...(row.default !== undefined ? { default: row.default } : {}),
      // `present()` only fires once a row is actually presented (D2), at
      // which point this is always set — the fallback is defensive only.
      defaultDeadlineAt: row.defaultDeadlineAt ?? row.createdAt,
    });
    const result = await this.adapter.postClarifyCard({
      chatId: routing.chatId,
      content: msg.content,
      components: msg.components,
    });
    if ('error' in result) return; // bridge timer cleans up

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

  // -------------------------------------------------------------------------
  // Interactions
  // -------------------------------------------------------------------------

  private async handleInteraction(raw: ClarifyInteractionRaw): Promise<void> {
    const evt = raw.event;
    if (evt.kind === 'modal-submit') {
      // Modals can be submitted from any channel context the user has the
      // modal open in. Validate by botKey + answerer; rely on the opaque
      // requestId for cross-session isolation.
      await this.adapter.ackModalSubmit({
        interactionId: raw.interactionId,
        interactionToken: raw.interactionToken,
      });
      const row = await this.store.get(evt.requestId);
      if (!row || row.surfaceType !== SURFACE) return;
      if (row.surfaceContext.botKey !== this.adapter.botKey) return;
      if (!gateAnswerer(row, evt.userId)) return;
      this.rememberResponder(row.requestId, evt.userId);
      // D7 — a human acted on this surface; a background job's next question
      // may route here instead of always falling back to its origin lane.
      // Fix 1 — carry real delivery context, not just the surface type.
      this.bridge.recordPresence(SURFACE, {
        chatId: evt.channelId,
        botKey: this.adapter.botKey,
      });
      await this.bridge.respond({
        requestId: row.requestId,
        answer: evt.answer,
        source: 'user',
      });
      return;
    }

    // Button click. Validate the row first, then branch: open-modal goes
    // straight to showModal (the first and only response); choice/cancel
    // acks via deferUpdate and resolves.
    const row = await this.store.get(evt.requestId);
    if (!row || row.surfaceType !== SURFACE) {
      // Row gone or not ours — ack with deferUpdate so Discord doesn't
      // show an error to the user, then bail.
      await this.adapter.ackButtonClick({
        interactionId: raw.interactionId,
        interactionToken: raw.interactionToken,
      });
      return;
    }
    // Cross-tenant gate: stored (botKey, chatId, messageId) must match the
    // click's origin. Same posture as the Telegram and Slack surfaces.
    if (
      row.surfaceContext.botKey !== this.adapter.botKey ||
      row.surfaceContext.chatId !== evt.channelId ||
      row.surfaceContext.messageId !== evt.messageId
    ) {
      await this.adapter.ackButtonClick({
        interactionId: raw.interactionId,
        interactionToken: raw.interactionToken,
      });
      return;
    }
    if (!gateAnswerer(row, evt.userId)) {
      await this.adapter.ackButtonClick({
        interactionId: raw.interactionId,
        interactionToken: raw.interactionToken,
      });
      return;
    }

    if (evt.kind === 'open-modal') {
      // showModal must be the FIRST response — don't call ackButtonClick
      // (which calls deferUpdate and consumes the response window).
      const modal: ClarifyModalInput = { requestId: row.requestId, question: row.question };
      await this.adapter.openClarifyModal({
        interactionId: raw.interactionId,
        interactionToken: raw.interactionToken,
        modal: clarifyModalPayload(modal),
      });
      return;
    }

    // Choice or cancel — ack (deferUpdate + drain), then resolve.
    await this.adapter.ackButtonClick({
      interactionId: raw.interactionId,
      interactionToken: raw.interactionToken,
    });

    let response: ClarifyResponse;
    if (evt.kind === 'cancel') {
      response = { requestId: row.requestId, answer: '', source: 'cancel' };
    } else {
      const answer = row.options?.[evt.choiceIndex];
      if (answer === undefined) return; // out-of-range / stale
      response = { requestId: row.requestId, answer, source: 'user' };
    }
    this.rememberResponder(row.requestId, evt.userId);
    this.bridge.recordPresence(SURFACE, { chatId: evt.channelId, botKey: this.adapter.botKey });
    await this.bridge.respond(response);
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  private async onResolved(row: PendingClarify, response: ClarifyResponse | null): Promise<void> {
    if (row.surfaceType !== SURFACE) return;
    if (row.surfaceContext.botKey !== this.adapter.botKey) return;
    const chatId = row.surfaceContext.chatId;
    const messageId = row.surfaceContext.messageId;
    if (typeof chatId !== 'string' || typeof messageId !== 'string') return;

    const answeredBy = this.responderById.get(row.requestId);
    this.responderById.delete(row.requestId);
    const msg = buildResolved(row, response, answeredBy);
    await this.adapter.updateClarifyCard({
      chatId,
      messageId,
      content: msg.content,
      components: msg.components,
    });
  }

  private rememberResponder(requestId: string, userId: string): void {
    if (this.responderById.size >= 1024) {
      const first = this.responderById.keys().next().value;
      if (first !== undefined) this.responderById.delete(first);
    }
    this.responderById.set(requestId, userId);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Fix 1 (pi-delegation.md §1b) — see the Telegram surface's equivalent for
 *  the full rationale. */
function routingFromSurfaceContext(row: PendingClarify): SessionRoutingForClarify | undefined {
  const chatId = row.surfaceContext.chatId;
  if (typeof chatId !== 'string') return undefined;
  return { chatId };
}

function gateAnswerer(row: PendingClarify, userId: string | undefined): boolean {
  if (row.answerableBy === 'anyone') return true;
  const originator = row.surfaceContext.originatorUserId;
  if (typeof originator !== 'string') return false;
  return userId === originator;
}

function buildResolved(
  row: PendingClarify,
  response: ClarifyResponse | null,
  answeredBy: string | undefined,
): ClarifyPendingMessage {
  if (!response) {
    return clarifyResolvedMessage({
      question: clarifyPromptText(row),
      answer: '',
      source: 'timeout-no-default',
    });
  }
  return clarifyResolvedMessage({
    // Same head as the pending card — this edits that message in place.
    question: clarifyPromptText(row),
    answer: response.answer,
    source: response.source,
    ...(answeredBy !== undefined && response.source === 'user' ? { answeredBy } : {}),
  });
}
