import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FeedbackRow } from '../../../components/ui/FeedbackRow';
import { AdminExecutionRow } from '../../Admin';
import { postureLine, probeHeaderView } from '../panes/execution';

// Settings › Execution — the six states of the probe header
// (plan/phases/remote-execution-routing.md §6, T7), plus the two promises the
// pane keeps in CSS rather than in markup.
//
// Every state is asserted through `probeHeaderView` AND through the markup
// `FeedbackRow` produces for it, because the contract's rule is not "similar
// words appear on screen" — it is that this page draws the SAME row the chat
// trail draws. A lookalike component with the same sentence would sail past a
// text check, so the assertions are on `.activity-row` markup and are compared
// against a `FeedbackRow` rendered directly from the view.
//
// `renderToStaticMarkup` — `apps/web` has no jsdom (see
// `settings-advanced-dims.test.ts`), and this change does not add one.

const css = readFileSync(join(import.meta.dirname, '..', '..', '..', 'styles.css'), 'utf8');

function cssBlock(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule: ${selector}`).toBeGreaterThan(-1);
  return css.slice(start, css.indexOf('}', start));
}

/** The row the pane renders for a view — the shared component, not a copy. */
function rowMarkup(view: ReturnType<typeof probeHeaderView>): string {
  return renderToStaticMarkup(
    createElement(FeedbackRow, {
      status: view.status,
      subject: view.subject,
      ...(view.result ? { result: view.result } : {}),
      ...(view.meta ? { meta: view.meta } : {}),
    }),
  );
}

/** Visible text, tags stripped — for glyph+word assertions. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

const TARGET = 'deploy@build-01:22';
/** A real ssh refusal, byte for byte. The point of the state is that this line
 *  reaches the operator unaltered — it names the fix. */
const PUBLICKEY = 'deploy@build-01: Permission denied (publickey).';

describe('the six states of the Execution header', () => {
  it('not configured — hollow dot, glyph and word, and never an error', () => {
    const view = probeHeaderView({ state: 'not_configured' }, false);
    expect(view.dot).toBe('hollow');
    expect(view.result).toBe('Not configured — add a host below');

    const html = rowMarkup(view);
    // Glyph AND word, both present.
    expect(text(html)).toContain('– unrecorded');
    // Not an error state: no failure class, no failure glyph, no failure word.
    expect(html).not.toContain('activity-row-failed');
    expect(text(html)).not.toContain('✗');
    expect(text(html)).not.toContain('failed');
    // And the dot it pairs with is a ring, not a red fill.
    const dot = cssBlock('.settings-execution-dot--hollow');
    expect(dot).toContain('background: none');
    expect(dot).not.toContain('--error');
  });

  it('probing — amber pulsing dot, the target in the sentence, glyph and word', () => {
    const view = probeHeaderView({ state: 'reachable', target: TARGET, latencyMs: 340 }, true);
    expect(view.dot).toBe('probing');
    expect(view.result).toBe(`Testing ${TARGET}…`);
    expect(text(rowMarkup(view))).toContain('· running');

    const dot = cssBlock('.settings-execution-dot--probing');
    expect(dot).toContain('var(--warning)');
    expect(dot).toContain('animation: status-dot-pulse');
  });

  it('reachable — green dot, mono target, latency in the meta column', () => {
    const view = probeHeaderView({ state: 'reachable', target: TARGET, latencyMs: 340 }, false);
    expect(view.dot).toBe('reachable');
    expect(cssBlock('.settings-execution-dot--reachable')).toContain('var(--success)');

    const html = rowMarkup(view);
    expect(text(html)).toContain('✓ ok');
    expect(html).toContain(`activity-row-subject">${TARGET}`);
    expect(html).toContain('activity-row-meta">340 ms');
  });

  it('unreachable — red dot and the ssh stderr VERBATIM', () => {
    const view = probeHeaderView({ state: 'unreachable', target: TARGET, error: PUBLICKEY }, false);
    expect(view.dot).toBe('unreachable');
    expect(cssBlock('.settings-execution-dot--unreachable')).toContain('var(--error)');

    const html = rowMarkup(view);
    expect(text(html)).toContain('✗ failed');
    // Byte for byte: not summarised, not re-worded, not sentence-cased, no
    // prefix and no trailing punctuation of ours.
    expect(view.result).toBe(PUBLICKEY);
    expect(html).toContain(PUBLICKEY);
  });

  it('distinguishes the two refusals instead of flattening them into one word', () => {
    const timeout = 'ssh: connect to host build-01 port 22: Connection timed out';
    const denied = probeHeaderView(
      { state: 'unreachable', target: TARGET, error: PUBLICKEY },
      false,
    );
    const timedOut = probeHeaderView(
      { state: 'unreachable', target: TARGET, error: timeout },
      false,
    );
    expect(denied.result).not.toBe(timedOut.result);
    expect(timedOut.result).toBe(timeout);
  });

  it('boot failure — the admin panel gains an --error row, glyph and word', () => {
    // The pane's own answer names the fault without calling it unreachable: no
    // connection was attempted.
    const view = probeHeaderView(
      { state: 'backend_unresolved', target: TARGET, error: 'ssh backend is not registered' },
      false,
    );
    expect(view.result).toContain('Execution backend ssh failed to resolve');
    expect(text(rowMarkup(view))).toContain('✗ failed');

    const html = renderToStaticMarkup(
      createElement(AdminExecutionRow, {
        backend: { name: 'ssh', resolved: false, error: 'ssh backend is not registered' },
      }),
    );
    expect(html).toContain('admin-execution-row--error');
    expect(text(html)).toContain('✗');
    expect(text(html)).toContain('failed');
    expect(text(html)).toContain('Execution backend ssh failed to resolve — see logs');
    expect(cssBlock('.admin-execution-row--error')).toContain('var(--error)');
  });

  it('config edited after boot — glyph and word, both hosts named, neither contacted', () => {
    const view = probeHeaderView(
      { state: 'stale_config', target: 'deploy@build-02:22', activeTarget: TARGET },
      false,
    );
    // Neither a tick nor a cross: no host was dialled, so there is no verdict
    // about one. `unverified` is the row's existing word for exactly that — not
    // a sixth vocabulary invented for this pane.
    expect(view.status).toBe('unverified');
    expect(view.dot).toBe('hollow');

    const html = rowMarkup(view);
    expect(text(html)).toContain('⚠ unverified');
    // The operationally important half leads: where tools are STILL running.
    expect(view.result).toContain(`Tools still run on ${TARGET}`);
    expect(view.result).toContain('deploy@build-02:22');
    expect(view.result).toContain('Restart to apply');
    expect(view.result).toContain('Neither host was contacted');
    // Not a failure of either machine.
    expect(html).not.toContain('activity-row-failed');
    expect(text(html)).not.toContain('✗');
  });

  it('the admin row is silent when the backend resolves, and when there is none', () => {
    expect(
      renderToStaticMarkup(
        createElement(AdminExecutionRow, {
          backend: { name: 'ssh', resolved: true, error: null },
        }),
      ),
    ).toBe('');
    expect(renderToStaticMarkup(createElement(AdminExecutionRow, { backend: null }))).toBe('');
  });
});

