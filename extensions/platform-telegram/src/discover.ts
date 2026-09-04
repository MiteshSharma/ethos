// Which chats have talked to this bot — a ONE-SHOT `getUpdates` read.
//
// A bot binding names a personality, never a chat, so after a recipe creates
// and binds a bot there is still nothing that says WHERE its scheduled output
// goes. The user is told to message their new bot; this is how the server finds
// out that they did, without ever asking them to type a chat id.
//
// Three rules this module exists to keep:
//
//  1. NEVER LONG-POLL. `timeout=0` and a short abort — a recipe page is not a
//     gateway, and holding the connection would be indistinguishable from one.
//  2. NEVER SEND AN `offset`. An offset ACKNOWLEDGES every update below it and
//     Telegram then drops them permanently. The gateway has not started yet;
//     consuming the user's first message here would delete the very thing it is
//     about to read. Reading without an offset is idempotent — the same updates
//     come back on the next call, which is also why the install can re-read
//     them to authorize the chat the client picked.
//  3. 409 IS NOT AN ERROR. Telegram answers a second concurrent `getUpdates` on
//     one token with 409 Conflict (see `apps/ethos/src/config-reload.ts`), so a
//     409 means the GATEWAY owns this token and is already polling it. Its
//     pairing store and its lane keys then know the chat, and the caller should
//     fall back to the normal delivery-target resolution.
//
// The token is a credential. It is used to build the URL and is never returned,
// never logged, and never placed in an error string.

/**
 * - `ok` — Telegram answered; `chats` is what has messaged this bot.
 * - `gateway_owns_token` — 409. The running gateway is polling this token.
 * - `rejected` — the token was definitively refused (401/403, or `ok: false`).
 * - `unreachable` — timeout / DNS / 5xx / 429. Says nothing about the token.
 */
export type TelegramDiscoveryStatus = 'ok' | 'gateway_owns_token' | 'rejected' | 'unreachable';

export interface TelegramDiscoveredChat {
  /** The Telegram chat id, as a string — it is an address, never a number to do arithmetic on. */
  chatId: string;
  /** Human label: the group's title, or the sender's name, or their @handle. */
  label: string;
  /** `private` | `group` | `supergroup` | `channel`. */
  kind: string;
}

export interface TelegramDiscovery {
  status: TelegramDiscoveryStatus;
  chats: TelegramDiscoveredChat[];
  /** One line for the user. Never contains the token. */
  error?: string;
}

interface RawChat {
  id?: number | string;
  type?: string;
  title?: string;
  username?: string;
  first_name?: string;
  last_name?: string;
}

/** Every update shape that carries a chat we could deliver to. */
interface RawUpdate {
  message?: { chat?: RawChat };
  edited_message?: { chat?: RawChat };
  channel_post?: { chat?: RawChat };
  my_chat_member?: { chat?: RawChat };
}

function labelFor(chat: RawChat): string {
  const title = chat.title?.trim();
  if (title) return title;
  const name = [chat.first_name, chat.last_name].filter(Boolean).join(' ').trim();
  if (name) return name;
  const username = chat.username?.trim();
  if (username) return `@${username}`;
  return `Chat ${String(chat.id ?? '')}`;
}

function chatsFrom(updates: RawUpdate[]): TelegramDiscoveredChat[] {
  const byId = new Map<string, TelegramDiscoveredChat>();
  for (const update of updates) {
    const chat =
      update.message?.chat ??
      update.edited_message?.chat ??
      update.channel_post?.chat ??
      update.my_chat_member?.chat;
    if (!chat || chat.id === undefined || chat.id === null) continue;
    const chatId = String(chat.id);
    if (byId.has(chatId)) continue;
    byId.set(chatId, { chatId, label: labelFor(chat), kind: chat.type ?? 'private' });
  }
  return [...byId.values()];
}

/**
 * One shot, no offset, no long poll. Safe to call twice: the second call sees
 * the same updates, which is what lets an install re-verify a client's pick
 * against Telegram rather than trusting it.
 */
export async function discoverTelegramChats(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TelegramDiscovery> {
  if (!token) return { status: 'rejected', chats: [], error: 'No bot token was supplied.' };
  try {
    const res = await fetchImpl(
      `https://api.telegram.org/bot${token}/getUpdates?limit=100&timeout=0`,
      { signal: AbortSignal.timeout(5000) },
    );
    if (res.status === 409) {
      return {
        status: 'gateway_owns_token',
        chats: [],
        error: 'The running gateway is already receiving this bot’s messages.',
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { status: 'rejected', chats: [], error: 'Invalid token' };
    }
    if (res.status === 429) {
      return { status: 'unreachable', chats: [], error: 'Telegram returned 429 (rate limited)' };
    }
    if (res.status >= 500) {
      return { status: 'unreachable', chats: [], error: `Telegram returned ${res.status}` };
    }
    const data = (await res.json()) as { ok?: boolean; result?: RawUpdate[] };
    if (!data.ok) return { status: 'rejected', chats: [], error: 'Invalid token' };
    return { status: 'ok', chats: chatsFrom(data.result ?? []) };
  } catch {
    return { status: 'unreachable', chats: [], error: 'Could not reach Telegram (timeout)' };
  }
}
