import { z } from 'zod';

// `observe` records the room's messages and never replies in it — not even to
// an explicit @mention (see `evaluateChannelMode` in `@ethosagent/core`).
//
// The smallest of the four adapter enums: WhatsApp has no threads, so no
// `thread_follow`, and no `regex_match`.
// The modes THIS adapter offers, and the single source `ChannelModeSchema` is
// built from. Passed to `evaluateChannelMode` as `supportedModes` so the enum
// that validates a WRITE and the set that governs a READ are the same list —
// a mode from another platform's override file (or a newer build) is refused
// here rather than falling through to an answering branch this adapter has no
// implementation for.
export const CHANNEL_MODES = ['all', 'mention_only', 'observe'] as const;
export const ChannelModeSchema = z.enum(CHANNEL_MODES);
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
