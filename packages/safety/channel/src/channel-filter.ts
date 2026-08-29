import type Database from '@ethosagent/sqlite';
import type { InboundMessage, PriorContextEntry } from '@ethosagent/types';
import { generateCode } from './pairing-store';

// ---------------------------------------------------------------------------
// Config interfaces
// ---------------------------------------------------------------------------

export interface ChannelPlatformConfig {
  /**
   * Explicit on/off switch for the whole filter on this platform.
   * When omitted (the default), the filter is enabled and behaves as before.
   * Set `false` to fully bypass the filter for this platform.
   */
  enabled?: boolean;
  /** Owner user ID — always allowed, immutable. */
  ownerUserId?: string;
  /** Additional allowed senders (user IDs or email globs). */
  recipientAllowlist?: string[];
  /**
   * Policy for DMs from non-allowlisted senders.
   * Applies only to DMs; group messages always use allowlist check only.
   */
  dmPolicy?: 'pairing' | 'allowlist' | 'queue' | 'reject' | 'silent-drop';
  /**
   * Context visibility filter.
   * 'all' (default): pass everything through.
   * 'allowlist': strip quoted/threaded content from non-allowlisted senders,
   *   and drop the channel-history lines they authored. History the adapter
   *   did not attribute per line is dropped whole.
   * 'allowlist_quote': alias for 'allowlist'.
   */
  contextVisibility?: 'all' | 'allowlist' | 'allowlist_quote';
}

/** Full config — keyed by platform name (e.g. 'telegram', 'discord', 'email'). */
export type ChannelFilterConfig = Record<string, ChannelPlatformConfig>;

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export interface ChannelFilterResult {
  action: 'allow' | 'drop' | 'pairing_reply';
  /** The reply text to send when action === 'pairing_reply'. */
  reply?: string;
  /** When set, the caller should use this text instead of message.text. */
  strippedText?: string;
  /**
   * When set, the caller should use this instead of `message.priorContext`.
   * The empty string means nothing survived the filter and the caller should
   * drop `priorContext` (and `priorContextEntries`) from the message
   * altogether. Undefined means the filter did not rewrite it.
   */
  strippedPriorContext?: string;
}

// ---------------------------------------------------------------------------
// Glob matching (email only — simple suffix match for *@domain.com)
// ---------------------------------------------------------------------------

function matchesGlob(pattern: string, value: string): boolean {
  if (!pattern.includes('*')) return pattern === value;
  // Only handle leading wildcard: *@domain.com
  const suffix = pattern.replace(/^\*/, '');
  return value.endsWith(suffix);
}

function isInAllowlist(allowlist: string[], senderId: string): boolean {
  return allowlist.some((entry) => matchesGlob(entry, senderId));
}

/**
 * Allowlist-only check: is this sender approved to talk to the bot at all?
 * Mirrors the `senderAllowed` decision inside `checkMessage` (steps 2–3) but
 * exposes it on its own so callers can authorize side-channels (e.g. the
 * clarify correlator) without re-running mention gating or pairing flow.
 */
export function isSenderAllowed(
  message: InboundMessage,
  config: ChannelPlatformConfig | undefined,
): boolean {
  if (!config) return true; // backward-compat: no platform config means no filter
  if (config.enabled === false) return true; // filter disabled for this platform
  const senderId = message.userId ?? '';
  const allowlist: string[] = [];
  if (config.ownerUserId) allowlist.push(config.ownerUserId);
  if (config.recipientAllowlist) allowlist.push(...config.recipientAllowlist);
  if (allowlist.length === 0) return false;
  return isInAllowlist(allowlist, senderId);
}

// ---------------------------------------------------------------------------
// Core filter
// ---------------------------------------------------------------------------

/**
 * Evaluate an inbound message against the per-platform config.
 *
 * Logic order:
 * 0. config.enabled === false → allow (filter explicitly disabled for platform).
 * 1. No platform config → allow (backward compat).
 * 2. Build effective allowlist = [ownerUserId, ...recipientAllowlist].
 * 3. Sender in allowlist → proceed to step 6.
 * 4. Not allowlisted + group → drop.
 * 5. Not allowlisted + DM → apply dmPolicy.
 * 6. Allowlisted + group + no mention → drop (mention gating).
 * 7. Context visibility filter — quoted text (7a) and channel history (7b).
 * 8. → allow.
 */
