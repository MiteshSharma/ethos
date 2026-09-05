// The transcript of chats the agent WATCHES but does not answer.
//
// Observe mode (plan/phases/ambient-group-monitoring.md) gives a group chat a
// third outcome beside "reply" and "drop": record it. The gateway writes every
// `recordOnly` message here and returns before the channel filter, so nothing
// downstream — no lane, no `SessionStore`, no LLM turn — ever sees it. This
// store is that record, and the nightly digest is its only reader today.
//
// It is deliberately NOT the personality's `SessionStore`. A session is a
// conversation the agent is party to; these are conversations it is merely
// present for. Mixing them would put thousands of messages nobody addressed to
// the agent into the history every turn is assembled from.
//
// TRUST. Everything in `text` is untrusted third-party input: it was written
// by strangers in a room the agent does not moderate, and it was never
// addressed to the agent. A consumer that renders it into a prompt is putting
// attacker-controlled text in front of a model — it must fence it as data (the
// injection-defense prelude, an explicit "the following is quoted material"
// framing) and must not grant that turn tools. R9 does exactly this: the
// digest turn runs with `toolsetOverride: []`.

/** One observed message, as handed to {@link ChannelTranscriptStore.record}. */
export interface ChannelTranscriptRecord {
  /** `telegram` / `slack` / `discord` / `whatsapp`. */
  platform: string;
  /** Which configured bot watched this room. */
  botKey: string;
  chatId: string;
  /** Present only for platforms with sub-conversations. Part of the lane key. */
  threadId?: string;
  senderId: string;
  senderName?: string;
  /**
   * The message body. Redacted for secrets by the store on the way in; never
   * trust it as anything but quoted third-party text (see the file header).
   */
  text: string;
  /**
   * Platform message id. When present the row is keyed by it, so a later edit
   * of the same message REPLACES this row instead of appending a second one
   * (R8). When absent the row is simply inserted and can never be superseded.
   */
  messageId?: string;
  /**
   * When the platform says the message was sent (ms). What a reader is SHOWN
   * is ordered by this; what a consumer has already read is not (that is
   * {@link ChannelTranscriptMessage.id}), and retention is not either (that is
   * {@link recordedAt}, R7).
   *
   * Required, and required on purpose: `InboundMessage.sentAt` is optional on
   * the wire, and a store that quietly substituted a clock reading would make
   * "the platform told us when this was sent" indistinguishable from "we
   * guessed". The caller decides — the gateway passes `message.sentAt ??
   * Date.now()` — and the decision is visible at the call site rather than
   * buried in a default here.
   */
  sentAt: number;
  /** When we saw it (ms). What `retention.channelTranscript` prunes against. */
  recordedAt: number;
}

/** One row coming back out of the store. */
export interface ChannelTranscriptMessage {
  /**
   * Ingestion sequence: strictly increasing in the order the store accepted
   * rows, and the cursor {@link ChannelTranscriptStore.readSince} takes.
   *
   * It exists because `sentAt` cannot be one. A sender picks that value, it
   * arrives out of order, and a consumer that cursors on it skips whatever
   * shows up later carrying an older timestamp — which is the ordinary case
   * for a platform that delivers a message hours after it was written. This
   * number is set by the store when the row lands, so "everything after what
   * I last consumed" is a question that has an exact answer.
   *
   * On the row rather than on {@link ChannelTranscriptPage}, so a caller can
   * say how far it actually got: a page-level maximum is a second, derived
   * number that can disagree with the rows beside it, and the consumer
   * advances per row it delivered, not per page it was handed.
   *
   * An EDIT (see {@link ChannelTranscriptRecord.messageId}) rewrites the row
   * in place and does NOT move this number: a message already consumed stays
   * consumed, and the revision is not re-delivered.
   */
  id: number;
  laneKey: string;
  senderId: string;
  senderName?: string;
  text: string;
  messageId?: string;
  sentAt: number;
  recordedAt: number;
}

