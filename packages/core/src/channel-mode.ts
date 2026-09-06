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
   * The chat's resolved mode. Deliberately a plain `string` rather than a
   * union: each adapter owns its own enum (Telegram alone has `regex_match`),
   * and a compile-time union would not help anyway — the value arrives from a
   * per-chat override store on disk, so it is runtime input, not a literal.
   *
   * A value outside `supportedModes` is FAIL-CLOSED: neither answered nor
   * recorded. See `evaluateChannelMode`.
   */
  channelMode: string;
  /**
   * The modes THIS adapter offers — its own enum, not the union of everyone's.
   * Every shipped adapter passes the `CHANNEL_MODES` const its
   * `ChannelModeSchema` is built from, so the set that validates a WRITE
   * (`ChannelOverrideStore.set`, typed to the adapter's `Mode`) and the set
   * that governs a READ are the same list.
   *
   * Required, not optional with a union default, and that is the point: a
   * union default is a hole a new adapter falls into by writing nothing. A
   * missing declaration is a compile error instead.
   *
   * Why per-adapter rather than the union of all four enums (which is what
   * this was): a mode one platform does not offer is NOT safely "not
   * applicable here". `regex_match` under the union was recognised on Slack,
   * which has no `regex_match` and therefore supplies no `matchesPattern` —
   * so `triageMessage` dropped every message unrecorded while the mention
   * path, the join greeting, the `link_shared` unfurl and `/ethos ask` all
   * fell through to the answering `isGroupMention` branch. A channel that
   * records nothing and speaks on four paths, from a mode string no Slack
   * surface can write. The union also degrades structurally: every mode added
   * to any one adapter becomes "known" to the other three, whose branches for
   * it do not exist.
   */
  supportedModes: readonly string[];
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
 *   1. `isDm` — a direct message is always a conversation with the bot. It
 *      outranks the mode because a DM is not a room: there is no third party
 *      whose privacy a mode could be protecting, and `observe` — the silent
 *      mode that exists today — already does not apply to one. An unknown
 *      mode is treated the same way for the same reason; the alternative
 *      makes a bad override string deafen the bot to its own owner, with no
 *      channel left to say so through.
 *   2. A mode outside `supportedModes` — dropped, before any other test. This
 *      adapter cannot know what a mode it does not offer is for, and the modes
 *      that get added are silent ones; a downgraded binary reading a newer
 *      mode out of a shared override store, a mode copied from another
 *      platform's override file, or a hand-edited typo must not become an
 *      answering bot in a room that asked for silence. `IGNORE` rather than
 *      `OBSERVE` because it is already what an unmatched recognised mode does,
 *      and because recording is itself an act on a stranger's message that an
 *      unreadable mode cannot consent to.
 *   3. `observe` — checked BEFORE the mention test. Observe mode never
 *      replies, not even to an explicit @mention. That is a product decision,
 *      not an oversight: a room set to observe is a room the operator has told
 *      the agent to be silent in, and an @mention that broke the silence would
 *      make "silent" conditional on what a third party types.
 *   4. `all` — reply to everything in the room.
 *   5. `isGroupMention` — the `mention_only` baseline.
 *   6. `thread_follow` / `regex_match` — the two conditional modes.
 *
 * Anything that falls through is neither answered nor recorded: today's
 * behaviour, where an unmatched group message is dropped before an envelope
 * is built.
 */
export function evaluateChannelMode(inputs: ChannelModeInputs): ChannelModeDecision {
  if (inputs.isDm) return ENGAGE();
  if (!inputs.supportedModes.includes(inputs.channelMode)) return IGNORE();
  if (inputs.channelMode === 'observe') return OBSERVE();
  if (inputs.channelMode === 'all') return ENGAGE();
  if (inputs.isGroupMention) return ENGAGE();
  if (inputs.channelMode === 'thread_follow' && inputs.hasBotPosted === true) return ENGAGE();
  if (inputs.channelMode === 'regex_match' && inputs.matchesPattern?.() === true) return ENGAGE();
  return IGNORE();
}
