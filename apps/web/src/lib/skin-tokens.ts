import { BUILTIN_SKINS, DEFAULT_TOKENS, resolveSkin, type Tokens } from '@ethosagent/design-tokens';
import { useMemo } from 'react';
import { useConfigRetryFalse } from '../features/config/api/queries';

// The resolved token pack for the active skin. `Root` (main.tsx) computes this
// for the Antd bridge and the root CSS variables; the emitted variables cover
// surface / border / text / semantic / layout / radius only, so consumers that
// need the parts that never became CSS variables — the categorical `accents`,
// typography, motion durations — have to re-derive from the token object.
//
// Rather than adding a tokens context, this re-derives from the same
// `config.get` query Root reads. It is the same cached react-query entry
// (30 s staleTime, no extra request) and `resolveSkin` is pure, so the cost is
// an object build behind a `useMemo`.

export function resolveTokensForSkin(skinName: string | undefined): Tokens {
  if (!skinName || !BUILTIN_SKINS[skinName]) return DEFAULT_TOKENS;
  try {
    return resolveSkin(DEFAULT_TOKENS, BUILTIN_SKINS, skinName);
  } catch {
    return DEFAULT_TOKENS;
  }
}

export function useResolvedTokens(): Tokens {
  const configQuery = useConfigRetryFalse();
  const skinName = configQuery.data?.skin ?? 'paper';
  return useMemo(() => resolveTokensForSkin(skinName), [skinName]);
}
