// The ONE decision every channel adapter makes about an inbound group message:
// do I reply to it, and do I record it?
//
// Slack, Telegram, Discord and WhatsApp each used to carry their own copy of a
// `shouldRespond` matrix. They had already drifted (Telegram grew
// `regex_match`; the other two had not), and the drift is invisible until a
// user reports that the same mode behaves differently on two platforms. This
// module is the single decision point; adapters supply the inputs and obey the
// answer.

/**
 * What the adapter must do with the message.
 *
 * `shouldReply` — run a full turn and answer.
 * `shouldRecord` — hand the message to the transcript store.
 *
 * `shouldRecord && !shouldReply` is the observe case; adapters stamp that on
 * the envelope as `InboundMessage.recordOnly`.
 */
export interface ChannelModeDecision {
  shouldReply: boolean;
  shouldRecord: boolean;
}

export interface ChannelModeInputs {
  /** A one-to-one conversation. Always answered, whatever the mode says. */
  isDm: boolean;
  /** The bot was @mentioned in this message. */
  isGroupMention: boolean;
  /**
   * The chat's resolved mode. Deliberately a plain `string`: each adapter owns
   * its own enum (Telegram alone has `regex_match`), and this module must not
   * grow a union of all four. An unrecognised value falls through to the
   * mention-only behaviour, which is the safe default.
   */
  channelMode: string;
  /** `thread_follow`: has the bot already posted in this thread? */
  hasBotPosted?: boolean;
  /**
   * `regex_match`: does the configured pattern match this message? A thunk, so
   * the caller keeps ownership of compiling the stored pattern and of deciding
   * what an invalid pattern means (adapters return `false`). Only called when
   * the mode is `regex_match`.
   */
  matchesPattern?: () => boolean;
}

// Returned by value on every call — a shared object would let one adapter's
// mutation of a decision leak into every other adapter's next decision.
const ENGAGE = (): ChannelModeDecision => ({ shouldReply: true, shouldRecord: true });
const IGNORE = (): ChannelModeDecision => ({ shouldReply: false, shouldRecord: false });
const OBSERVE = (): ChannelModeDecision => ({ shouldReply: false, shouldRecord: true });

/**
 * Decide whether to reply to — and whether to record — one inbound message.
 *
 * The order of the tests is load-bearing:
 *
 *   1. `isDm` — a direct message is always a conversation with the bot.
 *   2. `observe` — checked BEFORE the mention test. Observe mode never
 *      replies, not even to an explicit @mention. That is a product decision,
 *      not an oversight: a room set to observe is a room the operator has told
 *      the agent to be silent in, and an @mention that broke the silence would
 *      make "silent" conditional on what a third party types.
 *   3. `all` — reply to everything in the room.
 *   4. `isGroupMention` — the `mention_only` baseline, and the fallback for an
 *      unrecognised mode.
 *   5. `thread_follow` / `regex_match` — the two conditional modes.
 *
 * Anything that falls through is neither answered nor recorded: today's
 * behaviour, where an unmatched group message is dropped before an envelope
 * is built.
 */
export function evaluateChannelMode(inputs: ChannelModeInputs): ChannelModeDecision {
  if (inputs.isDm) return ENGAGE();
  if (inputs.channelMode === 'observe') return OBSERVE();
  if (inputs.channelMode === 'all') return ENGAGE();
  if (inputs.isGroupMention) return ENGAGE();
  if (inputs.channelMode === 'thread_follow' && inputs.hasBotPosted === true) return ENGAGE();
  if (inputs.channelMode === 'regex_match' && inputs.matchesPattern?.() === true) return ENGAGE();
  return IGNORE();
}
