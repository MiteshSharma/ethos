export const platformKeys = {
  all: () => ['platforms'] as const,
  list: () => [...platformKeys.all(), 'list'] as const,
  bots: (platform: string) => [...platformKeys.all(), 'bots', platform] as const,
  channelFilter: (platform: string) => [...platformKeys.all(), 'channelFilter', platform] as const,
};

/** Rooms a bot watches without answering (observe mode). The `since` window is
 *  part of the key: "today" moves at local midnight, and a stale cache entry
 *  would keep counting yesterday's messages as today's. */
export const observedChatKeys = {
  all: () => ['channels', 'observed'] as const,
  since: (since: number) => [...observedChatKeys.all(), since] as const,
};

/** Telephony call history (voice V4). The filter is part of the LIST key, so
 *  flipping a chip is a different cache entry rather than a refetch that
 *  overwrites the unfiltered history — going back to "All" is then instant and
 *  shows what it showed before. */
export const callKeys = {
  all: () => ['voice', 'calls'] as const,
  list: (filter: { direction: string; status: string }) =>
    [...callKeys.all(), 'list', filter.direction, filter.status] as const,
  active: () => [...callKeys.all(), 'active'] as const,
  detail: (id: string) => [...callKeys.all(), 'detail', id] as const,
};
