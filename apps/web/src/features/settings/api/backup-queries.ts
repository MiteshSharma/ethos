// Reads for the Backup pane. One query — `backup.status()` answers the whole
// header, the store rows, the archive list and the schedule in a single round
// trip (the contract's own note on why it is one procedure and not four).

import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { backupKeys } from './backup';

/** A create in flight resolves on its own, so the status polls itself out of it. */
const RUNNING_POLL_MS = 2000;

/**
 * `refetchMs` is the caller's, because the pane knows one thing this hook
 * cannot: a restart notice is unresolved, and only a status carrying a
 * DIFFERENT `serverStartedAt` can clear it. Idle, with nothing running, the
 * pane does not poll at all.
 */
export function useBackupStatus(refetchMs: number | false = false) {
  return useQuery({
    queryKey: backupKeys.status(),
    queryFn: () => rpc.backup.status(),
    // `running` is true for a create started anywhere in this process, including
    // another tab, so the poll is not conditioned on this pane having started it.
    refetchInterval: (query) => (query.state.data?.running ? RUNNING_POLL_MS : refetchMs),
  });
}