export function checkMessage(
  message: InboundMessage,
  config: ChannelPlatformConfig | undefined,
  pairingDb?: Database.Database,
): ChannelFilterResult {
  // Step 1: no platform config → backward compat allow
  if (!config) return { action: 'allow' };

  // Step 0: filter explicitly disabled for this platform → allow everything
  if (config.enabled === false) return { action: 'allow' };

  const senderId = message.userId ?? '';

  // Step 2: effective allowlist
  const allowlist: string[] = [];
  if (config.ownerUserId) allowlist.push(config.ownerUserId);
  if (config.recipientAllowlist) allowlist.push(...config.recipientAllowlist);

  const senderAllowed = allowlist.length === 0 ? false : isInAllowlist(allowlist, senderId);

  // Step 3 / 4 / 5: allowlist check
  if (!senderAllowed) {
    // Step 4: not allowlisted + group → silent drop
    if (!message.isDm) {
      return { action: 'drop' };
    }

    // Step 5: not allowlisted + DM → apply dmPolicy
    const policy = config.dmPolicy ?? 'pairing';
    switch (policy) {
      case 'allowlist':
      case 'reject':
      case 'silent-drop':
      case 'queue':
        return { action: 'drop' };

      case 'pairing': {
        if (!pairingDb) {
          // No pairing DB wired — fall back to drop
          return { action: 'drop' };
        }
        const code = generateCode(pairingDb, senderId, message.platform);
        if (code === null) {
          // Rate-limited — silently drop; user already got a code recently
          return { action: 'drop' };
        }
        const reply = `To talk with this agent, ask the owner to run: /allow ${code}`;
        return { action: 'pairing_reply', reply };
      }
    }
  }

  // Step 6: allowlisted sender in group without mention → drop (mention gating, 1c)
  // Owner bypasses mention gate — must be able to run /allow from any channel.
  if (!message.isDm && !message.isGroupMention && senderId !== config.ownerUserId) {
    return { action: 'drop' };
  }

  // Step 7: context visibility filter (1d)
  // The filter owns every context-carrying field on the envelope, not just
  // `text`: quoted content (7a) and adapter-supplied channel history (7b).
  const visibility = config.contextVisibility ?? 'all';
  if (visibility !== 'allowlist' && visibility !== 'allowlist_quote') {
    // Step 8: allow
    return { action: 'allow' };
  }

  const result: ChannelFilterResult = { action: 'allow' };

  // Step 7a: quoted / replied-to message.
  // Only strip when replyToUserId is explicitly set AND non-allowlisted.
  // If replyToUserId is absent (adapter can't provide it), do not strip.
  if (
    message.replyToId !== undefined &&
    message.replyToUserId !== undefined &&
    !isInAllowlist(allowlist, message.replyToUserId)
  ) {
    result.strippedText =
      '[quoted content from non-allowlisted sender removed]\n' +
      message.text.replace(/^>.*\n?/gm, '').trim();
  }

  // Step 7b: adapter-supplied channel/thread history. Unlike 7a this is
  // fail-closed — a history blob the adapter did not attribute per line
  // cannot be checked against the allowlist, so none of it passes.
  if (message.priorContext !== undefined) {
    const filtered = filterPriorContext(message.priorContextEntries, allowlist);
    if (filtered !== undefined) result.strippedPriorContext = filtered;
  }

  return result;
}

/**
 * Keep only the history lines whose author is on the allowlist.
 *
 * Returns `undefined` when every line survives (the caller keeps the adapter's
 * own rendering, preamble and all), the empty string when none does, and the
 * surviving lines otherwise.
 */
function filterPriorContext(
  entries: PriorContextEntry[] | undefined,
  allowlist: string[],
): string | undefined {
  if (entries === undefined) return '';
  const kept = entries.filter(
    (entry) => entry.userId !== undefined && isInAllowlist(allowlist, entry.userId),
  );
  // Order matters: an empty `entries` alongside a non-empty `priorContext` is
  // an unattributed blob, and must drop rather than count as "nothing removed".
  if (kept.length === 0) return '';
  if (kept.length === entries.length) return undefined;
  const lines = kept.map((entry) => entry.text).join('\n');
  return `[channel history — lines from non-allowlisted senders removed]\n${lines}`;
}
