// SlackClarifySurface — wires a Slack bot to the clarify protocol.
//
//   1. When the agent calls `clarify(...)`, the bridge fires `present()`. The
//      surface posts a Block Kit card via the adapter (option buttons or a
//      free-form Answer button), then writes the (channelId, messageTs,
//      botKey, originatorUserId?) back into the persisted row so post-restart
//      sweeps and home-tab rendering can find it.
//   2. Button taps arrive as `block_actions`; `handleAction()` validates the
//      stored row's (botKey, channel, messageTs) match and calls
//      `bridge.respond()` (or opens a modal for free-form).
//   3. Modal submissions arrive as `view_submission`; `handleModalSubmit()`
//      reads the answer and calls `bridge.respond()`.
//   4. On every resolution (answer / timeout / cancel) the bridge notifies
//      `onResolved` and the surface edits the original card in place to its
//      resolved state — buttons gone, answer or status shown.
//
// Mirrors `TelegramClarifySurface`. See plan/phases/tool_clarity_plan.md
// Surface 5.

import type { ClarifyBridge } from '@ethosagent/core';
import type { ClarifyResponse, ClarifyStore, PendingClarify } from '@ethosagent/types';
import { clarifyModalView, clarifyPendingBlocks, clarifyResolvedBlocks } from './blocks/clarify';
import type { ClarifyActionEvent, ClarifyModalSubmissionEvent } from './interactions/clarify';

const SURFACE: 'slack' = 'slack';

/** Subset of the Slack adapter the surface depends on — structural so tests
 *  can pass a stub without touching Bolt. */
