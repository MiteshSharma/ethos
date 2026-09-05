import { z } from 'zod';

// `observe` records the room's messages and never replies in it — not even to
// an explicit @mention (see `evaluateChannelMode` in `@ethosagent/core`).
//
// The smallest of the four adapter enums: WhatsApp has no threads, so no
// `thread_follow`, and no `regex_match`.
export const ChannelModeSchema = z.enum(['all', 'mention_only', 'observe']);
export type ChannelMode = z.infer<typeof ChannelModeSchema>;

/**
 * What an unset `defaultMode` has always meant for this adapter: answer every
 * group message. The gate it replaces only special-cased `mention_only`, so
 * anything else — including absence — fell through to answering. Deliberately
 * NOT Discord's `mention_only` default: the gateway always passes an explicit
 * mode, so this governs direct embedders only, and flipping it would silence a
 * working one on upgrade.
 */
export const DEFAULT_CHANNEL_MODE: ChannelMode = 'all';
