import { type FenceRendererResolver, MarkdownRenderer } from '@ethosagent/ui-components';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

// The `packages/ui-components` seam, exercised through real react-markdown.
// `renderToStaticMarkup` needs no DOM, so this stays a plain `.test.ts` in the
// existing suite — no jsdom, no testing-library.

const CHART_FENCE = '```echarts\n{"series":[{"type":"bar","data":[1]}]}\n```';

function render(content: string, props: Partial<Parameters<typeof MarkdownRenderer>[0]> = {}) {
  return renderToStaticMarkup(createElement(MarkdownRenderer, { content, ...props }));
}

/** Stands in for the app resolver so the seam is tested without echarts. */
function stubResolver(
  behaviour: (
    language: string,
    code: string,
    streaming: boolean,
  ) => ReturnType<FenceRendererResolver>,
): FenceRendererResolver {
  return ({ language, code, streaming }) => behaviour(language, code, streaming);
}

describe('MarkdownRenderer fence seam', () => {
  it('renders the code block unchanged with no resolver', () => {
    const html = render(CHART_FENCE);
    expect(html).toContain('<pre class="my-2 overflow-x-auto rounded border border-border');
    expect(html).toContain('class="font-mono language-echarts"');
  });

  it('offers the fence language and raw body to the resolver', () => {
    const seen: { language: string; code: string; streaming: boolean }[] = [];
    render(CHART_FENCE, {
      fenceRenderers: ({ language, code, streaming }) => {
        seen.push({ language, code, streaming });
        return null;
      },
    });
    expect(seen).toEqual([
      { language: 'echarts', code: '{"series":[{"type":"bar","data":[1]}]}\n', streaming: false },
    ]);
  });

  it('replaces the block when the resolver claims it', () => {
    const html = render(CHART_FENCE, {
      fenceRenderers: stubResolver(() => ({
        kind: 'replace',
        node: createElement('div', { className: 'chart-block' }, 'chart'),
      })),
    });
    expect(html).toContain('class="chart-block"');
    expect(html).not.toContain('<pre');
  });

  it('keeps the code block and appends the notice when the resolver annotates', () => {
    const html = render(CHART_FENCE, {
      fenceRenderers: stubResolver(() => ({
        kind: 'annotate',
        notice: createElement('div', { className: 'fence-version-notice' }, 'unsupported'),
      })),
    });
    expect(html).toContain('<pre');
    expect(html).toContain('class="fence-version-notice"');
  });

  it('reports streaming so a partial fence is never upgraded', () => {
    const seen: boolean[] = [];
    render('```echarts\n{"series":[{"type":"ba', {
      streaming: true,
      fenceRenderers: ({ streaming }) => {
        seen.push(streaming);
        return null;
      },
    });
    expect(seen).toEqual([true]);
  });

  it('never offers inline code to the resolver', () => {
    const seen: string[] = [];
    const html = render('Use `echarts` for this.', {
      fenceRenderers: ({ language }) => {
        seen.push(language);
        return null;
      },
    });
    expect(seen).toEqual([]);
    // Inline code keeps the pill treatment, not the block chrome.
    expect(html).toContain('px-[0.3em]');
    expect(html).not.toContain('<pre');
  });

  it('renders an untagged fence as a block, not as inline code', () => {
    const html = render('```\nplain text\n```');
    expect(html).toContain('<pre class="my-2 overflow-x-auto');
    expect(html).toContain('<code class="font-mono">');
    expect(html).not.toContain('px-[0.3em]');
  });

  it('reports an empty language for an untagged fence', () => {
    const seen: string[] = [];
    render('```\nplain\n```', {
      fenceRenderers: ({ language }) => {
        seen.push(language);
        return null;
      },
    });
    expect(seen).toEqual(['']);
  });

  it('does not leak react-markdown’s hast node onto the code element', () => {
    // Every override in this file used to spread `...props` — which carries
    // react-markdown's `node` handle — straight onto the DOM. Fixed here for
    // the fence path; the remaining overrides (`p`, `li`, `a`, …) still leak
    // it and are outside this change.
    const html = render(`${CHART_FENCE}\n\nplus \`inline\`.`);
    const tags = html.match(/<(?:pre|code)\b[^>]*>/g) ?? [];
    expect(tags.length).toBe(3);
    for (const tag of tags) expect(tag).not.toContain('node=');
  });
});
