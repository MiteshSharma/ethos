// Query key + the read for Settings › Execution
// (plan/phases/remote-execution-routing.md §6, T7). Same shape as
// `backup.ts` / `backup-queries.ts`.

import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';

export const executionKeys = {
  all: () => ['execution'] as const,
  probeSsh: () => [...executionKeys.all(), 'probe-ssh'] as const,
};

/**
 * The ssh probe. A QUERY, not a mutation, for one reason: the header IS the
 * probe result, so the pane has an answer to show the moment it opens rather
 * than an idle sixth state that says nothing. `Test connection` is `refetch()`.
 *
 * Nothing is cached on either side of the wire. `staleTime: 0` +
 * `refetchOnMount: 'always'` here, and the service calls the backend's
 * uncached `probe()` there — a reachability answer from a minute ago is
 * exactly what the operator pressed the button to get past.
 */
export function useSshProbe() {
  return useQuery({
    queryKey: executionKeys.probeSsh(),
    queryFn: () => rpc.execution.probeSsh(),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
    // An ssh connection is not a background activity. It runs when the pane
    // opens and when the operator asks, never on a window focus.
    refetchOnWindowFocus: false,
    retry: false,
  });
}
