import { describe, expect, it } from 'vitest';
import {
  encodeBrowserTakeoverFrame,
  MAX_TAKEOVER_CLIENT_FRAME_BYTES,
  MAX_TAKEOVER_ID_CHARS,
} from '../browser-takeover-socket';

// `MAX_TAKEOVER_CLIENT_FRAME_BYTES` is DERIVED from the client schemas in that
// file, and this is what keeps the derivation honest: every client frame,
// filled to the largest value its schema admits and encoded through the real
// codec, has to fit under the bound the server hands `ws` as `maxPayload`. A
// widened field fails here, not on a live socket.

/** The most expensive character `JSON.stringify` can emit: one UTF-16 code
 *  unit that escapes to six ASCII bytes. */
const WORST = '\u0001';

describe('browser takeover client-frame bound', () => {
  it('fits the largest `hello` the schema admits, worst-case escaped', () => {
    const bytes = encodeBrowserTakeoverFrame({
      t: 'hello',
      sessionId: WORST.repeat(MAX_TAKEOVER_ID_CHARS),
      requestId: WORST.repeat(MAX_TAKEOVER_ID_CHARS),
    });
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_TAKEOVER_CLIENT_FRAME_BYTES);
  });

  it('fits every other client frame — `hello` is what sets the bound', () => {
    const frames = [
      encodeBrowserTakeoverFrame({
        t: 'key',
        type: 'keyDown',
        key: WORST.repeat(32),
        code: WORST.repeat(32),
        text: WORST.repeat(8),
        keyCode: 255,
        modifiers: 15,
      }),
      encodeBrowserTakeoverFrame({
        t: 'mouse',
        type: 'mouseWheel',
        x: 0.1234567890123456,
        y: 0.9876543210987654,
        button: 'middle',
        clickCount: 3,
        deltaX: -1.7976931348623157e308,
        deltaY: 1.7976931348623157e308,
        modifiers: 15,
      }),
      encodeBrowserTakeoverFrame({ t: 'ack', seq: Number.MAX_SAFE_INTEGER }),
      encodeBrowserTakeoverFrame({ t: 'handback' }),
    ];
    for (const frame of frames) {
      expect(frame.byteLength).toBeLessThan(MAX_TAKEOVER_CLIENT_FRAME_BYTES);
    }
  });
});
