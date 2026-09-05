// Writes for the Backup pane: create an archive, restore `identity` from one.
//
// Deliberately NOT the `keys-mutations.ts` notification shape. Feedback &
// activity contract §6: an action a page takes is a persistent ROW, never a
// toast, and §7: an outcome resolves that row in place rather than removing it.
// A `notification.success` here would be the toast the contract forbids, and it
// would also drop the half of the report that matters (`inUseCheck`, displaced
// files, warnings). So these hooks only invalidate `backup.status`; the pane
// owns the rows and renders the result.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { backupKeys } from './backup';

export function useBackupCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof rpc.backup.create>[0]) => rpc.backup.create(input),
    // `onSettled`, not `onSuccess`: a failed create still changes what the
    // status reports (`lastBackup.ok: false`, and the header must say so).
    onSettled: () => qc.invalidateQueries({ queryKey: backupKeys.all() }),
  });
}

export function useBackupRestoreIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Parameters<typeof rpc.backup.restoreIdentity>[0]) =>
      rpc.backup.restoreIdentity(input),
    // A restore rewrites config.yaml and mcp.json; the next status carries the
    // boot time the restart notice is pinned against.
    onSettled: () => qc.invalidateQueries({ queryKey: backupKeys.all() }),
  });
}
