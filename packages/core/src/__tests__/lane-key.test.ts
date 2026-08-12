import { describe, expect, it } from 'vitest';
import { buildLaneKey, voiceLaneKey } from '../lane-key';

describe('buildLaneKey', () => {
  it('URL-encodes every segment so a separator cannot alias two keys', () => {
    // The pair that would collide under naive interpolation: `a:b` + `c` and
    // `a` + `b:c` both flatten to "a:b:c".
    expect(buildLaneKey('telegram', 'a:b', 'c')).not.toBe(buildLaneKey('telegram', 'a', 'b:c'));
  });

  it('leaves URL-safe segments untouched — existing session keys keep their shape', () => {
    expect(buildLaneKey('telegram', 'abc123', '-1001234')).toBe('telegram:abc123:-1001234');
  });
});

describe('voiceLaneKey', () => {
  it('separates a browser talk session from a phone leg with the SAME id', () => {
    // This is the whole argument. On a single-operator deployment the trailing
    // id is not what keeps the two apart — it can be identical, and here it is.
    // The kind segment is, and a browser cannot emit `sip`.
    const browser = voiceLaneKey('web', { kind: 'browser', id: '+15551234567' });
    const phone = voiceLaneKey('web', { kind: 'sip', id: '+15551234567' });

    expect(browser).not.toBe(phone);
    expect(browser).toBe('voice:web:browser:%2B15551234567');
    expect(phone).toBe('voice:web:sip:%2B15551234567');
  });

  it('separates two bots with the same client', () => {
    expect(voiceLaneKey('bot-a', { kind: 'browser', id: 'c1' })).not.toBe(
      voiceLaneKey('bot-b', { kind: 'browser', id: 'c1' }),
    );
  });

  it('cannot be forged into another kind by an id carrying a separator', () => {
    const forged = voiceLaneKey('web', { kind: 'browser', id: 'x:sip:+15551234567' });
    expect(forged).not.toBe(voiceLaneKey('web', { kind: 'browser', id: 'x' }));
    expect(forged).not.toContain(':sip:');
  });

  it('never collides with a typed web chat session key', () => {
    // Typed chat rows are keyed `web:<uuid>`; a talk session is `voice:…`. The
    // prefix alone makes the two namespaces disjoint, which is what stops a
    // consult and a typed send appending to one history.
    expect(voiceLaneKey('web', { kind: 'browser', id: 'abc' }).startsWith('voice:')).toBe(true);
  });
});
