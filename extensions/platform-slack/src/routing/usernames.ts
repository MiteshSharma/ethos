// Slack user-id → display-name resolution. `users.info` is the only way to
// turn a raw `U…` id into something a human (or a model) can read, so every
// lookup goes through a bounded cache: 24 h TTL, at most 1024 entries,
// least-recently-used evicted first.
//
// The call needs the `users:read` bot scope. A workspace that hasn't granted
// it gets a `missing_scope` platform error, which we swallow the same way the
// receipt reaction swallows `reactions:write` — no throw, no log, callers fall
// back to the raw id. The failed lookup is cached like any other outcome so a
// scope-less workspace issues one `users.info` per user, not one per message.

/** Slack's `users.info` payload, narrowed to the fields we read. */
export interface SlackUserInfo {
  name?: string;
  real_name?: string;
  profile?: { display_name?: string; real_name?: string };
}

/** Structural subset of the Bolt web client this module needs. */
export interface SlackUsersClient {
  users: { info(args: { user: string }): Promise<{ user?: SlackUserInfo }> };
}

export interface UsernameResolver {
  /** Display name for one user id; `undefined` when it can't be resolved. */
  resolve(userId: string): Promise<string | undefined>;
  /**
   * Display names for a set of ids. Duplicates collapse and cached ids cost
   * nothing, so a thread of N messages from M distinct authors costs at most
   * M `users.info` calls. Unresolvable ids are absent from the map.
   */
  resolveMany(userIds: readonly string[]): Promise<Map<string, string>>;
}

/** 24 h — display names change rarely and a stale one is cosmetic. */
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** Hard cap on cached users, in the same spirit as `chunkMap`/`pendingReactions`. */
const CACHE_MAX_ENTRIES = 1024;

interface CacheEntry {
  /** `undefined` records a lookup that failed — a negative cache entry. */
  name: string | undefined;
  expiresAt: number;
}

/** Slack's own preference order: what the workspace shows, then the real
 *  name, then the handle. */
function pickDisplayName(user: SlackUserInfo | undefined): string | undefined {
  const candidates = [
    user?.profile?.display_name,
    user?.profile?.real_name,
    user?.real_name,
    user?.name,
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export function createUsernameResolver(client: SlackUsersClient): UsernameResolver {
  const cache = new Map<string, CacheEntry>();

  /** Read through the TTL, refreshing recency on a hit. */
  function readCache(userId: string): CacheEntry | undefined {
    const entry = cache.get(userId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      cache.delete(userId);
      return undefined;
    }
    // Re-inserting moves the key to the end of the Map's iteration order, so
    // the first key is always the least-recently-used one.
    cache.delete(userId);
    cache.set(userId, entry);
    return entry;
  }

  function writeCache(userId: string, name: string | undefined): void {
    cache.delete(userId);
    while (cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    cache.set(userId, { name, expiresAt: Date.now() + CACHE_TTL_MS });
  }

  async function resolve(userId: string): Promise<string | undefined> {
    const cached = readCache(userId);
    if (cached) return cached.name;

    let name: string | undefined;
    try {
      const res = await client.users.info({ user: userId });
      name = pickDisplayName(res.user);
    } catch {
      // `missing_scope`, a deactivated user, a transient network failure —
      // all degrade to the raw id. Same policy as the receipt reaction.
      name = undefined;
    }
    writeCache(userId, name);
    return name;
  }

  return {
    resolve,
    async resolveMany(userIds) {
      const unique = [...new Set(userIds)];
      const names = await Promise.all(unique.map((id) => resolve(id)));
      const resolved = new Map<string, string>();
      unique.forEach((id, i) => {
        const name = names[i];
        if (name) resolved.set(id, name);
      });
      return resolved;
    },
  };
}
