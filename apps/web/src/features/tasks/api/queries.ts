import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { tasksKeys } from './keys';

// Background jobs are scoped by root session key (the JobStore has no global
// list). The page selects a session; we pass its key. When no session is
// selected the query is disabled and the list stays empty.
export function useTasksList(rootSessionKey: string | null) {
  return useQuery({
    queryKey: tasksKeys.list(rootSessionKey),
    queryFn: () => rpc.tasks.list(rootSessionKey ? { rootSessionKey } : {}),
    enabled: !!rootSessionKey,
    refetchInterval: 3000,
  });
}

/**
 * `live: false` turns the poll off. The run card asks for the row's STATIC
 * half — label, budget, detail-grid rows — and takes every changing field from
 * the `run.update` digest instead, so the card stays live off the digest alone
 * (pi-delegation D11). The Tasks page keeps the poll: it has no digest.
 */
export function useTaskDetail(id: string | null, opts?: { live?: boolean }) {
  const live = opts?.live ?? true;
  return useQuery({
    queryKey: tasksKeys.detail(id ?? ''),
    queryFn: () => rpc.tasks.get({ id: id ?? '' }),
    enabled: !!id,
    ...(live ? { refetchInterval: 3000 } : {}),
  });
}
