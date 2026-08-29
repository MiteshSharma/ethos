// Fence activation — the pure decision half of Lane B.
//
// Three inputs meet here: what the fence says it is, what the active
// personality's skill set declares it may render (`personalities.renderers`),
// and what this surface actually bundles (the registry). All three must agree
// or the block stays a code block. Fail-closed by construction: an empty or
// still-loading declaration list decides `code`.

/** `<renderer>@<spec>` as declared by a skill's `ethos.renders`. */
const DECLARATION_RE = /^([a-z][a-z0-9-]*)@(\d+)$/;

/** What this surface can render, independent of any personality. */
export interface RendererCapability {
  fenceLang: string;
  specVersions: number[];
}

export type FenceDecision =
  | { kind: 'code' }
  | { kind: 'render'; fenceLang: string; specVersion: number }
  | { kind: 'version-mismatch'; fenceLang: string; declared: number[]; supported: number[] };

const CODE: FenceDecision = { kind: 'code' };

/** Spec versions declared for `fenceLang`, ascending. Malformed entries are ignored. */
export function declaredSpecVersions(declarations: readonly string[], fenceLang: string): number[] {
  const versions = new Set<number>();
  for (const entry of declarations) {
    const match = DECLARATION_RE.exec(entry);
    if (match?.[1] === fenceLang && match[2]) versions.add(Number(match[2]));
  }
  return [...versions].sort((a, b) => a - b);
}

export function decideFence(input: {
  language: string;
  streaming: boolean;
  declarations: readonly string[];
  registry: readonly RendererCapability[];
}): FenceDecision {
  const { language, streaming, declarations, registry } = input;
  // An unclosed fence is a code block running to end of input, so during
  // streaming the body is a partial prefix. Upgrade once, on completion.
  if (streaming) return CODE;
  if (!language) return CODE;

  const entry = registry.find((candidate) => candidate.fenceLang === language);
  if (!entry) return CODE;

  const declared = declaredSpecVersions(declarations, language);
  if (declared.length === 0) return CODE;

  const shared = declared.filter((version) => entry.specVersions.includes(version));
  const best = shared[shared.length - 1];
  if (best === undefined) {
    return {
      kind: 'version-mismatch',
      fenceLang: language,
      declared,
      supported: [...entry.specVersions].sort((a, b) => a - b),
    };
  }
  return { kind: 'render', fenceLang: language, specVersion: best };
}
