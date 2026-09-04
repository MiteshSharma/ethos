import { useMutation, useQueryClient } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { recipeKeys } from './keys';

type InstallInput = Parameters<typeof rpc.recipes.install>[0];

/**
 * Stage 5. Never fires on mount — the user presses the button that names the
 * outcome. Errors are NOT toasted here: stages 1-4 refuse by throwing and the
 * refusal ("fix this and retry") is rendered in place, next to the thing to
 * fix, while an `ok: false` report is a RESULT and gets the post-install panel.
 */
export function useRecipeInstall() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: InstallInput) => rpc.recipes.install(input),
    onSettled: () => {
      // An install writes a personality, cron jobs and MCP attachments — and a
      // compensated failure deletes some of them again. Both outcomes leave
      // those three lists stale, so refresh on settle rather than on success.
      void queryClient.invalidateQueries({ queryKey: ['personalities'] });
      void queryClient.invalidateQueries({ queryKey: ['cron'] });
      void queryClient.invalidateQueries({ queryKey: ['plugins'] });
      void queryClient.invalidateQueries({ queryKey: recipeKeys.all() });
    },
  });
}
