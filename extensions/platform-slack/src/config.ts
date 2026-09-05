// Adapter-internal config types and zod schemas.
//
// `SlackAppConfig` here describes the shape the Slack adapter consumes at
// construction. The boot-level `slack.apps[]` list lives in
// `apps/ethos/src/config.ts` and is translated into this shape per app by
// `apps/ethos/src/commands/gateway.ts`.

import { z } from 'zod';

// `observe` records the channel's messages and never replies in it — not even
// to an explicit @mention (see `evaluateChannelMode` in `@ethosagent/core`).
export const ChannelModeSchema = z.enum(['mention_only', 'thread_follow', 'all', 'observe']);
export type ChannelMode = z.infer<typeof ChannelModeSchema>;

export const DEFAULT_CHANNEL_MODE: ChannelMode = 'mention_only';

export const BindingSchema = z.object({
  type: z.enum(['personality', 'team']),
  name: z.string(),
});
export type Binding = z.infer<typeof BindingSchema>;

export const ChannelOverrideSchema = z.object({
  id: z.string(),
  mode: ChannelModeSchema,
});
export type ChannelOverride = z.infer<typeof ChannelOverrideSchema>;

export const ChannelDefaultsSchema = z.object({
  channelMode: ChannelModeSchema.optional(),
});
export type ChannelDefaults = z.infer<typeof ChannelDefaultsSchema>;
