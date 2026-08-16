export const sessionKeys = {
  all: () => ['sessions'] as const,
  list: (params?: { q?: string; personalityId?: string }) =>
    [...sessionKeys.all(), 'list', ...(params ? [params] : [])] as const,
  detail: (id: string) => [...sessionKeys.all(), 'get', id] as const,
};
