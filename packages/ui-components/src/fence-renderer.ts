import type { ReactNode } from 'react';

// The fenced-code-block seam. `ui-components` owns the *interception point*
// and the fallback chrome; it knows nothing about charts, spec versions, or
// which renderers a personality is allowed to use. A host surface supplies a
// resolver and answers those questions itself.
//
// Keeping the vocabulary at "language + source + streaming" is what lets this
// library stay dependency-light: adding a renderer is a host-side change, not
// a new dependency here.

/** One fenced code block, offered to the host for possible upgrade. */
export interface FenceRenderRequest {
  /** Fence info string's first word — `echarts` for ` ```echarts `. Empty for an untagged fence. */
  language: string;
  /** Raw fence body, exactly as written. */
  code: string;
  /**
   * True while the surrounding message is still streaming. CommonMark treats
   * an unclosed fence as a code block running to end of input, so a `true`
   * here means the body may be a partial prefix of the eventual content.
   */
  streaming: boolean;
}

/**
 * What the host wants done with the block.
 *
 * - `replace` — render `node` instead of the code block.
 * - `annotate` — render the normal code block, followed by `notice`
 *   (used to name a capability the surface recognises but cannot render).
 *
 * Returning `null` means "render the code block, unchanged".
 */
export type FenceRenderResult =
  | { kind: 'replace'; node: ReactNode }
  | { kind: 'annotate'; notice: ReactNode };

/**
 * Host-supplied fence upgrade decision.
 *
 * MUST be referentially stable across renders — it is baked into the
 * react-markdown component overrides, and a fresh function identity per
 * render remounts the entire markdown subtree on every streamed token.
 * Build it at module scope, or with `useMemo`/`useCallback` keyed on
 * something that only changes when the decision would change.
 */
export type FenceRendererResolver = (request: FenceRenderRequest) => FenceRenderResult | null;
