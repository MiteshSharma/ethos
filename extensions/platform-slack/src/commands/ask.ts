import { plaintextFallback, section } from '../blocks/shared';
import { canSpeakInChannel, isSlackDm, resolveChannelMode } from '../routing/triage';
import type { SlashCommandPayload, SlashContext, SlashResponse } from './index';

export async function handleAsk(
  payload: SlashCommandPayload,
  rest: string,
  ctx: SlashContext,
): Promise<SlashResponse> {
  // The room's promise is checked before the prompt is, because it is not
  // conditional on what the operator typed.
  //
  // `/ethos ask` is an explicit operator command, and "the operator asked for
  // it" is a real argument — but it is an argument about the OPERATOR, and the
  // answer does not land on the operator. It flows back through the gateway's
  // ordinary outbound path as a `chat.postMessage`, in front of everyone else
  // in the channel, and the in-channel acknowledgement below is a second public
  // post. An observed room was promised silence on behalf of the people in it;
  // one member's slash command is not their consent. So the command is refused
  // here rather than overridden, and the refusal is `ephemeral` — visible to
  // the invoker, invisible to the room, which is the one shape that both tells
  // the operator what happened and keeps the promise.
  //
  // There is no ephemeral variant to fall back to: the agent's answer is
  // produced asynchronously by the gateway and has no `response_url` to return
  // through. DM the bot, or change the mode.
  //
  // None of that reasoning applies in a DM, and the gate used to apply it there
  // anyway: `canSpeakInChannel` hard-coded `isDm: false`, so with
  // `defaultChannelMode: observe` a DM — which has no override, and therefore
  // resolves to the app default — answered ordinary messages but refused
  // `/ethos ask`, with a refusal telling the user to ask in a DM. There is no
  // room of third parties in a one-to-one conversation for a mode to protect,
  // which is why `evaluateChannelMode` ranks `isDm` above the mode.
  const channelMode = resolveChannelMode(payload.channel_id, {
    botKey: '',
    defaultChannelMode: ctx.defaultChannelMode,
    channelOverrides: ctx.channelOverrides,
  });
  if (!canSpeakInChannel(channelMode, isSlackDm(payload.channel_id, payload.channel_name))) {
    // Naming the mode verbatim makes this one of the ungated surfaces an
    // unreadable mode stays diagnosable through.
    const blocks = [
      section(
        `This channel is in \`${channelMode}\` mode, so I don't post here. ` +
          'Ask me in a DM, or change the mode with `/ethos channel-mode`.',
      ),
    ];
    return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
  }

  const prompt = rest.trim();
  if (!prompt) {
    const blocks = [section('Usage: `/ethos ask <prompt>`')];
    return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
  }

  if (!ctx.submitAgentTurn) {
    const blocks = [section('Agent submission is not configured.')];
    return { blocks, text: plaintextFallback(blocks), responseType: 'ephemeral' };
  }

  // Fire and forget — the agent's response flows back through the gateway's
  // normal outbound path (chat.postMessage), not through the slash command's
  // synchronous reply. We post a tiny in-channel acknowledgement so the
  // user knows the command landed; the answer arrives via the agent loop.
  await ctx.submitAgentTurn({
    channel: payload.channel_id,
    user: payload.user_id,
    text: prompt,
  });

  const blocks = [section(`<@${payload.user_id}> asked: ${quoteSnippet(prompt)}`)];
  return { blocks, text: plaintextFallback(blocks), responseType: 'in_channel' };
}

function quoteSnippet(text: string): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= 200) return `_${single}_`;
  return `_${single.slice(0, 197)}…_`;
}
