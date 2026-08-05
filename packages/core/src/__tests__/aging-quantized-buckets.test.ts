// Lane 1(d) — quantized truncation buckets (the #111085 guard). Soft-trim
// lengths come from FIXED buckets selected by a result's age rank within the
// FROZEN soft set — never from live budget arithmetic — so the same aged tool
// result serializes to identical bytes on every turn no matter what else is
// in the window. Aging deliberately takes NO live-budget input; the varying
// element across turns is the growing message tail, which must not change the
// aged prefix by a single byte.

import type { Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  advanceAgingState,
  applyAgingToView,
  bucketKeepChars,
  DEFAULT_AGING_STATE,
  extractSpillPath,
  SOFT_TRIM_BUCKETS_CHARS,
  softKeepMap,
} from '../agent-loop/tool-result-aging';

/** The inline notice `spillOversizedOutput` leaves in an oversized result. */
function spillNotice(path: string): string {
  return `\n\n[truncated — 120000 chars total; full output written to ${path} — use read_file to see the rest]\n\n`;
}

function toolTurn(id: string, result: string): Message[] {
  return [
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'bash', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result }] },
  ];
}

function conversation(n: number, body: (i: number) => string): Message[] {
  const out: Message[] = [{ role: 'user', content: 'start' }];
  for (let i = 0; i < n; i++) out.push(...toolTurn(`t${i}`, body(i)));
  return out;
}

function resultOf(messages: Message[], id: string): string {
  const block = messages
    .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
    .find((b) => b.type === 'tool_result' && b.tool_use_id === id);
  if (block?.type !== 'tool_result') throw new Error(`tool_result ${id} missing`);
  return block.content;
}

/** 12 tool turns of 20k chars each → 9 soft candidates (3 recent kept). */
const bigConversation = () => conversation(12, (i) => `r${i}-`.repeat(5_000));

describe('bucket selection', () => {
  it('lengths come ONLY from the fixed buckets, never from arithmetic', () => {
    for (let total = 1; total <= 9; total++) {
      for (let rank = 0; rank < total; rank++) {
        expect(SOFT_TRIM_BUCKETS_CHARS).toContain(bucketKeepChars(rank, total));
      }
    }
  });

  it("oldest results get the smallest bucket; the top bucket is today's flat total", () => {
    expect(bucketKeepChars(0, 9)).toBe(512);
    expect(bucketKeepChars(4, 9)).toBe(2_048);
    expect(bucketKeepChars(8, 9)).toBe(3_000);
  });

  it('softKeepMap freezes per-side keeps from the frozen soft-set order', () => {
    const { state } = advanceAgingState(DEFAULT_AGING_STATE, bigConversation(), 0.35);
    expect(state.soft).toHaveLength(9);
    const keeps = softKeepMap(state);
    expect(keeps.get('t0')).toBe(256);
    expect(keeps.get('t4')).toBe(1_024);
    expect(keeps.get('t8')).toBe(1_500);
  });
});

describe('#111085 — byte-identical serialization across turns', () => {
  it('the same aged result serializes identically across three consecutive turns', () => {
    const base = bigConversation();
    const { state, changed } = advanceAgingState(DEFAULT_AGING_STATE, base, 0.35);
    expect(changed).toBe(true);

    // Turn 1: aged view over the crossing-time messages.
    const turn1 = applyAgingToView(base, state).messages;

    // Turn 2: the tail grew (new tool turns) and pressure moved (0.42 — no
    // crossing, so the state is reused verbatim). The live window contents
    // differ; the aged prefix must not.
    const grown2 = [...base, ...toolTurn('t12', 'later-1')];
    const advance2 = advanceAgingState(state, grown2, 0.42);
    expect(advance2.changed).toBe(false);
    const turn2 = applyAgingToView(grown2, advance2.state).messages;

    // Turn 3: more growth, pressure 0.47 — still below the hard crossing.
    const grown3 = [...grown2, ...toolTurn('t13', 'later-2')];
    const advance3 = advanceAgingState(advance2.state, grown3, 0.47);
    expect(advance3.changed).toBe(false);
    const turn3 = applyAgingToView(grown3, advance3.state).messages;

    for (const id of ['t0', 't4', 't8']) {
      const bytes1 = resultOf(turn1, id);
      expect(resultOf(turn2, id)).toBe(bytes1);
      expect(resultOf(turn3, id)).toBe(bytes1);
    }
  });

  it('aged inline sizes are quantized by age: oldest < middle < newest', () => {
    const base = bigConversation();
    const { state } = advanceAgingState(DEFAULT_AGING_STATE, base, 0.35);
    const aged = applyAgingToView(base, state).messages;
    const len = (id: string) => resultOf(aged, id).length;
    // Each aged result is head + tail (the bucket) plus the ~30-char marker.
    expect(len('t0')).toBeLessThan(512 + 100);
    expect(len('t4')).toBeLessThan(2_048 + 100);
    expect(len('t8')).toBeLessThan(3_000 + 100);
    expect(len('t0')).toBeLessThan(len('t4'));
    expect(len('t4')).toBeLessThan(len('t8'));
  });
});

describe('spill-pointer contract through bucketed trims', () => {
  it('preserves the pointer when the smallest bucket drops the notice', () => {
    const SPILL = '/work/.ethos/terminal-spill/cli_x-1712-ab12cd.log';
    // Notice sits mid-body — outside the 256-char head and tail of the
    // smallest bucket, so the rewrite must re-attach it.
    const body = `${'a'.repeat(5_000)}${spillNotice(SPILL)}${'b'.repeat(5_000)}`;
    const messages = conversation(12, (i) => (i === 0 ? body : `plain-${i}`.repeat(1_000)));
    const { state } = advanceAgingState(DEFAULT_AGING_STATE, messages, 0.35);
    expect(softKeepMap(state).get('t0')).toBe(256);
    const aged = applyAgingToView(messages, state).messages;
    const content = resultOf(aged, 't0');
    expect(content).toContain('chars trimmed');
    expect(extractSpillPath(content)).toBe(SPILL);
    // Exactly one pointer — never duplicated.
    expect(content.split('full output written to')).toHaveLength(2);
  });
});
