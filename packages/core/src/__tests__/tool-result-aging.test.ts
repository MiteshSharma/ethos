// Phase 1a tool-result aging — first coverage. The behaviour under test is the
// assembled-view rewrite: WHEN the aged set is recomputed (only at a threshold
// crossing, so the prompt cache survives between them), and WHAT a hard-clear
// leaves behind — specifically the Item 7 fix that a hard-cleared result keeps
// its spill-file path, which outlives the clear by the spill TTL.

import type { Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  advanceAgingState,
  applyAgingToView,
  DEFAULT_AGING_STATE,
  extractSpillPath,
  levelForRatio,
  softTrimContent,
} from '../agent-loop/tool-result-aging';

/** The inline notice `spillOversizedOutput` leaves in an oversized result. */
function spillNotice(path: string, total = 120_000): string {
  return `\n\n[truncated — ${total} chars total; full output written to ${path} — use read_file to see the rest]\n\n`;
}

/** A tool_use assistant turn + the matching tool_result user turn. */
function toolTurn(id: string, result: string): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] },
  ];
}

/** `n` tool turns; result `i` is `body(i)`. */
function conversation(n: number, body: (i: number) => string): Message[] {
  const out: Message[] = [{ role: 'user', content: 'start' }];
  for (let i = 0; i < n; i++) out.push(...toolTurn(`t${i}`, body(i)));
  return out;
}

describe('aging thresholds', () => {
  it('maps ratios to levels', () => {
    expect(levelForRatio(0.1)).toBe('none');
    expect(levelForRatio(0.3)).toBe('soft');
    expect(levelForRatio(0.49)).toBe('soft');
    expect(levelForRatio(0.5)).toBe('hard');
  });

  it('recomputes the aged set ONLY at a crossing, and never downgrades', () => {
    const messages = conversation(5, (i) => `result-${i}`);
    const soft = advanceAgingState(DEFAULT_AGING_STATE, messages, 0.35);
    expect(soft.changed).toBe(true);
    expect(soft.state.level).toBe('soft');
    // The two oldest of five tool turns are aged (three most recent are kept).
    expect(soft.state.soft).toEqual(['t0', 't1']);

    // Same level → same object, no recompute (this is what keeps the cache warm).
    const same = advanceAgingState(soft.state, messages, 0.45);
    expect(same.changed).toBe(false);
    expect(same.state).toBe(soft.state);

    const hard = advanceAgingState(soft.state, messages, 0.6);
    expect(hard.changed).toBe(true);
    expect(hard.state).toEqual({ level: 'hard', soft: [], hard: ['t0', 't1'] });

    // Pressure falling back does NOT downgrade.
    expect(advanceAgingState(hard.state, messages, 0.1).state.level).toBe('hard');
  });

  it('soft-trims only when trimming actually saves space', () => {
    expect(softTrimContent('short', 1_000)).toBe('short');
    const trimmed = softTrimContent(`${'a'.repeat(100)}${'b'.repeat(5_000)}`, 50);
    expect(trimmed.length).toBeLessThan(5_100);
    expect(trimmed).toContain('chars trimmed');
  });
});

describe('Item 7 — hard-clear preserves a spill-file path', () => {
  const SPILL = '/work/.ethos/terminal-spill/cli_x-1712-ab12cd.log';

  function hardClearedContent(result: string): string {
    const messages = conversation(4, (i) => (i === 0 ? result : `plain-${i}`));
    const { state } = advanceAgingState(DEFAULT_AGING_STATE, messages, 0.9);
    expect(state.hard).toContain('t0');
    const aged = applyAgingToView(messages, state);
    const block = aged.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .find((b) => b.type === 'tool_result' && b.tool_use_id === 't0');
    if (block?.type !== 'tool_result') throw new Error('tool_result t0 missing');
    return block.content;
  }

  it('carries the path through the clear so the spill file is still reachable', () => {
    const content = hardClearedContent(`head${spillNotice(SPILL)}tail`);
    expect(content).toContain('cleared to reclaim context');
    expect(content).toContain(SPILL);
    // The bulk is gone — only the placeholder + pointer remain.
    expect(content).not.toContain('head');
    expect(content.length).toBeLessThan(200);
  });

  it('handles a spill path containing spaces', () => {
    const spaced = '/Users/a b/My Project/.ethos/terminal-spill/s-1.log';
    expect(hardClearedContent(`x${spillNotice(spaced)}y`)).toContain(spaced);
  });

  it('leaves a result with no spill path as the bare placeholder', () => {
    const content = hardClearedContent('just a large blob of output');
    expect(content).toBe(
      '[tool result cleared to reclaim context — re-run the tool if you need it again]',
    );
  });

  it('is idempotent — re-clearing a cleared result keeps the path', () => {
    const once = hardClearedContent(`head${spillNotice(SPILL)}tail`);
    expect(extractSpillPath(once)).toBe(SPILL);
  });

  it('extractSpillPath returns null when there is no notice', () => {
    expect(extractSpillPath('ordinary tool output')).toBeNull();
  });
});

describe('applyAgingToView', () => {
  it('is a no-op with an empty state and never touches non-tool_result content', () => {
    const messages = conversation(4, (i) => `body-${i}`);
    expect(applyAgingToView(messages, DEFAULT_AGING_STATE).messages).toBe(messages);

    const { state } = advanceAgingState(DEFAULT_AGING_STATE, messages, 0.9);
    const aged = applyAgingToView(messages, state);
    // Recent results survive verbatim; the cache breakpoint marks the last aged.
    expect(JSON.stringify(aged.messages)).toContain('body-3');
    expect(JSON.stringify(aged.messages)).not.toContain('body-0');
    expect(aged.cacheBreakpoint).toBe(2);
    expect(aged.messages[0]).toBe(messages[0]);
  });
});
