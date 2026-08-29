import { useMutation, useQueryClient } from '@tanstack/react-query';
import { App as AntApp } from 'antd';
import { rpc } from '../../../rpc';
import { documentKeys } from './keys';

/**
 * Hard delete of one file. There is no trash tier — the operator has no shell
 * on the box to undo it — so the caller must confirm before firing.
 */
export function useDocumentDelete(personalityId: string) {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();

  return useMutation({
    mutationFn: (path: string) => rpc.documents.delete({ personalityId, path }),
    onSuccess: (_result, path) => {
      qc.invalidateQueries({ queryKey: documentKeys.lists(personalityId) });
      notification.success({ message: `Deleted ${path}`, placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Delete failed', description: (err as Error).message }),
  });
}
