// Reads for the Keys pane. Same shape as `useNamedSecretsList()` in
// `queries.ts` — one query, masked previews only. A raw secret value never
// crosses this boundary, so there is nothing here to cache carefully.

import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { vaultKeyKeys } from './keys';

/** Every credential the vault holds, partitioned into categories. */
export function useKeysList() {
  return useQuery({
    queryKey: vaultKeyKeys.all(),
    queryFn: () => rpc.keys.list(),
  });
}
