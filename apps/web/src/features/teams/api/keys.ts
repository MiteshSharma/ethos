export const teamKeys = {
  all: () => ['teams'] as const,
  list: () => [...teamKeys.all(), 'list'] as const,
  get: (teamId: string) => [...teamKeys.all(), 'get', teamId] as const,
};
