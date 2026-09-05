import type { Binding } from '../config';
import { context, divider, header, type SlackBlock, section } from './shared';

export function helpBlocks(input: {
  binding: Binding;
  channel: string;
  /** `string`, not `ChannelMode`: an unreadable stored override is rendered
   *  verbatim so the operator can see the value that silenced the channel. */
  channelMode: string;
}): SlackBlock[] {
  const { binding, channel, channelMode } = input;
  return [
    header('Ethos · slash commands'),
    section(
      `*Bound to* ${binding.type} \`${binding.name}\`\n` +
        `*Channel mode* in <#${channel}>: \`${channelMode}\``,
    ),
    divider(),
    section(
      [
        '`/ethos ask <prompt>` — submit a prompt to the bound agent',
        '`/ethos personality` — show the bot binding',
        '`/ethos memory show` — last 5 memory entries',
        '`/ethos memory add <text>` — append a memory entry',
        '`/ethos kanban list` — open kanban tickets (team bots only)',
        '`/ethos channel-mode show|all|thread_follow|mention_only|observe` — per-channel reply mode',
        '`/ethos help` — this message',
      ].join('\n'),
    ),
    section(
      '*Context cost.* Run `ethos sessions show <id>` to see tokens, cost, and cache hit rate for a session.',
    ),
    context([
      'Modes: `mention_only` (default) responds to DMs and @mentions; ' +
        '`thread_follow` also responds in threads the bot has posted in; ' +
        '`all` responds to every message; ' +
        '`observe` records every message and never replies, not even to an @mention.',
    ]),
  ];
}
