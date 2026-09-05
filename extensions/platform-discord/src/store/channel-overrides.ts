// The JSONL override store moved to `ChannelOverrideStore` in
// `@ethosagent/core` — one implementation for all four adapters (R6). Discord's
// copy indexed a bare mode and joined `botKey` onto the platform directory
// itself; the shared one indexes `{ mode, regexPattern? }` and takes the
// per-bot directory, so callers join.
//
// What is left here is the binding of Discord's own mode enum to that generic,
// under the name the adapter already imports. No behaviour, no second
// implementation to drift.

import type { ChannelOverrideStore as CoreChannelOverrideStore } from '@ethosagent/core';
import type { ChannelMode } from '../config';

export type ChannelOverrideStore = CoreChannelOverrideStore<ChannelMode>;
