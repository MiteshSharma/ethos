// SUPERSEDED — this file should be deleted.
//
// The reply/record decision moved to `evaluateChannelMode` in
// `@ethosagent/core`: Slack, Telegram, Discord and WhatsApp each carried a
// copy of this matrix and they had already drifted. Telegram's copy was the
// only one that knew `regex_match`, and none of them knew `observe`.
//
// One behaviour did NOT move with it. The shared evaluator takes
// `matchesPattern` as a thunk and never compiles a pattern itself, so the
// `try { new RegExp(p) } catch { return false }` that made a bad user-supplied
// pattern a non-match rather than a thrown error now lives in the closure the
// adapter passes (`index.ts`).
//
// The local `shouldRespond` is gone rather than left to rot. What remains is a
// re-export, so anything still importing this path gets the one shared
// decision instead of a second implementation of it. Removing the file is a
// one-line follow-up; see plan/phases/ambient-group-monitoring.md R6.

export type { ChannelModeDecision, ChannelModeInputs } from '@ethosagent/core';
export { evaluateChannelMode } from '@ethosagent/core';
