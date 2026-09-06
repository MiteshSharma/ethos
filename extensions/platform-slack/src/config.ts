// Adapter-internal config types and zod schemas.
//
// `SlackAppConfig` here describes the shape the Slack adapter consumes at
// construction. The boot-level `slack.apps[]` list lives in
// `apps/ethos/src/config.ts` and is translated into this shape per app by
// `apps/ethos/src/commands/gateway.ts`.

import { z } from 'zod';

// `observe` records the channel's messages and never replies in it — not even
// to an explicit @mention (see `evaluateChannelMode` in `@ethosagent/core`).
// The modes THIS adapter offers, and the single source `ChannelModeSchema` is
// built from. Passed to `evaluateChannelMode` as `supportedModes` so the enum
// that validates a WRITE and the set that governs a READ are the same list —
// a mode from another platform's override file (or a newer build) is refused
// here rather than falling through to an answering branch this adapter has no
// implementation for.
export const CHANNEL_MODES = ['mention_only', 'thread_follow', 'all', 'observe'] as const;
export const ChannelModeSchema = z.enum(CHANNEL_MODES);
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
