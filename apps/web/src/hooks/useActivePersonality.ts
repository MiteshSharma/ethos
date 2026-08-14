import { useState } from 'react';
import { useConfig } from '../features/config/api/queries';

// Resolves the currently active personality for the chat surface.
//
// Source of truth (W2a): the user's `~/.ethos/config.yaml` `personality`
// field, surfaced via `rpc.config.get()`. The override is the SESSION's
// binding, not a preference: a session belongs to the personality it started
// with, so Chat sets it from the opened session's stored `personalityId`, or
// from the New Session picker when a fresh one is being started. It lives in
// component state and is never written back to the config.
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
  const { data, isLoading } = useConfig();
  const [override, setOverride] = useState<string | null>(null);

  // While loading, fall back to a sensible default so chrome can render.
  // The config query has 30s staleTime — most renders skip the network.
  const id = override ?? data?.personality ?? 'researcher';
  const model = data?.model ?? '';

  return { id, setOverride, model, isLoading };
}
