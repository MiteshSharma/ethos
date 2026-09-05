import type { ChannelMode } from '../config';
import { context, header, type SlackBlock, section } from './shared';

export function channelModeShowBlocks(input: {
  channel: string;
  /** `string`, not `ChannelMode`: `/ethos channel-mode show` is where an
   *  operator looks when a channel has gone quiet, so an unreadable stored
   *  override is shown verbatim instead of as the default it is not. */
  mode: string;
  isOverride: boolean;
}): SlackBlock[] {
  const { channel, mode, isOverride } = input;
  const source = isOverride ? 'per-channel override' : 'app default';
  return [
    header(`Channel mode: ${mode}`),
    section(`<#${channel}> currently uses *${mode}* (${source}).`),
    context([
      `Set with: \`/ethos channel-mode all\`, ` +
        `\`/ethos channel-mode thread_follow\`, ` +
        `\`/ethos channel-mode mention_only\`, or ` +
        `\`/ethos channel-mode observe\` (records every message, never replies).`,
    ]),
  ];
}

export function channelModeSetBlocks(input: { channel: string; mode: ChannelMode }): SlackBlock[] {
  return [section(`Channel mode for <#${input.channel}> set to *${input.mode}*.`)];
}

export function channelModeUsageBlocks(): SlackBlock[] {
  return [
    section(
      'Usage: `/ethos channel-mode show` ' +
        '· `/ethos channel-mode all` ' +
        '· `/ethos channel-mode thread_follow` ' +
        '· `/ethos channel-mode mention_only` ' +
        '· `/ethos channel-mode observe`',
    ),
  ];
}
