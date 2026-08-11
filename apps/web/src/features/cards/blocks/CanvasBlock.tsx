import { useEffect, useRef, useState } from 'react';
import { useResolvedTokens } from '../../../lib/skin-tokens';
import { loadCanvasLibraries } from '../canvas-libraries';
import { buildCanvasSrcDoc, CANVAS_RESIZE_MESSAGE } from '../canvas-srcdoc';
import type { CardBlockProps } from '../registry';
import { UnknownCardBlock } from './UnknownCardBlock';

// The Canvas host. Personality-authored HTML, so unlike every other card kind
// this one IS untrusted and does run behind the iframe boundary:
//   • `sandbox="allow-scripts"` and never `allow-same-origin` — granting both
//     returns our own origin to the guest and removes the sandbox entirely.
//   • a CSP meta in the built document that blocks all network (see
//     `canvas-srcdoc.ts` for the per-directive rationale).
//   • libraries inlined from local bundles; no CDN, no remote anything.
// The document is assembled client-side so the server never has to sanitise
// HTML or interpolate a template.

const MIN_HEIGHT_PX = 160;
const MAX_HEIGHT_PX = 800;

/** Stable identity, so "no libraries" never re-renders on a state set. */
const NO_LIBRARIES: string[] = [];

export function CanvasBlock({ card }: CardBlockProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(MIN_HEIGHT_PX);
  const [failedLibrary, setFailedLibrary] = useState(false);
  const tokens = useResolvedTokens();

  const payload = card.kind === 'canvas' ? card.payload : null;
  const requested = payload?.libraries ?? NO_LIBRARIES;
  // A canvas that asks for no library needs no async step — it renders on the
  // first pass rather than flashing a loading line.
  const [libraries, setLibraries] = useState<string[] | null>(() =>
    requested.length === 0 ? NO_LIBRARIES : null,
  );

  useEffect(() => {
    setFailedLibrary(false);
    if (requested.length === 0) {
      setLibraries(NO_LIBRARIES);
      return;
    }
    let cancelled = false;
    setLibraries(null);
    loadCanvasLibraries(requested)
      .then((sources) => {
        if (!cancelled) setLibraries(sources);
      })
      .catch(() => {
        if (!cancelled) setFailedLibrary(true);
      });
    return () => {
      cancelled = true;
    };
  }, [requested]);

  useEffect(() => {
    function onMessage(e: MessageEvent) {
      // Any frame on the page can post to `window`; only our own guest is
      // allowed to resize us. The origin is opaque (no `allow-same-origin`),
      // so `source` identity is the check that works.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data: unknown = e.data;
      if (typeof data !== 'object' || data === null) return;
      const message = data as { type?: unknown; height?: unknown };
      if (message.type !== CANVAS_RESIZE_MESSAGE || typeof message.height !== 'number') return;
      setHeight(Math.min(Math.max(message.height + 16, MIN_HEIGHT_PX), MAX_HEIGHT_PX));
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  if (!payload) return <UnknownCardBlock card={card} />;
  // An unknown library is a server-validation miss, not a render error — say
  // what is missing instead of shipping a document whose script will fail.
  if (failedLibrary) return <UnknownCardBlock card={card} />;

  const srcDoc =
    libraries === null
      ? null
      : buildCanvasSrcDoc({
          html: payload.html,
          data: payload.data,
          librarySources: libraries,
          tokens,
        });

  return (
    <div className="card-block card-canvas">
      {payload.title ? <div className="card-canvas-title">{payload.title}</div> : null}
      {srcDoc === null ? (
        <div className="card-chart-loading">Loading canvas…</div>
      ) : (
        <iframe
          ref={iframeRef}
          srcDoc={srcDoc}
          sandbox="allow-scripts"
          className="card-canvas-frame"
          style={{ height: `${height}px` }}
          title={payload.title ?? 'Agent canvas'}
        />
      )}
    </div>
  );
}

export default CanvasBlock;
