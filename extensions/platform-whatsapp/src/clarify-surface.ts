// WhatsAppClarifySurface — wires a WhatsApp bot to the clarify protocol.
//
// WhatsApp is a TEXT-ONLY clarify surface. Baileys 7's `AnyMessageContent`
// has no sendable button or list variant (only `buttonReply` / `listReply`,
// which reply to interactive messages someone *else* sent), and the adapter's
// inbound parser decodes only `conversation` / `extendedTextMessage` /
// media captions — never `buttonsResponseMessage` or `listResponseMessage`.
// So the option card in `./clarify` cannot be delivered *or* correlated on
// this transport; this surface uses `buildNumberedFallback` and correlates a
// plain numbered (or exact-label) reply instead.
//
//   1. When the agent calls `clarify(...)`, the bridge fires `present()`. The
//      surface sends the question — numbered when `options` are present, bare
//      prose when free-form — and writes `(chatId, botKey, originatorUserId?)`
//      back into the persisted row so the reply can find it.
//   2. Replies arrive as ordinary WhatsApp messages — the gateway calls
//      `correlateMessage()` BEFORE the safety filter's mention gate; a match
//      short-circuits the normal pipeline and resolves the clarify directly.
//
// There is no `onResolved` teardown: the adapter declares
// `canEditMessage = false`, so a presented prompt cannot be edited in place.
// The agent's own next message is the resolution the user sees.
//
// See plan/phases/tool_clarity_plan.md and the Telegram surface it mirrors.

import type { ClarifyBridge } from '@ethosagent/core';
import type {
  ClarifyResponse,
  ClarifyStore,
  DeliveryResult,
  InboundMessage,
  OutboundMessage,
  PendingClarify,
} from '@ethosagent/types';
import { buildNumberedFallback } from './clarify';

const SURFACE: 'whatsapp' = 'whatsapp';
const CANCEL_COMMAND = '/cancel';

/** Subset of the WhatsApp adapter the surface depends on — structural so
 *  tests can pass a stub without touching Baileys. */
export interface WhatsAppClarifyAdapter {
  readonly botKey: string;
  send(chatId: string, message: OutboundMessage): Promise<DeliveryResult>;
}

/** Per-session routing slice the surface needs to send the prompt. */
export interface SessionRoutingForClarify {
  chatId: string;
  /** Platform user id that triggered this turn — the `answerable_by:
   *  'originator'` gate. Absent when the adapter didn't stamp one. */
  requesterUserId?: string;
}

export type SessionRoutingResolver = (sessionId: string) => SessionRoutingForClarify | undefined;

export interface WhatsAppClarifySurfaceConfig {
  adapter: WhatsAppClarifyAdapter;
  bridge: ClarifyBridge;
  store: ClarifyStore;
  getSessionRouting: SessionRoutingResolver;
}

export class WhatsAppClarifySurface {
  private readonly adapter: WhatsAppClarifyAdapter;
  private readonly bridge: ClarifyBridge;
  private readonly store: ClarifyStore;
  private readonly getSessionRouting: SessionRoutingResolver;

  constructor(cfg: WhatsAppClarifySurfaceConfig) {
    this.adapter = cfg.adapter;
    this.bridge = cfg.bridge;
    this.store = cfg.store;
    this.getSessionRouting = cfg.getSessionRouting;

    this.bridge.registerPresenter(SURFACE, (row) => this.present(row));
  }

  /**
   * Present a pending clarify to the WhatsApp chat as text. Writes the chat
   * and originator back into the persisted row so a later reply — or a
   * post-restart sweep — can find it.
   */
  async present(row: PendingClarify): Promise<void> {
    if (row.surfaceType !== SURFACE) return;
    const routing = this.getSessionRouting(row.sessionId);
    if (!routing) {
      // No routing means the gateway lost track of which chat — the turn
      // will time out and the bridge will fire `timeout-default` or
      // `timeout-no-default`. Nothing to send; nothing to wedge.
      return;
    }

    const prompt = formatPrompt(row);
    // The clarify protocol carries bare strings; the builder wants
    // `{ label, value }` pairs. The two are the same thing here — the label
    // the user reads is the answer handed back to the agent.
    const options = (row.options ?? []).map((o) => ({ label: o, value: o }));
    const text = options.length > 0 ? buildNumberedFallback(prompt, options) : prompt;

    const result = await this.adapter.send(routing.chatId, { text });
    if (!result.ok) {
      // A send failure (e.g. the socket dropped) leaves the row persisted;
      // the bridge timer will still fire and clean up. Don't throw — we
      // mustn't wedge the turn.
      return;
    }

    await this.store.update(row.requestId, {
      surfaceContext: {
        ...row.surfaceContext,
        chatId: routing.chatId,
        botKey: this.adapter.botKey,
        ...(routing.requesterUserId !== undefined
          ? { originatorUserId: routing.requesterUserId }
          : {}),
      },
    });
  }

  /**
   * Inbound-message correlator: returns a clarify response when the message
   * answers a pending WhatsApp clarify in the same chat; otherwise null. Run
   * by the gateway BEFORE the channel safety filter's mention gate so an
   * approved sender's answer isn't treated as a fresh agent prompt.
   *
   * With `options`, only a valid choice number or an exact (case-insensitive)
   * option label resolves the request — unrelated prose falls through to the
   * normal pipeline rather than silently answering the agent with it.
   */
  async correlateMessage(message: InboundMessage): Promise<ClarifyResponse | null> {
    if (message.platform !== SURFACE) return null;
    if (message.botKey !== this.adapter.botKey) return null;

    const text = (message.text ?? '').trim();
    if (!text) return null;

    const rows = await this.store.list({ surfaceType: SURFACE });
    const target = rows.find(
      (r) =>
        r.surfaceContext.chatId === message.chatId &&
        r.surfaceContext.botKey === this.adapter.botKey,
    );
    if (!target) return null;
    if (!gateAnswerer(target, message.userId)) return null;

    // D7 — a human acted on this surface; a background job's next question
    // may route here instead of always falling back to its origin lane.
    this.bridge.recordPresence(SURFACE);

    if (text.toLowerCase() === CANCEL_COMMAND) {
      return { requestId: target.requestId, answer: '', source: 'cancel' };
    }

    const options = target.options ?? [];
    if (options.length === 0) {
      return { requestId: target.requestId, answer: text, source: 'user' };
    }

    const answer = matchOption(text, options);
    if (answer === undefined) return null;
    return { requestId: target.requestId, answer, source: 'user' };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve a reply to one of the presented options: the 1-based number the
 *  numbered fallback printed, or the option label typed verbatim. */
function matchOption(text: string, options: string[]): string | undefined {
  const n = Number(text);
  if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1];
  const lowered = text.toLowerCase();
  return options.find((o) => o.toLowerCase() === lowered);
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
    lines.push(`no default — answer within ${minutes}m or reply /cancel`);
  }
  return lines.join('\n');
}
