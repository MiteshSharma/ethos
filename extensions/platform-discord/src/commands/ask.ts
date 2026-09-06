import { embed } from '../blocks/shared';
import { canSpeakInChannel, resolveChannelMode } from '../routing/triage';
import type { CommandContext, CommandPayload, CommandResponse } from './index';

export async function handleAsk(
  payload: CommandPayload,
  ctx: CommandContext,
): Promise<CommandResponse> {
  // The room's promise is checked before the prompt is, for the reason
  // `extensions/platform-slack/src/commands/ask.ts` spells out: the answer does
  // not land on the person who typed the command. `submitAgentTurn` hands the
  // turn to the gateway, which posts the reply into `payload.channelId` in
  // front of everyone in it. One member's slash command is not the room's
  // consent, so an observed channel refuses — ephemerally, which tells the
  // invoker what happened without the room hearing it.
  //
  // NOTE ON REACHABILITY: this branch cannot fire in production today, because
  // `ctx.submitAgentTurn` is only ever set through `DiscordAdapter.setCommandContext`
  // (`../index.ts`) and nothing calls it — `handleCommand` falls back to a
  // context with no submitter, so the refusal below is currently shadowed by
  // the "not available" reply further down. The gate is here anyway: wiring
  // `setCommandContext` with a real `submitAgentTurn` from the gateway is a
  // one-line change, and it is the exact change that would have opened the hole
  // Slack's `/ethos ask` had. Enforced by `canSpeakInChannel` in
  // `../routing/triage.ts`; pinned by
  // `extensions/platform-discord/src/__tests__/commands-ask.test.ts`.
  const channelMode = resolveChannelMode(payload.channelId, {
    botKey: '',
    defaultChannelMode: ctx.defaultChannelMode,
    channelOverrides: ctx.channelOverrides,
  });
  // Discord marks a DM by the absence of a guild: `interaction.guildId` is null
  // outside a server, and `events/interactions.ts` maps that to `undefined`.
  // A DM is not a room (`evaluateChannelMode` ranks `isDm` first), so it is
  // answered whatever the app default says.
  if (!canSpeakInChannel(channelMode, !payload.guildId)) {
    return {
      // Naming the mode verbatim keeps an unreadable stored mode diagnosable
      // through a surface the room cannot see.
      embeds: [
        embed({
          description:
            `This channel is in \`${channelMode}\` mode, so I don't post here. ` +
            'DM me instead, or change the mode.',
        }),
      ],
      ephemeral: true,
    };
  }

  const prompt = payload.options.prompt;
  if (!prompt) {
    return { embeds: [embed({ description: 'Please provide a prompt.' })], ephemeral: true };
  }
  if (ctx.submitAgentTurn) {
    await ctx.submitAgentTurn({ channel: payload.channelId, user: payload.userId, text: prompt });
    return { embeds: [embed({ description: `Submitted: "${prompt}"` })], ephemeral: true };
  }
  return {
    embeds: [embed({ description: 'Agent turn submission not available.' })],
    ephemeral: true,
  };
}
