import { describe, expect, it } from 'vitest';
import { redactSecretValue } from '../secrets';

// Boundary lengths matter more than the happy path here: the whole point of the
// mask is that a SHORT value must not reveal proportionally more of itself than
// a long one. The mask deliberately diverges from `ConfigService.redactKey` —
// one end only, never both, and only above 16 characters — because it is
// applied to the WHOLE vault, not just long high-entropy provider keys.
describe('redactSecretValue', () => {
  it('reports absence for empty / null / undefined', () => {
    expect(redactSecretValue('')).toBe('<unset>');
    expect(redactSecretValue(null)).toBe('<unset>');
    expect(redactSecretValue(undefined)).toBe('<unset>');
  });

  it('reveals nothing at all below 16 characters', () => {
    expect(redactSecretValue('a')).toBe('<set>');
    expect(redactSecretValue('123456')).toBe('<set>');
    expect(redactSecretValue('0123456789')).toBe('<set>');
    // One short of the threshold is still nothing.
    expect(redactSecretValue('abcdefghijklmno')).toBe('<set>');
  });

  it('reveals the last 4 and nothing else from 16 characters up', () => {
    expect(redactSecretValue('abcdefghijklmnop')).toBe('…mnop');
    expect(redactSecretValue('sk-ant-0123456789abcdef')).toBe('…cdef');
    // 40 characters — a typical long provider key.
    expect(redactSecretValue(`sk-${'a'.repeat(33)}wxyz`)).toBe('…wxyz');
  });

  it('never reveals a prefix, at any length', () => {
    for (const v of ['123456', '0123456789', 'sk-ant-0123456789abcdef', `${'q'.repeat(60)}wxyz`]) {
      const masked = redactSecretValue(v);
      expect(masked.startsWith('…') || masked === '<set>').toBe(true);
      expect(masked).not.toContain(v.slice(0, 3));
    }
  });

  it('never returns the whole value, and never more than 4 of its characters', () => {
    for (const v of ['a', '123456', '0123456789', 'abcdefghijklmnop', 'x'.repeat(64)]) {
      const masked = redactSecretValue(v);
      expect(masked).not.toBe(v);
      const revealed = masked.startsWith('…') ? masked.slice(1) : '';
      expect(revealed.length).toBeLessThanOrEqual(4);
    }
  });
});
