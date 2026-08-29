import { describe, expect, it } from 'vitest';
import { playbackRequest } from '../PlayButton';

// Click-to-hear on an assistant bubble used the DEPLOYMENT's voice: the button
// called `voice.synthesize` with the text alone, so the server had no
// personality to resolve `voice.tts_voice` against and fell back to the global
// default. The RPC fires from a click handler and this suite has no DOM, so the
// request shape is what the omission is asserted on.

describe('PlayButton request', () => {
  it('names the speaking personality, so the reply is heard in its own voice', () => {
    expect(playbackRequest('Hello there.', 'ada')).toEqual({
      text: 'Hello there.',
      personalityId: 'ada',
    });
  });

  it('omits the key entirely when no personality is in play', () => {
    // Not `personalityId: undefined` — the field is optional on the contract,
    // and sending the key with nothing in it is a different request.
    expect(playbackRequest('Hello there.')).toEqual({ text: 'Hello there.' });
    expect('personalityId' in playbackRequest('Hello there.')).toBe(false);
  });

  it('sends only the id — the voice itself is resolved server-side', () => {
    // The browser never picks the provider or the voice here. That resolution
    // (and the local-only egress gate it passes through) stays on the server,
    // which is why a click cannot reach a hosted provider a private deployment
    // has refused.
    expect(Object.keys(playbackRequest('Hi.', 'ada')).sort()).toEqual(['personalityId', 'text']);
  });
});
