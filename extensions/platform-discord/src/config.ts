import { z } from 'zod';

// `observe` records the room's messages and never replies in it — not even to
// an explicit @mention (see `evaluateChannelMode` in `@ethosagent/core`).
export const ChannelModeSchema = z.enum(['mention_only', 'thread_follow', 'all', 'observe']);
export type ChannelMode = z.infer<typeof ChannelModeSchema>;

export const DEFAULT_CHANNEL_MODE: ChannelMode = 'mention_only';

export const BindingSchema = z.object({
  type: z.enum(['personality', 'team']),
  name: z.string(),
});
export type Binding = z.infer<typeof BindingSchema>;
