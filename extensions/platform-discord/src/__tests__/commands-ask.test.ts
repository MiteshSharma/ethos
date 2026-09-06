// `/ethos ask` on Discord — the one Discord command that can put content into
// a room it was not invited to speak in.
//
// The answer to an `ask` does not come back through the interaction reply. It
// comes back through `ctx.submitAgentTurn`, which hands the turn to the gateway,
// which posts into `payload.channelId` in front of everyone in it. Slack's copy
// of this command had no mode gate and was fixed
// (`extensions/platform-slack/src/__tests__/observe-handler-silence.test.ts`);
// Discord's had none either.
//
// Every case asserts on SUBMISSIONS, not on the returned embed: a handler that
// renders a refusal and submits anyway is the bug, and only the submission log
// can tell the difference.

import { ChannelOverrideStore } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { handleAsk } from '../commands/ask';
import type { CommandContext, CommandPayload } from '../commands/index';
import { ChannelModeSchema } from '../config';
import { createInMemoryStorage } from './fakes';

const BOT_DIR = 'discord/bot-a';
const GUILD_CHANNEL = 'ch1';

/**
 * Silent modes. `obserev` is the typo an operator types reaching for `observe`;
 * `regex_match` is a real mode on TELEGRAM that Discord's enum does not
 * contain. Both are unreadable here and both must fail closed —
 * `evaluateChannelMode` refuses any mode outside the `CHANNEL_MODES` Discord
 * passes it (`../routing/triage`).
 */
const SILENT = ['observe', 'obserev', 'regex_match'] as const;
const ANSWERING = ['mention_only', 'all'] as const;

async function overridesWith(mode: string): Promise<CommandContext['channelOverrides']> {
  const storage = createInMemoryStorage();
  await storage.write(
    `${BOT_DIR}/channel-overrides.jsonl`,
    `${JSON.stringify({ channel: GUILD_CHANNEL, mode, updatedAt: 1 })}\n`,
  );
  const store = new ChannelOverrideStore(storage, BOT_DIR, ChannelModeSchema);
  await store.load();
  return store;
}

interface AskOutcome {
  /** Agent turns submitted — each becomes a gateway post into the channel. */
  submitted: string[];
  description: string;
}

async function runAsk(mode: string, payloadOverrides: Partial<CommandPayload> = {}) {
  const submitted: string[] = [];
  const ctx: CommandContext = {
    binding: { type: 'personality', name: 'sitewatcher' },
    defaultChannelMode: 'mention_only',
    channelOverrides: await overridesWith(mode),
    submitAgentTurn: async (input) => {
      submitted.push(input.text);
    },
  };
  const payload: CommandPayload = {
    commandName: 'ask',
    options: { prompt: 'what is the pour date' },
    channelId: GUILD_CHANNEL,
    userId: 'u1',
    guildId: 'g1',
    ...payloadOverrides,
  };
  const response = await handleAsk(payload, ctx);
  const outcome: AskOutcome = {
    submitted,
    description: response.embeds[0]?.description ?? '',
  };
  return { ...outcome, ephemeral: response.ephemeral };
}

describe('Discord /ethos ask — a room promised silence', () => {
  for (const mode of SILENT) {
    it(`submits no agent turn in \`${mode}\` mode`, async () => {
      expect((await runAsk(mode)).submitted).toEqual([]);
    });

    it(`refuses ephemerally in \`${mode}\` mode, naming the mode verbatim`, async () => {
      // Ephemeral is what keeps the refusal itself out of the room, and naming
      // the stored string is how an operator diagnoses an unreadable mode on an
      // adapter with no `/ethos channel-mode show`.
      const outcome = await runAsk(mode);

      expect(outcome.ephemeral).toBe(true);
      expect(outcome.description).toContain(mode);
    });
  }

  // The control, and the reason the cases above are not vacuous: without it
  // they would pass just as well against a handler that submits nothing ever.
  for (const mode of ANSWERING) {
    it(`still submits the turn in \`${mode}\` mode`, async () => {
      expect((await runAsk(mode)).submitted).toEqual(['what is the pour date']);
    });
  }

  it('answers in a DM whatever the app default says — a DM is not a room', async () => {
    // Discord marks a DM by the absence of a guild; `events/interactions.ts`
    // maps `interaction.guildId === null` to `undefined`. `evaluateChannelMode`
    // ranks `isDm` above the mode, and this is the hard-coded `isDm: false`
    // that made Slack's `/ethos ask` refuse in a DM.
    const outcome = await runAsk('observe', { guildId: undefined, channelId: 'dm1' });

    expect(outcome.submitted).toEqual(['what is the pour date']);
  });

  it('checks the mode before the prompt', async () => {
    // The room's promise is not conditional on what the operator typed, so an
    // empty prompt in an observed channel gets the mode refusal, not a usage
    // hint that implies retrying would work.
    const outcome = await runAsk('observe', { options: {} });

    expect(outcome.description).toContain('observe');
    expect(outcome.submitted).toEqual([]);
  });
});
