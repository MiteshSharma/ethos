import type { Tokens } from '@ethosagent/design-tokens';
import { tokensToCssVariables } from '@ethosagent/design-tokens/antd';

// The Canvas document, assembled client-side. Pure so the security-relevant
// parts — the CSP, the data escaping, the freeze — are asserted without a DOM.
//
// The iframe is loaded with `sandbox="allow-scripts"` and NO `allow-same-origin`
// (see CanvasBlock): the two together would hand the document our own origin
// back and there would be no sandbox at all. Without `allow-same-origin` the
// document has an opaque origin — no cookies, no storage, no reach into the
// parent DOM — and `postMessage` is the only channel out.

/**
 * Every directive here is load-bearing:
 *   • `default-src 'none'` — the deny-all base. It is what blocks `connect-src`
 *     (fetch / XHR / WebSocket / EventSource), `frame-src`, `font-src`,
 *     `media-src` and `object-src`, since each falls back to default-src. A
 *     Canvas template gets the data it was given and cannot phone home.
 *   • `script-src 'unsafe-inline'` — the library bundle, the data global and
 *     the template's own script are all inline. No `'self'`, so no external
 *     script can be pulled in; no `'unsafe-eval'`, so `eval`/`new Function`
 *     stay blocked. ('unsafe-inline' is only ignored when a nonce or hash is
 *     also present — we deliberately ship neither.)
 *   • `style-src 'unsafe-inline'` — inline `<style>` and `style=` attributes.
 *   • `img-src data:` — charts and templates draw with data URIs; remote image
 *     loads stay blocked because `data:` is the whole allowlist.
 * Fonts are intentionally absent: `default-src 'none'` blocks `font-src`, so a
 * Canvas renders in the system stack the CSS variables below name.
 */
export const CANVAS_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:;";

/** Global the template's own script reads. */
export const CANVAS_DATA_GLOBAL = 'ethosData';

/** Message the guest posts to ask the host for a new height. */
export const CANVAS_RESIZE_MESSAGE = 'ethos-canvas-resize';

export interface CanvasSrcDocInput {
  /** Personality-authored document body. */
  html: string;
  /** JSON value handed to the template. */
  data?: unknown;
  /** Allowlisted library bundles, already resolved to source text. */
  librarySources?: readonly string[];
  /** Resolved skin, so the guest follows the app's dark/light. */
  tokens: Tokens;
}

/**
 * JSON, safe to paste into a `<script>` body. `<` is escaped so a payload
 * containing the literal `</script>` cannot close the tag — it can only ever
 * occur inside a JSON string, where `<` is the same character.
 * U+2028/U+2029 are valid JSON but not valid JS string content.
 */
function embedJson(value: unknown): string {
  const json = JSON.stringify(value ?? null) ?? 'null';
  return json
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function dataScript(data: unknown): string {
  // Deep-frozen: a template that mutates its input silently is a template
  // whose second render disagrees with its first.
  return `<script>
(function () {
  var value = ${embedJson(data)};
  (function freeze(node) {
    if (node && typeof node === 'object' && !Object.isFrozen(node)) {
      Object.freeze(node);
      for (var key in node) freeze(node[key]);
    }
  })(value);
  Object.defineProperty(window, '${CANVAS_DATA_GLOBAL}', { value: value, writable: false });
})();
</script>`;
}

const RESIZE_SCRIPT = `<script>
(function () {
  function report() {
    parent.postMessage(
      { type: '${CANVAS_RESIZE_MESSAGE}', height: document.documentElement.scrollHeight },
      '*'
    );
  }
  window.addEventListener('load', report);
  new ResizeObserver(report).observe(document.body);
})();
</script>`;

function baseStyles(tokens: Tokens): string {
  const { typography } = tokens;
  return `${tokensToCssVariables(tokens)}
:root {
  --ethos-font: ${typography.fontDisplay};
  --ethos-font-mono: ${typography.fontMono};
}
html, body {
  margin: 0;
  padding: 0;
  background: var(--ethos-bg);
  color: var(--ethos-text);
  font-family: var(--ethos-font);
  font-size: ${typography.scale.body.px}px;
  line-height: ${typography.scale.body.lineHeight};
}
body { padding: 12px; }`;
}

export function buildCanvasSrcDoc(input: CanvasSrcDocInput): string {
  const { html, data, librarySources = [], tokens } = input;
  const libraries = librarySources.map((source) => `<script>${source}</script>`).join('\n');
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CANVAS_CSP}">
<style>${baseStyles(tokens)}</style>
</head>
<body>
${dataScript(data)}
${libraries}
${html}
${RESIZE_SCRIPT}
</body>
</html>`;
}
