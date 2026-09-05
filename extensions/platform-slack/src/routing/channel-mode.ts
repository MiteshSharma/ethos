// SUPERSEDED — this file should be deleted.
//
// The reply/record decision moved to `evaluateChannelMode` in
// `@ethosagent/core`: Slack, Telegram, Discord and WhatsApp each carried a
// copy of this matrix and they had already drifted. Slack's copy knew nothing
// about `observe`, so a channel set to observe would have been answered on
// every @mention.
//
// The local `shouldRespond` is gone rather than left to rot. What remains is a
// re-export, so anything still importing this path gets the one shared
// decision instead of a second implementation of it. Removing the file is a
// one-line follow-up; see plan/phases/ambient-group-monitoring.md R6.

export type { ChannelModeDecision, ChannelModeInputs } from '@ethosagent/core';
export { evaluateChannelMode } from '@ethosagent/core';