export interface SlackClarifyAdapter {
  readonly botKey: string;
  postClarifyCard(input: {
    chatId: string;
    threadId?: string;
    blocks: unknown[];
  }): Promise<{ messageTs: string } | { error: string }>;
  updateClarifyCard(input: {
    chatId: string;
    messageTs: string;
    blocks: unknown[];
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  openClarifyModal(input: {
    triggerId: string;
    view: Record<string, unknown>;
  }): Promise<{ ok: true } | { ok: false; error: string }>;
  onClarifyAction(handler: (event: ClarifyActionEvent) => void): void;
  onClarifyModalSubmit(handler: (event: ClarifyModalSubmissionEvent) => void): void;
}

export interface SessionRoutingForClarify {
  chatId: string;
  threadId?: string;
  /** Slack user id that triggered this turn — the `answerable_by: 'originator'`
   *  gate. Absent when the route can't identify a single requester. */
  requesterUserId?: string;
}

export type SessionRoutingResolver = (sessionId: string) => SessionRoutingForClarify | undefined;

export interface SlackClarifySurfaceConfig {
  adapter: SlackClarifyAdapter;
  bridge: ClarifyBridge;
  store: ClarifyStore;
  getSessionRouting: SessionRoutingResolver;
  /** CHS-005 — optional sink for the cross-tenant gate's denials. */
  observability?: {
    recordSafetyBlock(opts: {
      code?: string;
      cause?: string;
      details?: Record<string, unknown>;
    }): void;
  };
}

export class SlackClarifySurface {
  private readonly adapter: SlackClarifyAdapter;
  private readonly bridge: ClarifyBridge;
  private readonly store: ClarifyStore;
  private readonly getSessionRouting: SessionRoutingResolver;
  /** Captures the responding user id between `bridge.respond()` and the bridge's
   *  `onResolved` callback so the resolved card can credit the answerer. The
   *  bridge intentionally doesn't carry per-surface metadata; this is a local
   *  side-channel. Drained on `onResolved`. Bounded — entries with no matching
   *  resolution are evicted lazily when the map grows past a soft cap. */
  private readonly responderById = new Map<string, string>();
  private readonly observability: SlackClarifySurfaceConfig['observability'];

  constructor(cfg: SlackClarifySurfaceConfig) {
    this.adapter = cfg.adapter;
    this.bridge = cfg.bridge;
    this.store = cfg.store;
    this.getSessionRouting = cfg.getSessionRouting;
    this.observability = cfg.observability;

    this.bridge.setPresenter((row) => this.present(row));
    this.bridge.onResolved((row, resp) => {
      void this.onResolved(row, resp);
    });
    this.adapter.onClarifyAction((evt) => {
      void this.handleAction(evt);
    });
    this.adapter.onClarifyModalSubmit((evt) => {
      void this.handleModalSubmit(evt);
    });
  }

  /**
   * Present a pending clarify on Slack. Posts the pending card, then writes
   * the (chatId, messageTs, botKey, originatorUserId?) back to the row.
   */
  async present(row: PendingClarify): Promise<void> {
    if (row.surfaceType !== SURFACE) return;
    const routing = this.getSessionRouting(row.sessionId);
    if (!routing) return;

    const blocks = clarifyPendingBlocks({
      requestId: row.requestId,
      question: row.question,
      ...(row.options !== undefined ? { options: row.options } : {}),
      ...(row.default !== undefined ? { default: row.default } : {}),
      defaultDeadlineAt: row.defaultDeadlineAt,
    });

    const result = await this.adapter.postClarifyCard({
      chatId: routing.chatId,
      ...(routing.threadId !== undefined ? { threadId: routing.threadId } : {}),
      blocks,
    });
    if ('error' in result) {
      // Send failure (channel gone, bot kicked) — leave the row persisted; the
      // bridge timer still fires and cleans up.
      return;
    }

    await this.store.update(row.requestId, {
      surfaceContext: {
        ...row.surfaceContext,
        chatId: routing.chatId,
        botKey: this.adapter.botKey,
        messageTs: result.messageTs,
        ...(routing.threadId !== undefined ? { threadId: routing.threadId } : {}),
        ...(routing.requesterUserId !== undefined
          ? { originatorUserId: routing.requesterUserId }
          : {}),
      },
    });
  }

  // -------------------------------------------------------------------------
  // Button taps
  // -------------------------------------------------------------------------

  /**
   * CHS-005 — record a clarify gate refusal.
   *
   * The click is dropped silently either way; this only adds the audit row.
   * The card's `requestId` is deliberately included and its content is not:
   * the operator needs to correlate the refusal with a request, not read what
   * was being asked.
   */
  private denied(cause: string, evt: ClarifyActionEvent): void {
    this.observability?.recordSafetyBlock({
      code: 'slack.clarify.gate_denied',
      cause,
      details: {
        requestId: evt.requestId,
        userId: evt.userId,
        channelId: evt.channelId,
        fromHome: evt.fromHome,
      },
    });
  }

  private async handleAction(evt: ClarifyActionEvent): Promise<void> {
    const row = await this.store.get(evt.requestId);
    if (!row || row.surfaceType !== SURFACE) {
      // Already resolved or never ours — silently drop. The Bolt ack already
      // happened in the adapter; the user sees the buttons (still rendered)
      // and a stale row is unrecoverable on this surface.
      return;
    }
    // Cross-tenant gate: a stale, forwarded, or replayed payload must not
    // resolve a row whose stored (botKey, chatId, messageTs) doesn't match
    // the click's origin. The chat/message check applies only to channel
    // clicks — App Home payloads carry no channel/message (the click is on
    // a per-user view), so for Home we keep the botKey gate but skip the
    // message-coordinate match. The opaque random `requestId` plus
    // `gateAnswerer` still prevent a Home click from resolving a row the
    // user shouldn't be answering.
    // CHS-005 — each of these three is a security decision. Recording them is
    // what turns "the button did nothing" into an investigable event; the
    // behaviour (a silent no-op to the clicker) is unchanged.
    if (row.surfaceContext.botKey !== this.adapter.botKey) {
      this.denied('bot key mismatch', evt);
      return;
    }
    if (!evt.fromHome) {
      if (
        row.surfaceContext.chatId !== evt.channelId ||
        row.surfaceContext.messageTs !== evt.messageTs
      ) {
        this.denied('message coordinates do not match the stored row', evt);
        return;
      }
    }
    if (!gateAnswerer(row, evt.userId)) {
      this.denied('user is not the designated answerer', evt);
      return;
    }

    if (evt.kind === 'open-modal') {
      await this.adapter.openClarifyModal({
        triggerId: evt.triggerId,
        view: clarifyModalView({
          requestId: row.requestId,
          question: row.question,
          ...(row.default !== undefined ? { default: row.default } : {}),
        }),
      });
      return;
    }

    let response: ClarifyResponse;
    if (evt.kind === 'cancel') {
      response = { requestId: row.requestId, answer: '', source: 'cancel' };
    } else {
      const answer = row.options?.[evt.choiceIndex];
      if (answer === undefined) return; // out-of-range / stale
      response = { requestId: row.requestId, answer, source: 'user' };
    }
    this.rememberResponder(row.requestId, evt.userId);
    await this.bridge.respond(response);
  }

  // -------------------------------------------------------------------------
  // Modal submission
  // -------------------------------------------------------------------------

  private async handleModalSubmit(evt: ClarifyModalSubmissionEvent): Promise<void> {
    const row = await this.store.get(evt.requestId);
    if (!row || row.surfaceType !== SURFACE) return;
    if (row.surfaceContext.botKey !== this.adapter.botKey) return;
    if (!gateAnswerer(row, evt.userId)) return;
    this.rememberResponder(row.requestId, evt.userId);
    await this.bridge.respond({
      requestId: row.requestId,
      answer: evt.answer,
      source: 'user',
    });
  }

  // -------------------------------------------------------------------------
  // Resolution
  // -------------------------------------------------------------------------

  private async onResolved(row: PendingClarify, response: ClarifyResponse | null): Promise<void> {
    if (row.surfaceType !== SURFACE) return;
    if (row.surfaceContext.botKey !== this.adapter.botKey) return;
    const chatId = row.surfaceContext.chatId;
    const messageTs = row.surfaceContext.messageTs;
    if (typeof chatId !== 'string' || typeof messageTs !== 'string') return;

    const answeredBy = this.responderById.get(row.requestId);
    this.responderById.delete(row.requestId);
    const blocks = clarifyResolvedBlocks(buildResolvedInput(row, response, answeredBy));
    await this.adapter.updateClarifyCard({ chatId, messageTs, blocks });
  }

  /** Bounded local memo of the responder's user id, drained on `onResolved`.
   *  The cap exists so a never-resolved respond (would be a bridge bug) can't
   *  leak unboundedly. */
  private rememberResponder(requestId: string, userId: string): void {
    if (this.responderById.size >= 1024) {
      const first = this.responderById.keys().next().value;
      if (first !== undefined) this.responderById.delete(first);
    }
    this.responderById.set(requestId, userId);
  }

  // -------------------------------------------------------------------------
  // Listing — used by the App Home "Waiting on you" section
  // -------------------------------------------------------------------------

  /** Pending Slack clarifies for this bot. Used by the home view. */
  async listPendingForBot(): Promise<PendingClarify[]> {
    const rows = await this.store.list({ surfaceType: SURFACE });
    return rows.filter((r) => r.surfaceContext.botKey === this.adapter.botKey);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gateAnswerer(row: PendingClarify, userId: string | undefined): boolean {
  if (row.answerableBy === 'anyone') return true;
  const originator = row.surfaceContext.originatorUserId;
  if (typeof originator !== 'string') return false;
  return userId === originator;
}

function buildResolvedInput(
  row: PendingClarify,
  response: ClarifyResponse | null,
  answeredBy: string | undefined,
): {
  question: string;
  answer: string;
  source: 'user' | 'cancel' | 'timeout-default' | 'timeout-no-default';
  answeredBy?: string;
} {
  if (!response) {
    return { question: row.question, answer: '', source: 'timeout-no-default' };
  }
  return {
    question: row.question,
    answer: response.answer,
    source: response.source,
    ...(answeredBy !== undefined && response.source === 'user' ? { answeredBy } : {}),
  };
}
