import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { rpc } from '../rpc';

// Resolves the currently active personality for the chat surface.
//
// Source of truth (W2a): the user's `~/.ethos/config.yaml` `personality`
// field, surfaced via `rpc.config.get()`. The user can override this for
// the current chat session via the personality switcher (W2d) — that
// override lives in component state, never written back to the config.
//
// Returns `null` while the config query is loading; callers render a
// neutral chrome until the personality resolves so the very first paint
// doesn't flash an empty accent stripe.

export interface ActivePersonality {
  id: string;
  /** Per-session override. Defaults to the config-side personality. */
  setOverride: (personalityId: string | null) => void;
  /** Active model — surfaced in the personality bar alongside the name. */
  model: string;
  /** True until the config query resolves. */
  isLoading: boolean;
}

export function useActivePersonality(): ActivePersonality {
  const { data, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });
  const [override, setOverride] = useState<string | null>(null);

  // While loading, fall back to a sensible default so chrome can render.
  // The config query has 30s staleTime — most renders skip the network.
  const id = override ?? data?.personality ?? 'researcher';
  const model = data?.model ?? '';

  return { id, setOverride, model, isLoading };
}
