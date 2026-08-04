import type { DeliveryResult, OutboundMessage } from '@ethosagent/types';
import type { MessageDedupCache } from './dedup';
import { beginDelivery, confirmDelivery, type DeliveryBinding } from './delivery';

// ---------------------------------------------------------------------------
// Streaming draft edits (W3.1)
//
// Gateway-side machinery that turns an in-progress reply into a live-growing
// message on channels that support editing (Telegram, Slack). There is NO
// turn-start placeholder: the FIRST throttled flush is the first message
// (sent via `adapter.send`), and every later flush is an `adapter.editMessage`
// that carries the accumulated text. The final content lands as the last edit
// and is registered in the dedup cache via `record()` so a later duplicate
// `send()` of the same content is suppressed.
//
// The adapters already own chunk-reflow `editMessage` implementations; this
// module never touches them — it only sequences send/edit calls, throttles
// them, balances mid-stream markdown, folds a tool-progress line into the
// draft, and honors Telegram flood-waits.
// ---------------------------------------------------------------------------

/**
 * Balance or strip incomplete markdown so a mid-stream draft never renders as
 * garbage or gets rejected by a platform `parse_mode`. Applied to every
 * INTERMEDIATE edit; the final edit uses the true complete text.
 *
 * - An odd number of ``` fences closes the open code block.
 * - Unbalanced inline markers (`**`, `` ` ``) that remain after fence
 *   balancing are stripped from the tail so the platform parser stays happy.
 */
