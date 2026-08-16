import { useLocation } from 'react-router-dom';
import { useConfig } from '../features/config/api/queries';
import { extractWorkspacePersonalityId } from '../lib/scopeNav';

// Resolves the currently active personality.
//
// Source of truth (P2, plan/phases/personality-first-ui.md): the URL. A
// component rendered under `/p/:personalityId/*` is IN that agent's
// workspace, and that is what "active" means — `extractWorkspacePersonalityId`
// reads it off `useLocation().pathname`, the same pure lookup App.tsx and
// AltitudeRail already use for the accent lift and the rail's active mark, so
// every consumer of "which agent" agrees without threading a prop through.
// Falls back to `~/.ethos/config.yaml`'s `personality` field (via
// `rpc.config.get()`) outside any workspace route — QuickChat (the desktop
// mini-window, mounted outside the router's `/p/:id/*` tree entirely) is the
// one real caller that lands here.
//
// Previously this held a component-local session override (`setOverride`),
// set by Chat.tsx from the opened session's stored `personalityId`. That's
// gone: a session's personality and the workspace route's `:personalityId`
// are now the same value by construction (every link that opens a session
// goes through `sessionOpenPath`, which always routes to
// `/p/{session.personalityId}/chat`), so a second, independently-tracked
// override could only ever drift from the URL, not usefully override it.
//
// Returns `null` while the config query is loading; callers render a
// neutral chrome until the personality resolves so the very first paint
// doesn't flash an empty accent stripe.

export interface ActivePersonality {
  id: string;
  /** Active model — surfaced in the personality bar alongside the name. */
  model: string;
  /** True until the config query resolves. */
  isLoading: boolean;
}

export function useActivePersonality(): ActivePersonality {
  const { pathname } = useLocation();
  const { data, isLoading } = useConfig();

  // While loading, fall back to a sensible default so chrome can render.
  // The config query has 30s staleTime — most renders skip the network.
  const id = extractWorkspacePersonalityId(pathname) ?? data?.personality ?? 'researcher';
  const model = data?.model ?? '';

  return { id, model, isLoading };
}
