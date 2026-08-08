export const personalityKeys = {
  all: () => ['personalities'] as const,
  list: () => [...personalityKeys.all(), 'list'] as const,
  detail: (id: string) => [...personalityKeys.all(), 'get', id] as const,
  characterSheet: (id: string) => [...personalityKeys.all(), 'characterSheet', id] as const,
  skills: (personalityId: string) => [...personalityKeys.all(), 'skills', personalityId] as const,
  renderers: (id: string) => [...personalityKeys.all(), 'renderers', id] as const,
  palette: () => ['palette', 'personalities'] as const,
};
