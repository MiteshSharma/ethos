import type { ChannelMode } from '../config';
import { context, header, type SlackBlock, section } from './shared';

export function channelModeShowBlocks(input: {
  channel: string;
  mode: ChannelMode;
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