export function closeUnbalancedMarkup(text: string): string {
  let out = text;

  // 1. Code fences (```). An odd count means a block is open — close it.
  const fenceMatches = out.match(/```/g);
  if (fenceMatches && fenceMatches.length % 2 === 1) {
    // Ensure the closing fence sits on its own line.
    out = out.endsWith('\n') ? `${out}\`\`\`` : `${out}\n\`\`\``;
  }

  // Re-derive the fence-free view for inline-marker balancing so a backtick
  // inside a fence isn't miscounted.
  const withoutFences = out.replace(/```[\s\S]*?```/g, '');

  // 2. Bold markers (**). Odd count → strip the trailing dangling opener.
  const boldCount = (withoutFences.match(/\*\*/g) ?? []).length;
  if (boldCount % 2 === 1) {
    const idx = out.lastIndexOf('**');
    if (idx !== -1) out = out.slice(0, idx) + out.slice(idx + 2);
  }

  // 3. Inline code (single backtick, not part of a fence). Odd count → strip
  //    the trailing dangling opener.
  const inlineTicks = (withoutFences.match(/`/g) ?? []).length;
  if (inlineTicks % 2 === 1) {
    const idx = out.lastIndexOf('`');
    // Don't touch a fence tick.
    if (idx !== -1 && out.slice(idx - 2, idx + 1) !== '```') {
      out = out.slice(0, idx) + out.slice(idx + 1);
    }
  }

  return out;
}

/**
 * Parse a Telegram flood-wait `retry_after` (seconds) from an adapter error
 * string. grammy surfaces 429s as `... (429: Too Many Requests: retry after N)`.
 * Returns the seconds to wait, or `null` when the error is not a flood-wait.
 */
export function parseRetryAfterSeconds(error: string | undefined): number | null {
  if (!error) return null;
  const m = error.match(/retry[ _]after[ :=]?\s*(\d+)/i);
  if (m?.[1]) {
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  // Fall back to a generic 429 signal with no explicit delay.
  if (/\b429\b|too many requests/i.test(error)) return 1;
  return null;
}

/** The subset of PlatformAdapter the streamer drives. */
export interface StreamAdapter {
  send(chatId: string, message: OutboundMessage): Promise<DeliveryResult>;
  editMessage?(chatId: string, messageId: string, text: string): Promise<DeliveryResult>;
}

export interface DraftStreamerOptions {
  adapter: StreamAdapter;
  chatId: string;
  threadId: string | undefined;
  sessionKey: string;
  dedup: MessageDedupCache;
  /**
   * Durable delivery-obligation ledger binding (item 9). Threaded in here
   * rather than reported back through `finalize()`'s return value because the
   * obligation must be written BEFORE the platform call, and only this class
   * knows when that call happens — a return value arrives after the fact and
   * cannot protect the crash window the ledger exists to close. `finalize()`
   * returning `void` is also a documented contract (callers gate on
   * `hasDelivered`); inverting it would ripple for no gain.
   */
  delivery?: DeliveryBinding;
  /** Minimum ms between successive edits (the first send is never throttled). */
  minEditIntervalMs?: number;
  /** Injectable clock for deterministic tests. Defaults to `Date.now`. */
  now?: () => number;
  /** Injectable sleep for deterministic tests. Defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Called after two consecutive flood-waits — the gateway disables streaming
   *  for this chat on future turns. */
  onFloodDisable?: () => void;
}

const PROGRESS_LINE_MAX = 80;

/**
 * Drives a single turn's live draft. All adapter interactions are serialized
 * through an internal promise chain so overlapping `pushText`/`pushProgress`
 * calls (fired-and-forgotten by the gateway turn loop) can never race two
 * edits. `finalize()` awaits the chain, then lands the true final content.
 */
export class DraftStreamer {
  private readonly adapter: StreamAdapter;
  private readonly chatId: string;
  private readonly threadId: string | undefined;
  private readonly sessionKey: string;
  private readonly dedup: MessageDedupCache;
  private readonly delivery: DeliveryBinding | undefined;
  private readonly minEditIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onFloodDisable: (() => void) | undefined;

  private messageId: string | undefined;
  private latestText = '';
  private progressLine: string | undefined;
  private lastRenderedBody = '';
  private lastEditAt = 0;
  private consecutiveFloodWaits = 0;
  private degraded = false;
  private chain: Promise<void> = Promise.resolve();

  constructor(opts: DraftStreamerOptions) {
    this.adapter = opts.adapter;
    this.chatId = opts.chatId;
    this.threadId = opts.threadId;
    this.sessionKey = opts.sessionKey;
    this.dedup = opts.dedup;
    this.delivery = opts.delivery;
    this.minEditIntervalMs = opts.minEditIntervalMs ?? 2500;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.onFloodDisable = opts.onFloodDisable;
  }

  /** True once at least one draft message has been delivered. */
  get hasDelivered(): boolean {
    return this.messageId !== undefined;
  }

  /** True once repeated flood-waits disabled streaming for this chat. */
  get isDegraded(): boolean {
    return this.degraded;
  }

  /** Fold newly-accumulated assistant text into the draft (throttled). New
   *  text supersedes any transient progress line. */
  pushText(fullText: string): Promise<void> {
    this.latestText = fullText;
    this.progressLine = undefined;
    return this.enqueue(() => this.maybeFlush());
  }

  /** Fold an `audience:'user'` tool-progress message into the draft as the
   *  last italic line (throttled). */
  pushProgress(message: string): Promise<void> {
    const line = message.replace(/\s+/g, ' ').trim().slice(0, PROGRESS_LINE_MAX);
    if (line) this.progressLine = line;
    return this.enqueue(() => this.maybeFlush());
  }

  /**
   * Land the true final content. Registers the final content in the dedup cache
   * ONLY when it actually reached the user — either the terminal edit succeeded
   * or `finalText` was already the on-screen body. A non-flood edit failure
   * leaves the cache un-stamped so a later non-streaming `send()` of the same
   * content is NOT silently suppressed. Callers gate their own delivery on
   * `hasDelivered`, so this returns nothing.
   *
   * When a delivery ledger is bound, a durable obligation wraps the TERMINAL
   * edit — the same "record before, confirm only on success" shape the
   * non-streaming reply paths use.
   */
  async finalize(finalText: string): Promise<void> {
    await this.chain;
    if (this.messageId === undefined) return;
    // The final content is already on screen when it equals the last rendered
    // body (an earlier send/edit landed it) — that counts as delivered.
    let finalRendered = finalText === this.lastRenderedBody;
    if (finalText && finalText !== this.lastRenderedBody && this.adapter.editMessage) {
      // Obligation covers the terminal edit ONLY. Intermediate draft flushes
      // are deliberately untracked: each is superseded by this edit, so
      // redelivering one after a crash would ship a half-written reply.
      // The edit itself targets an existing draft message and so needs no
      // threadId — but a REDELIVERY is a fresh `send()` (the draft message id
      // does not survive a restart), and that send does. Take it from the same
      // field the initial draft send used.
      const obligationId = await beginDelivery(this.delivery, {
        chatId: this.chatId,
        sessionId: this.sessionKey,
        threadId: this.threadId,
        content: finalText,
      });
      let attempts = 0;
      // Try the final edit; honor a single flood-wait so the true final lands.
      while (attempts < 2) {
        const res = await this.adapter.editMessage(this.chatId, this.messageId, finalText);
        if (res.ok) {
          this.lastRenderedBody = finalText;
          finalRendered = true;
          break;
        }
        const retry = parseRetryAfterSeconds(res.error);
        if (retry === null) break;
        attempts++;
        if (attempts >= 2) break;
        await this.sleep(retry * 1000);
      }
      // Confirm ONLY when the edit actually landed. A failed final edit leaves
      // the obligation `pending`, so the next boot sweep redelivers it — as a
      // fresh `send()`, since the draft message id does not survive a restart.
      if (finalRendered) await confirmDelivery(this.delivery, obligationId);
    }
    // Register the final content so a later duplicate send() is suppressed —
    // but only when the user actually saw it. Stamping the cache on a failed
    // final edit would drop a legitimate fallback send of the same content.
    if (finalRendered) this.dedup.record(this.sessionKey, finalText);
  }

  private enqueue(fn: () => Promise<void>): Promise<void> {
    // Swallow inside fn (maybeFlush never throws), so the chain never rejects.
    this.chain = this.chain.then(fn);
    return this.chain;
  }

  private composeBody(): string {
    const base = closeUnbalancedMarkup(this.latestText).trimEnd();
    if (this.progressLine) {
      return base.length > 0 ? `${base}\n_${this.progressLine}_` : `_${this.progressLine}_`;
    }
    return base;
  }

  private async maybeFlush(): Promise<void> {
    if (this.degraded) return;
    const body = this.composeBody();
    if (!body || body === this.lastRenderedBody) return;
    // The first message is never throttled — a fast first paint is the point.
    if (this.messageId !== undefined) {
      if (this.now() - this.lastEditAt < this.minEditIntervalMs) return;
    }
    await this.doFlush(body);
  }

  private async doFlush(body: string): Promise<void> {
    try {
      if (this.messageId === undefined) {
        const res = await this.adapter.send(this.chatId, {
          text: body,
          parseMode: 'markdown',
          ...(this.threadId ? { threadId: this.threadId } : {}),
        });
        if (res.ok && res.messageId) {
          this.messageId = res.messageId;
          this.lastRenderedBody = body;
          this.lastEditAt = this.now();
          // First-chunk message registered when sent (no placeholder exemption).
          this.dedup.record(this.sessionKey, body);
        }
        return;
      }
      if (!this.adapter.editMessage) return;
      const res = await this.adapter.editMessage(this.chatId, this.messageId, body);
      if (res.ok) {
        this.lastRenderedBody = body;
        this.lastEditAt = this.now();
        this.consecutiveFloodWaits = 0;
        return;
      }
      const retry = parseRetryAfterSeconds(res.error);
      if (retry === null) {
        // Non-flood error — drop this edit and keep going. Reset the flood
        // counter so only truly BACK-TO-BACK flood-waits (no success and no
        // other error between them) trip the disable.
        this.consecutiveFloodWaits = 0;
        return;
      }
      this.consecutiveFloodWaits++;
      if (this.consecutiveFloodWaits >= 2) {
        // Two consecutive flood-waits → give up streaming for this chat.
        this.degraded = true;
        this.onFloodDisable?.();
        return;
      }
      await this.sleep(retry * 1000);
    } catch {
      // An adapter throwing must never break the turn — the final send/edit
      // still runs in finalize(). Drop this intermediate flush silently.
    }
  }
}
