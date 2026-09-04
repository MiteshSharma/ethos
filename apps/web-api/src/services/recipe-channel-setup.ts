import { deriveBotKey } from '@ethosagent/core';
import type { RecipeDiscoverChatsOutput } from '@ethosagent/web-contracts';
import type { DiscoveredChatStore } from './discovered-chats';
import type { PlatformsService } from './platforms.service';

// Inline channel setup — the seam the recipe installer uses to CREATE the bot
// its schedules deliver through (plan/phases/recipes-gallery.md D14).
//
// THE PROBLEM THIS SOLVES. `platforms.botsAddTelegram` takes a `bind` naming an
// existing personality, and a recipe's personality does not exist until the
// recipe installs. So "bind a bot to this agent in Communications, then
// re-check" asked the user to do something that could never be done, and the
// "Deliver to" row could never clear. The order has to be inverted: the recipe
// page collects the token, and the INSTALL binds the bot once the personality
// is there.
//
// Kept behind one narrow interface, injected into `RecipesService`, because the
// alternative is a service that reaches for `PlatformsService`, a `fetch`, and a
// JSON store, and a test that has to build all three.
//
// THE TOKEN. It arrives on exactly one call, is used to build a Telegram URL
// and to seed a config write through the SAME path Communications already uses
// (a `${secrets:...}` reference, never a literal in config.yaml), and is never
// returned, never logged, and never placed in an error message. Nothing here
// echoes it, and no error string interpolates it.

export interface ChannelSetupWorld {
  /** Platforms this deployment can set one up for. Today: `['telegram']`. */
  readonly platforms: readonly string[];
  /** Live credential probe. `label` is `@botname` on success. */
  validateToken(
    platform: string,
    token: string,
  ): Promise<{ ok: boolean; label: string | null; error: string | null; retryable: boolean }>;
  /** One-shot chat discovery. Never long-polls, never sends an `offset`. */
  discoverChats(platform: string, token: string): Promise<RecipeDiscoverChatsOutput>;
  /** Create the bot and bind it. `created: false` ⇒ this token was already configured. */
  addBot(input: {
    platform: string;
    token: string;
    personalityId: string;
    username?: string;
  }): Promise<{ botKey: string; created: boolean }>;
  removeBot(platform: string, botKey: string): Promise<void>;
  /** Record a chat the server watched message this bot, so it is a real target. */
  recordChat(platform: string, botKey: string, chatId: string): Promise<void>;
  forgetChat(platform: string, botKey: string, chatId: string): Promise<void>;
}

export interface LiveChannelSetupWorldOptions {
  platforms: Pick<
    PlatformsService,
    'validate' | 'addTelegramBot' | 'removeTelegramBot' | 'listTelegramBots'
  >;
  discovered: DiscoveredChatStore;
  /** Injected for tests; production uses the real `getUpdates`. */
  discover?: (token: string) => Promise<RecipeDiscoverChatsOutput>;
}

/** `@briefer_bot` → `briefer_bot`; anything else → undefined. */
function usernameFrom(label: string | null): string | undefined {
  const trimmed = label?.trim().replace(/^@/, '');
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

async function liveDiscover(token: string): Promise<RecipeDiscoverChatsOutput> {
  const { discoverTelegramChats } = await import('@ethosagent/platform-telegram/discover');
  const result = await discoverTelegramChats(token);
  return {
    // `ok` with nothing to show is `waiting`, not an empty success — the user
    // has a next action ("send your bot a message"), and an empty list with no
    // explanation reads as a failure.
    status: result.status === 'ok' && result.chats.length === 0 ? 'waiting' : result.status,
    botLabel: null,
    chats: result.chats,
    error: result.error ?? null,
  };
}

export function createLiveChannelSetupWorld(opts: LiveChannelSetupWorldOptions): ChannelSetupWorld {
  const discover = opts.discover ?? liveDiscover;

  return {
    platforms: ['telegram'],

    async validateToken(platform, token) {
      if (platform !== 'telegram') {
        return { ok: false, label: null, error: 'Unsupported platform', retryable: false };
      }
      const result = await opts.platforms.validate('telegram', { token });
      return {
        ok: result.status === 'ok',
        label: result.label,
        error: result.error,
        // `unreachable` says nothing about the token — pressing again may work.
        retryable: result.status === 'unreachable',
      };
    },

    discoverChats(platform, token) {
      if (platform !== 'telegram') {
        return Promise.resolve({
          status: 'rejected' as const,
          botLabel: null,
          chats: [],
          error: 'Unsupported platform',
        });
      }
      return discover(token);
    },

    async addBot({ platform, token, personalityId, username }) {
      if (platform !== 'telegram') throw new Error(`Unsupported platform '${platform}'`);
      // The botKey is `sha256(token)`, so an already-configured token yields the
      // same key. Re-installing must not append a second identical entry —
      // and must not register an undo that would delete a bot it did not make.
      const botKey = deriveBotKey(token);
      const { bots } = await opts.platforms.listTelegramBots();
      if (bots.some((bot) => bot.botKey === botKey)) return { botKey, created: false };
      const { bot } = await opts.platforms.addTelegramBot(
        token,
        { type: 'personality', name: personalityId },
        username,
      );
      return { botKey: bot.botKey, created: true };
    },

    async removeBot(platform, botKey) {
      if (platform !== 'telegram') return;
      await opts.platforms.removeTelegramBot(botKey);
    },

    recordChat(platform, botKey, chatId) {
      return opts.discovered.record(platform, botKey, chatId);
    },

    forgetChat(platform, botKey, chatId) {
      return opts.discovered.forget(platform, botKey, chatId);
    },
  };
}

export { usernameFrom };
