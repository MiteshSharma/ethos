// Writes for the Keys pane. Same shape as `useNamedSecretCreate()` /
// `useNamedSecretDelete()` in `mutations.ts`: the client only ever SENDS a
// value, never receives one, and both mutations invalidate the one list query.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { vaultKeyKeys } from './keys';

export function useKeySet() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (input: Parameters<typeof rpc.keys.set>[0]) => rpc.keys.set(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: vaultKeyKeys.all() });
      notification.success({ message: 'Key saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Failed to save key', description: (err as Error).message }),
  });
}

export function useKeyClear() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (input: Parameters<typeof rpc.keys.clear>[0]) => rpc.keys.clear(input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: vaultKeyKeys.all() });
      notification.success({ message: 'Key cleared', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Failed to clear key', description: (err as Error).message }),
  });
}
