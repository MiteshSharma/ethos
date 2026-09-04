// @vitest-environment jsdom
//
// The feedback row is what any page outside chat uses to show an action it
// took — a backup, a probe, an install stage, an observe heartbeat (contract
// §6). Two things make it trustworthy and both are asserted here: it speaks
// the SAME vocabulary as the trail's rows (so a user learns it once), and an
// outcome resolves the row IN PLACE rather than replacing it with a toast that
// disappears (§7, "nothing vanishes").

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { TrailRow } from '../../chat/Trail';
import { FeedbackRow, type FeedbackRowProps } from '../FeedbackRow';

function markup(props: Partial<FeedbackRowProps> = {}): string {
  return renderToStaticMarkup(
    createElement(FeedbackRow, {
      status: 'running',
      subject: 'nightly-backup',
      ...props,
    }),
  );
}

/** The markup's visible text, tags stripped. */
function text(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

describe('FeedbackRow', () => {
  it('pairs a glyph with a word for every outcome', () => {
    expect(markup({ status: 'running' })).toContain('running');
    expect(markup({ status: 'ok' })).toContain('✓');
    expect(markup({ status: 'ok' })).toContain('ok');
    expect(markup({ status: 'failed' })).toContain('✗');
    expect(markup({ status: 'failed' })).toContain('failed');
    expect(markup({ status: 'unverified' })).toContain('⚠');
    expect(markup({ status: 'unverified' })).toContain('unverified');
  });

  it('carries a mono subject, a meta column and the result text', () => {
    const html = markup({ status: 'ok', meta: '1.2s', result: '412 MB written' });
    expect(html).toContain('nightly-backup');
    expect(html).toContain('1.2s');
    expect(html).toContain('412 MB written');
  });

  it('resolves IN PLACE — the same row, now carrying its outcome', () => {
    const pending = markup({ status: 'running' });
    const resolved = markup({ status: 'ok', meta: '1.2s', result: '412 MB written' });
    // Still the same subject and still a row; the state and the result changed.
    expect(pending).toContain('nightly-backup');
    expect(resolved).toContain('nightly-backup');
    expect(pending).toContain('activity-row');
    expect(resolved).toContain('activity-row');
    expect(pending).not.toContain('412 MB written');
    expect(resolved).toContain('412 MB written');
  });

  it('is not a toast — it is never a dialog or an alert that clears itself', () => {
    const html = markup({ status: 'ok' });
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain('ant-message');
  });

  it('speaks the same vocabulary as a trail row', () => {
    // One row language across the product: same class base, same glyph+word.
    const feedback = markup({ status: 'ok', subject: 'read_file' });
    const trail = renderToStaticMarkup(
      createElement(TrailRow, {
        rowId: 'trail-row-t1-tc1',
        entry: {
          kind: 'action',
          toolCallId: 'tc1',
          toolName: 'read_file',
          args: {},
          status: 'ok',
        },
      }),
    );
    expect(feedback).toContain('activity-row activity-row-ok');
    expect(trail).toContain('activity-row activity-row-ok');
    expect(text(feedback)).toContain('✓ ok');
    expect(text(trail)).toContain('✓ ok');
  });
});
