// Sender authorization for Slack's out-of-band surfaces — slash commands and
// the App Home tab. Neither is an inbound platform message, so neither ever
// reaches the gateway's `checkMessage`: this predicate is the only gate they
// get, which is why it is default-deny. An absent or empty allowlist
// authorizes nobody (CHS-001); the wiring layer, not this module, decides who
// is on the list.
//
// Discord's `commands/memory.ts` takes the same posture (`?.includes` on an
// undefined list denies). Keep the two in step.

/** Whether `userId` may drive the bot's slash commands and App Home data. */
export function isUserAuthorized(userId: string, allowedUsers: string[] | undefined): boolean {
  if (!allowedUsers || allowedUsers.length === 0) return false;
  return allowedUsers.includes(userId);
}

/** Refusal shown to a denied slash-command caller. Names the config keys an
 *  operator has to change so the failure mode is actionable, not silent. */
export const SLASH_DENIED_TEXT =
  'You are not authorized to use this command. Ask an operator to add your Slack user ID to ' +
  '`channel_filter.slack.recipientAllowlist` (and to `slack.apps.<i>.allowedSlashUsers` if that ' +
  'key is set).';

/** Notice shown on the App Home tab to a viewer who is not on the allowlist. */
export const HOME_RESTRICTED_TEXT =
  'Your Slack account is not allowlisted for this bot, so its memory, sessions, and channels are ' +
  'hidden. Ask an operator to add your Slack user ID to `channel_filter.slack.recipientAllowlist`.';
