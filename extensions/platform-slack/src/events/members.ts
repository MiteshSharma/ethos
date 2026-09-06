// Posts a one-line greeting when the bot itself is added to a channel.
// We need the bot's own user id to distinguish "the bot joined" from
// "someone else joined" — Slack provides it via `auth.test`, which the
// adapter calls during `start()` and stashes for this handler.

import type { App } from '@slack/bolt';
import type { Binding } from '../config';
import { canSpeakInChannel } from '../routing/triage';

export interface MemberJoinedDeps {
  /** The bot's own Slack user id, e.g. `U0123ABCD`. Used to filter the
   *  `member_joined_channel` event so we only greet for the bot itself. */
  selfUserId: string | null;
  binding: Binding;
  /** Resolves the active channel mode for a given channel id. `string`, not
   *  `ChannelMode`: a stored override this build's enum cannot read resolves
   *  to the raw stored string, and the greeting names it rather than naming a
   *  default that is not in force. */
  resolveChannelMode: (channel: string) => string;
}

export function registerMemberEvents(app: App, deps: MemberJoinedDeps): void {
  app.event('member_joined_channel', async ({ event, client }) => {
    if (!deps.selfUserId) return;
    if (event.user !== deps.selfUserId) return;
    const mode = deps.resolveChannelMode(event.channel);
    // The greeting is a public `chat.postMessage`, so it is bound by the same
    // promise every other post is: an observed room hears nothing, not even
    // the bot introducing itself. The mode used to be display text here and
    // never a gate, which made `defaultChannelMode: observe` announce the bot
    // in every room it was invited to.
    //
    // An unreadable mode is silenced too, by `canSpeakInChannel`'s fail-closed
    // reasoning — and it stays diagnosable, because the operator reads the raw
    // string back from `/ethos channel-mode show`, `/ethos help`, the refusal
    // `/ethos ask` returns, and the App Home tab, none of which the room sees.
    // `isDm: false` unconditionally, and not by omission: `member_joined_channel`
    // only ever fires for a channel or private group. Nobody is invited to a
    // DM — the conversation exists the moment either party opens it — so there
    // is no DM case for this handler to get wrong.
    if (!canSpeakInChannel(mode, false)) return;
    const subject = deps.binding.type === 'team' ? 'team coordinator' : 'personality';
    const text =
      `:wave: I'm bound to the *${subject}* \`${deps.binding.name}\`. ` +
      `This channel is in \`${mode}\` mode. ` +
      `Run \`/ethos channel-mode\` to change it.`;
    try {
      await client.chat.postMessage({ channel: event.channel, text, mrkdwn: true });
    } catch {
      // Slack may reject the post if the bot lacks chat:write in this
      // workspace context; surface no error to the operator.
    }
  });
}
