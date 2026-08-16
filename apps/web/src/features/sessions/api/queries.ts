import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { sessionKeys } from './keys';

const PAGE_SIZE = 50;

export function useSessionList(debouncedSearch: string, personalityId?: string) {
  return useInfiniteQuery({
    queryKey: sessionKeys.list({ q: debouncedSearch, personalityId }),
    queryFn: ({ pageParam }: { pageParam: string | null }) =>
      rpc.sessions.list({
        limit: PAGE_SIZE,
        ...(debouncedSearch ? { q: debouncedSearch } : {}),
        ...(personalityId ? { personalityId } : {}),
        ...(pageParam ? { cursor: pageParam } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
  });
}

export function useSessionGet(sessionId: string | undefined | null) {
  return useQuery({
    queryKey: sessionKeys.detail(sessionId ?? ''),
    queryFn: () => rpc.sessions.get({ id: sessionId ?? '' }),
    enabled: !!sessionId,
    staleTime: 30_000,
  });
}

export function useRecentSessions(limit: number) {
  return useQuery({
    queryKey: ['sessions', 'list', { limit }],
    queryFn: () => rpc.sessions.list({ limit }),
  });
}
