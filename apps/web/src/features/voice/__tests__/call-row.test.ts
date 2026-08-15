import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CallRow } from '../CallRow';
import { type CallSummary, callRowView } from '../call-rows';

// CallRow is hook-free, so it renders with `renderToStaticMarkup` — the
// apps/web suite has no DOM.

const START = 1_700_000_000_000;

function call(over: Partial<CallSummary> = {}): CallSummary {
  return {
    id: 'CA_1',
    botKey: 'bot_a',
    laneKey: 'voice:bot_a:sip:+15550001111',
    direction: 'inbound',
    fromNumber: '+15550001111',
    toNumber: '+15559998888',
    personalityId: 'engineer',
    tier: 'realtime',
    status: 'completed',
    startedAt: START,
    endedAt: START + 83_000,
    reason: null,
    summaryPreview: 'Asked about the deploy window.',
    hasTranscript: true,
    costUsd: 0.42,
    ...over,
  };
}

function markup(over: Partial<CallSummary> = {}, now = START + 83_000): string {
  const c = call(over);
  return renderToStaticMarkup(
    createElement(CallRow, { call: c, view: callRowView(c, now), onOpenTranscript: () => {} }),
  );
}

/** Every element carrying a number, a duration or an id, with its classes. */
function classedSpans(html: string): string[] {
  return [...html.matchAll(/<span class="([^"]*)"[^>]*>([^<]*)<\/span>/g)].map(
    (m) => `${m[1]}|${m[2]}`,
  );
}

describe('CallRow', () => {
  it('is a row, never the Card primitive', () => {
    const html = markup();
    expect(html).toContain('call-row');
    expect(html).not.toContain('ant-card');
  });

  it('every literal — number, duration, tier, cost, state — is mono and tabular', () => {
    const html = markup();
    // Measured, not grepped: each of these values is located by its TEXT, and
    // the class it actually carries is what gets asserted. A row that renders
    // the number in the body face passes a `toContain('call-mono')` check and
    // fails this one.
    const spans = classedSpans(html);
    const carriedBy = (text: string) =>
      spans.find((s) => s.endsWith(`|${text}`))?.split('|')[0] ?? '';
    for (const literal of ['+15550001111', '1:23', 'realtime', '$0.42', 'completed', 'engineer']) {
      expect(carriedBy(literal), `"${literal}" is not in a .call-mono element`).toContain(
        'call-mono',
      );
    }
  });

  it('shows the far end of the call and the personality that answered', () => {
    const html = markup();
    expect(html).toContain('+15550001111');
    expect(html).not.toContain('+15559998888');
    expect(html).toContain('engineer personality'); // PersonalityMark's aria-label
  });

  it('says so when no personality was ever bound, instead of rendering a gap', () => {
    expect(markup({ personalityId: null })).toContain('no personality');
  });

  it('carries the answering personality’s own accent, so the live dot is not generic blue', () => {
    // `--accent` is defined on the chat subtree and nowhere else, so a row that
    // did not stamp it would pulse the generic info blue on every call.
    const engineer = markup({ personalityId: 'engineer' });
    const operator = markup({ personalityId: 'operator' });
    expect(engineer).toContain('--accent:');
    expect(engineer).not.toEqual(operator);
    // Nothing to stamp when nobody answered — the fallback is correct there.
    expect(markup({ personalityId: null })).not.toContain('--accent:');
  });

  it('a live call carries the new dot modifier and a ticking duration', () => {
    const html = markup({ status: 'live', endedAt: null }, START + 42_000);
    expect(html).toContain('sb-dot--call-live');
    expect(html).toContain('0:42');
  });

  // An outbound call the agent placed is closed the moment the trunk accepts the
  // dial; nothing hears it end, so the log holds no `endedAt`. The cell is left
  // OUT — the shape `tier` and `cost` already use — rather than rendering a
  // duration that grows forever, or an invented `0:00`.
  it('draws no duration cell at all when nothing timed the call', () => {
    const html = markup(
      { direction: 'outbound', status: 'completed', endedAt: null },
      START + 90_000,
    );
    expect(html).not.toContain('call-duration');
    // The rest of the row is intact — this is a missing FACT, not a broken row.
    expect(html).toContain('completed');
    expect(html).toContain('+15559998888');
  });

  it('a screened row is drawn back and names its reason inline', () => {
    const html = markup({ status: 'screened', reason: 'not_allowlisted' });
    expect(html).toContain('call-row--muted');
    expect(html).toContain('not_allowlisted');
  });

  it('offers the transcript only when there is one', () => {
    expect(markup({ hasTranscript: true })).toContain('Transcript');
    expect(markup({ hasTranscript: false })).not.toContain('Transcript');
  });

  it('a transcript with no summary is still reachable', () => {
    const html = markup({ summaryPreview: null, hasTranscript: true });
    expect(html).toContain('Transcript');
  });

  it('renders the summary preview the list was given', () => {
    expect(markup()).toContain('Asked about the deploy window.');
  });
});
