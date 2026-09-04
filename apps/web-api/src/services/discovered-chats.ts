import { dirname, join } from 'node:path';
import type { Storage } from '@ethosagent/types';

// Chats the SERVER ITSELF saw message a bot (plan/phases/recipes-gallery.md §1,
// D14).
//
// WHY THIS EXISTS. A recipe's inline channel setup creates a bot and binds it
// to the personality it just made. The user has messaged that bot — that is how
// the chat was discovered at all — but on a fresh machine nothing in
// `resolveDeliveryTargets` can see it: `channel_filter` is unset, the pairing DB
// has no row because the gateway has never run, and there is no session lane key
// for a bot that did not exist a second ago. The chat would be refused with
// `CRON_TARGET_NOT_ALLOWED` — correctly, by a guard doing its job against a
// world that has not been told what the server watched happen.
//
// So the fix is to TELL IT, not to relax it. A row lands here only after the
// server called Telegram's `getUpdates` with the operator's own token and saw
// that chat send a message to that bot. That is the same evidence class as the
// `observed` source (a chat this bot has been talked to in), which is why these
// ids are unioned into `observedChatIds` rather than given a source of their
// own: the reason shown to the user — "you have messaged this bot here" — is
// exactly true of them.
//
// Scoped per `(platform, botKey)`, so evidence about one bot can never widen
// another's targets.

export interface DiscoveredChatStore {
  /** chatIds recorded for this bot. Never throws — an unreadable file is "none". */
  list(platform: string, botKey: string): Promise<string[]>;
  record(platform: string, botKey: string, chatId: string): Promise<void>;
  /** Compensation for a failed install — remove what that install recorded. */
  forget(platform: string, botKey: string, chatId: string): Promise<void>;
}

/** `<dataDir>/recipes/discovered-chats.json`. */
function storePath(dataDir: string): string {
  return join(dataDir, 'recipes', 'discovered-chats.json');
}

function keyFor(platform: string, botKey: string): string {
  return `${platform}:${botKey}`;
}

type StoreShape = Record<string, string[]>;

function parse(raw: string | null): StoreShape {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    const out: StoreShape = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (Array.isArray(value)) out[key] = value.filter((v): v is string => typeof v === 'string');
    }
    return out;
  } catch {
    // A corrupt file means no recorded evidence, which fails CLOSED: the chat
    // is simply not offered. Never a throw — the delivery picker must render.
    return {};
  }
}

export function createDiscoveredChatStore(storage: Storage, dataDir: string): DiscoveredChatStore {
  const path = storePath(dataDir);

  // Read-modify-write under one in-process chain. Two installs racing this file
  // in one web-api process would otherwise lose a row; across processes this is
  // still last-writer-wins, which costs at most a re-discovery.
  let queue: Promise<void> = Promise.resolve();
  const mutate = (fn: (state: StoreShape) => void): Promise<void> => {
    const next = queue.then(async () => {
      const state = parse(await storage.read(path));
      fn(state);
      // `write` does not create parents (`Storage` says so explicitly), and
      // `<dataDir>/recipes/` does not exist until the first install writes here.
      await storage.mkdir(dirname(path));
      await storage.writeAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
    });
    // Keep the chain alive after a rejection so one failure does not wedge it.
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    async list(platform, botKey) {
      const state = parse(await storage.read(path));
      return state[keyFor(platform, botKey)] ?? [];
    },

    record(platform, botKey, chatId) {
      return mutate((state) => {
        const key = keyFor(platform, botKey);
        const existing = state[key] ?? [];
        if (!existing.includes(chatId)) state[key] = [...existing, chatId];
      });
    },

    forget(platform, botKey, chatId) {
      return mutate((state) => {
        const key = keyFor(platform, botKey);
        const remaining = (state[key] ?? []).filter((id) => id !== chatId);
        if (remaining.length > 0) state[key] = remaining;
        else delete state[key];
      });
    },
  };
}