/** What one lane held in the requested window. */
export interface ChannelTranscriptPage {
  /**
   * INGESTION ORDER, oldest ingested first — ascending {@link
   * ChannelTranscriptMessage.id}, which is not `sentAt` order when a message
   * arrived late. When more rows qualify than `limit`, these are the FIRST
   * `limit` past the cursor: the page is one step of a forward drain, so what
   * the cap leaves out is what the NEXT read starts from.
   *
   * Not the newest `limit`. A consumer advances its cursor to the greatest id
   * it was handed, so anything left out has to sit above that id to survive;
   * newest-first put the leftovers below it and consumed them unread.
   */
  messages: ChannelTranscriptMessage[];
  /**
   * How many later-ingested rows past the cursor this page did not reach,
   * because `limit` stopped it first. `0` means the page is everything past
   * the cursor. This is the only truncation signal — there is no separate
   * boolean to disagree with it.
   *
   * A BACKLOG DEPTH, not a loss count. Because the page drains forward, every
   * row it counts is still above the greatest id in `messages` and is read by
   * the next call; it is what remains queued, not what was thrown away. R9
   * reports it as "N later messages … will be summarised on the next run".
   *
   * Every row it counts is UNCONSUMED — the page starts at the caller's cursor
   * — so the number never needs to be second-guessed at the call site.
   */
  omittedCount: number;
}

/** One watched room, for the Communications "Observed chats" section (R12). */
export interface ChannelLaneSummary {
  laneKey: string;
  platform: string;
  botKey: string;
  chatId: string;
  threadId?: string;
  /**
   * Messages whose `sentAt` falls in the `since` window — "messages today" on
   * the UI. Zero is a real answer: a lane that recorded nothing today is still
   * a watched lane and still listed.
   */
  count: number;
  /** Newest `sentAt` in the lane, ignoring `since`. */
  lastSentAt: number;
}

export interface ChannelTranscriptReadOptions {
  /**
   * How many rows one page may carry, taken from the OLDEST end of what is
   * past the cursor. Defaults to 500, the cap R9 puts on digest input. It
   * bounds a step of the drain, never the lane: the remainder is counted in
   * {@link ChannelTranscriptPage.omittedCount} and read by the next call.
   */
  limit?: number;
}

export interface ChannelLaneListOptions {
  /**
   * Keep only lanes whose key starts with this. Matched as a literal prefix,
   * never as a pattern — lane keys really do contain `%` and `_`.
   *
   * Build it with `transcriptLanePrefix(platform, botKey)` rather than by
   * hand: lane-key segments are URL-encoded, so a botKey carrying a reserved
   * character does not match the naive `` `${platform}:${botKey}:` `` template
   * and the caller silently gets back nothing.
   */
  laneKeyPrefix?: string;
  /** Window for {@link ChannelLaneSummary.count} (ms). Defaults to all time. */
  since?: number;
}

/**
 * Where observe mode writes, and where the digest reads.
 *
 * Async by contract even though the shipped implementation is synchronous —
 * the gateway awaits `record()` on the inbound path, and a future non-SQLite
 * backend should not have to change the call sites.
 */
export interface ChannelTranscriptStore {
  record(entry: ChannelTranscriptRecord): Promise<void>;
  /**
   * Messages in `laneKey` ingested AFTER `sinceId`, in ingestion order, capped
   * to the FIRST `limit` past the cursor. `0` reads the lane from the
   * beginning.
   *
   * A FORWARD DRAIN. Repeated with the cursor moved to the greatest id it
   * returned, this walks a lane from `sinceId` to its end without repeating or
   * skipping a row, however far behind the cap leaves the caller. Reading the
   * newest `limit` instead would strand every omitted row below the cursor the
   * caller then advances to, and consume it unread.
   *
   * The cursor is {@link ChannelTranscriptMessage.id} — an ingestion sequence,
   * never a timestamp. That is the whole point of this signature: a read
   * floored on `sentAt` cannot express "everything I have not consumed",
   * because a message can be recorded arbitrarily long after the moment it
   * claims to have been sent, and it then sits below any floor derived from
   * the clock. This read has no time window at all, so nothing can fall
   * beneath one. See {@link ChannelTranscriptPage.omittedCount} for what the
   * cap leaves behind.
   */
  readSince(
    laneKey: string,
    sinceId: number,
    options?: ChannelTranscriptReadOptions,
  ): Promise<ChannelTranscriptPage>;
  /** Every lane with at least one recorded message, newest-active first. */
  listLanes(options?: ChannelLaneListOptions): Promise<ChannelLaneSummary[]>;
  close(): void;
}