describe('the header is the shared row, not a lookalike', () => {
  it.each([
    ['not configured', probeHeaderView({ state: 'not_configured' }, false)],
    ['probing', probeHeaderView(undefined, true)],
    ['reachable', probeHeaderView({ state: 'reachable', target: TARGET, latencyMs: 340 }, false)],
    [
      'unreachable',
      probeHeaderView({ state: 'unreachable', target: TARGET, error: PUBLICKEY }, false),
    ],
    [
      'backend unresolved',
      probeHeaderView({ state: 'backend_unresolved', target: TARGET, error: 'boom' }, false),
    ],
    [
      'stale config',
      probeHeaderView(
        { state: 'stale_config', target: 'deploy@build-02:22', activeTarget: TARGET },
        false,
      ),
    ],
  ])('%s renders through FeedbackRow', (_name, view) => {
    const html = rowMarkup(view);
    // `.activity-row` + the status modifier is `FeedbackRow`'s own markup —
    // the class base the trail rows and the drawer share.
    expect(html).toContain(`class="activity-row activity-row-${view.status}"`);
    expect(html).toContain('activity-row-state');
  });

  it('is never a toast — no alert role, no antd message chrome', () => {
    const html = rowMarkup(probeHeaderView({ state: 'not_configured' }, false));
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('ant-message');
  });
});

describe('the posture line', () => {
  it('names the personalities that route to the target', () => {
    expect(postureLine(['remote-hands'])).toBe('ssh — used by: remote-hands');
    expect(postureLine(['remote-hands', 'builder'])).toBe('ssh — used by: remote-hands, builder');
  });

  it('says plainly that nobody does, rather than showing an empty list', () => {
    expect(postureLine([])).toContain('no personality declares execution: ssh');
  });
});

describe('what the Execution pane promises in CSS', () => {
  it('prefers-reduced-motion stops the pulse and keeps the amber fill', () => {
    const start = css.indexOf(
      '@media (prefers-reduced-motion: reduce)',
      css.indexOf('.settings-execution-dot--probing'),
    );
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}\n}', start));
    expect(rule).toContain('.settings-execution-dot--probing');
    expect(rule).toContain('animation: none');
    // The colour is a static declaration on the modifier; nothing here may
    // remove it, so the state survives with no motion at all.
    expect(rule).not.toContain('background: none');
  });

  it('≤760px stacks the header and gives the button the full width', () => {
    const start = css.indexOf(
      '@media (max-width: 760px)',
      css.indexOf('.settings-execution-header'),
    );
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf('}\n}', start));
    expect(rule).toContain('.settings-execution-header');
    expect(rule).toContain('flex-direction: column');
    expect(rule).toContain('.settings-execution-test');
    expect(rule).toContain('width: 100%');
  });

  it('gives the action a 44px touch target', () => {
    // An inline style, not a rule, so it is asserted where it lives.
    const pane = readFileSync(join(import.meta.dirname, '..', 'panes', 'execution.tsx'), 'utf8');
    expect(pane).toContain('minHeight: 44');
  });

  it('is rows, not cards — nothing here grows a border, a shadow or a radius', () => {
    const header = cssBlock('.settings-execution-header');
    expect(header).not.toContain('box-shadow');
    expect(header).not.toContain('border-radius');
    // One hairline under the header, exactly as the Backup pane draws it.
    expect(header).toContain('border-bottom: 1px solid var(--border-subtle)');
  });
});
