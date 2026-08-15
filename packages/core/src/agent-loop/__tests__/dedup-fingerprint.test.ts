// `dedupHistory` fingerprints a tool_result as `toolName \x00 argsHash \x00 content`.
//
// The NUL separators are load-bearing: without them the three fields are just
// concatenated, and two results that differ only in WHERE the boundary falls
// hash identically. Collapsing those would replace a real result with a
// backward pointer at an unrelated message — silent context corruption.
//
// The pair below is the minimal adversarial case: `12` + `Y` and `1` + `2Y`
// both concatenate to `12Y`.

import type { StoredMessage } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { dedupHistory } from '../history';

function toolExchange(n: number, input: unknown, content: string): StoredMessage[] {
  const id = `toolu_${n}`;
  return [
    {
      id: `a${n}`,
      sessionId: 's',
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'fetch', input }],
      timestamp: new Date(0),
    },
    {
      id: `t${n}`,
      sessionId: 's',
      role: 'tool_result',
      content,
      toolCallId: id,
      toolName: 'fetch',
      timestamp: new Date(0),
    },
  ];
}

describe('dedupHistory — fingerprint field separator', () => {
  it('does not collapse two results whose fields concatenate to the same string', () => {
    // args `12` + content `Y`   vs   args `1` + content `2Y`  →  both "fetch12Y"
    // once the separators are gone.
    const history = [...toolExchange(0, 12, 'Y'), ...toolExchange(1, 1, '2Y')];

    const out = dedupHistory(history);

    expect(out.find((m) => m.id === 't0')?.content).toBe('Y');
    expect(out.find((m) => m.id === 't1')?.content).toBe('2Y');
  });

  it('still collapses a genuine duplicate — same tool, same args, same output', () => {
    const history = [...toolExchange(0, 12, 'Y'), ...toolExchange(1, 12, 'Y')];

    const out = dedupHistory(history);

    expect(out.find((m) => m.id === 't0')?.content).toBe('Y');
    expect(out.find((m) => m.id === 't1')?.content).toContain('deduped — identical to earlier');
  });
});
