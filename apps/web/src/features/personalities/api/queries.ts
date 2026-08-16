import { useQuery } from '@tanstack/react-query';
import { rpc } from '../../../rpc';
import { personalityKeys } from './keys';

export function usePersonalityList(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: personalityKeys.list(),
    queryFn: () => rpc.personalities.list({}),
    ...options,
  });
}

export function usePersonalityGet(id: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: personalityKeys.detail(id),
    queryFn: () => rpc.personalities.get({ id }),
    ...options,
  });
}

export function useCharacterSheet(id: string) {
  return useQuery({
    queryKey: personalityKeys.characterSheet(id),
    queryFn: () => rpc.personalities.characterSheet({ id }),
  });
}

export function usePersonalitySkillsList(personalityId: string, options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: personalityKeys.skills(personalityId),
    queryFn: () => rpc.personalities.skillsList({ personalityId }),
    ...options,
  });
}

/**
 * Renderer capabilities (`<renderer>@<spec>`) the personality's skill set
 * declares — what a chat surface is allowed to upgrade a fenced block into.
 *
 * Takes the id as a parameter rather than calling `useActivePersonality()`
 * itself: that hook's session override is component-local `useState`, so a
 * hook calling it independently would read the config personality and miss the
 * override. Callers pass the id they actually rendered with.
 *
 * Fail-closed: loading and errored both yield an empty set, which every
 * consumer must treat as "render the code block".
 */
export function useActiveRenderers(personalityId: string): { renderers: string[] } {
  const query = useQuery({
    queryKey: personalityKeys.renderers(personalityId),
    queryFn: () => rpc.personalities.renderers({ id: personalityId }),
    enabled: personalityId.length > 0,
  });
  return { renderers: query.data?.renderers ?? [] };
}
