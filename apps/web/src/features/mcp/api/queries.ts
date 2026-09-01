import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { mcpKeys } from './keys';

export function useMcpList(enabled?: boolean) {
  return useQuery({
    queryKey: mcpKeys.list(),
    queryFn: () => rpc.mcp.list(),
    enabled,
  });
}

/**
 * The curated preset catalog. Static server-side data — the presets are
 * compiled into `@ethosagent/tools-mcp` and only change when the binary does,
 * so it never needs refetching within a session.
 */
export function useMcpCatalog(enabled?: boolean) {
  return useQuery({
    queryKey: mcpKeys.catalog(),
    queryFn: () => rpc.mcp.catalog(),
    staleTime: Number.POSITIVE_INFINITY,
    enabled,
  });
}

export function useMcpPersonalityServers(personalityId: string) {
  return useQuery({
    queryKey: mcpKeys.personalityServers(personalityId),
    queryFn: () => rpc.mcp.personalityServers({ personalityId }),
  });
}
