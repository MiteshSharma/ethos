import { Component, type ReactNode, Suspense } from 'react';
import { LAZY_FENCE_RENDERERS } from './registry';

// Everything a resolver hands back to `MarkdownRenderer` is built here, so the
// failure modes stay in one place: a chunk that will not load, a renderer that
// throws, and a spec version this surface does not map all degrade to the same
// code block the fence would have rendered as anyway.

/**
 * The fallback every failure path lands on. Deliberately the same DOM
 * `MarkdownRenderer` produces for a fenced block, so a broken chart is
 * indistinguishable from a surface that never had the renderer.
 */
export function FenceCodeBlock({ language, source }: { language: string; source: string }) {
  return (
    <pre className="my-2 overflow-x-auto rounded border border-border bg-muted p-3 text-sm">
      <code className={language ? `font-mono language-${language}` : 'font-mono'}>{source}</code>
    </pre>
  );
}

interface BoundaryProps {
  fallback: ReactNode;
  children: ReactNode;
}

class FenceErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * A fence this surface can render. The lazy component type comes from the
 * module-scope registry map, so it is stable across renders and Suspense does
 * not re-trigger on every streamed token.
 */
export function RenderedFence({
  fenceLang,
  source,
  option,
}: {
  fenceLang: string;
  source: string;
  option: Record<string, unknown>;
}) {
  const Renderer = LAZY_FENCE_RENDERERS.get(fenceLang);
  const fallback = <FenceCodeBlock language={fenceLang} source={source} />;
  if (!Renderer) return fallback;
  return (
    // Keyed on the source so a boundary that latched on one spec does not keep
    // the next one from ever rendering.
    <FenceErrorBoundary key={source} fallback={fallback}>
      <Suspense fallback={fallback}>
        <Renderer source={source} option={option} />
      </Suspense>
    </FenceErrorBoundary>
  );
}

/**
 * Named, not silent: the personality declares a spec this surface does not
 * map, so the fence stays a code block and the notice says which versions are
 * on each side.
 */
export function SpecVersionNotice({
  fenceLang,
  declared,
  supported,
}: {
  fenceLang: string;
  declared: number[];
  supported: number[];
}) {
  return (
    <div className="fence-version-notice" role="note">
      {`Chart spec ${fenceLang}@${declared.join(', ')} is not supported by this surface (it renders ${fenceLang}@${supported.join(', ')}) — showing the spec.`}
    </div>
  );
}
