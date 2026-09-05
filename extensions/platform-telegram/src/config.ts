import { z } from 'zod';

// `observe` records the chat's messages and never replies in it — not even to
// an explicit @mention (see `evaluateChannelMode` in `@ethosagent/core`).
export const ChannelModeSchema = z.enum([
  'mention_only',
  'thread_follow',
  'all',
  'regex_match',
  'observe',
]);
export type ChannelMode = z.infer<typeof ChannelModeSchema>;

export const DEFAULT_CHANNEL_MODE: ChannelMode = 'mention_only';
