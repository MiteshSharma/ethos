import { helpEmbed } from '../blocks/help';
import { DEFAULT_CHANNEL_MODE } from '../config';
import type { CommandContext, CommandPayload, CommandResponse } from './index';

export function handleHelp(payload: CommandPayload, ctx: CommandContext): CommandResponse {
  const channelMode =
    ctx.channelOverrides?.get(payload.channelId)?.mode ??
    ctx.defaultChannelMode ??
    DEFAULT_CHANNEL_MODE;
  return {
    embeds: [helpEmbed({ binding: ctx.binding, channelId: payload.channelId, channelMode })],
    ephemeral: true,
  };
}
