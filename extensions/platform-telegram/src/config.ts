import { z } from 'zod';

// `observe` records the chat's messages and never replies in it — not even to
// an explicit @mention (see `evaluateChannelMode` in `@ethosagent/core`).
// The modes THIS adapter offers, and the single source `ChannelModeSchema` is
// built from. Passed to `evaluateChannelMode` as `supportedModes` so the enum
// that validates a WRITE and the set that governs a READ are the same list —
// a mode from another platform's override file (or a newer build) is refused
// here rather than falling through to an answering branch this adapter has no
// implementation for.
export const CHANNEL_MODES = [
  'mention_only',
  'thread_follow',
  'all',
  'regex_match',
  'observe',
] as const;
export const ChannelModeSchema = z.enum(CHANNEL_MODES);
export type ChannelMode = z.infer<typeof ChannelModeSchema>;

export const DEFAULT_CHANNEL_MODE: ChannelMode = 'mention_only';
