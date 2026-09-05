// The JSONL override store moved to `ChannelOverrideStore` in
// `@ethosagent/core` — one implementation for all four adapters (R6).
// Telegram's copy already indexed `{ mode, regexPattern? }` and already took
// the per-bot directory, so the shared store is shape-compatible here; what it
// adds is the mode enum as a constructor argument.
//
// What is left is the binding of Telegram's own mode enum to that generic,
// under the name the adapter already imports. No behaviour, no second
// implementation to drift.

import type { ChannelOverrideStore as CoreChannelOverrideStore } from '@ethosagent/core';
import type { ChannelMode } from '../config';

export type ChannelOverrideStore = CoreChannelOverrideStore<ChannelMode>;
