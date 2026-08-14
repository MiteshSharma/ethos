import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Composer } from '../Composer';

// What the composer row offers WHILE a talk-mode call is up.
//
// `renderToStaticMarkup` needs no DOM, so this stays a plain `.test.ts` — same
// precedent as `features/voice/__tests__/call-strip.test.ts`. It sees markup
// only: the mic-release effect in `VoiceButton` runs in the browser and is not
// exercised here.

/** The opening tag of the first element carrying `className`. */
function tagWithClass(html: string, className: string): string {
  const found = new RegExp(`<button[^>]*class="[^"]*${className}[^"]*"[^>]*>`).exec(html);
  expect(found, `missing button: ${className}`).not.toBeNull();
  return found?.[0] ?? '';
}

function composer(talkModeActive: boolean): string {
  // `voice_stt` decides whether the push-to-talk button exists at all; seeding
  // the cache is how it is true without a server.
  const queryClient = new QueryClient();
  queryClient.setQueryData(['meta', 'capabilities'], { capabilities: { voice_stt: true } });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(Composer, {
        personalityId: 'ethos',
        onSend: () => {},
        onTalkMode: () => {},
        talkModeActive,
        talkModeHint: talkModeActive ? 'End call' : 'Talk to Ethos',
      }),
    ),
  );
}

describe('Composer during a talk-mode call', () => {
  it('leaves the talk glyph operable so the pressed control can be unpressed', () => {
    const talk = tagWithClass(composer(true), 'composer-talk-btn');
    expect(talk).toContain('aria-pressed="true"');
    expect(talk).not.toContain('disabled');
    expect(talk).toContain('aria-label="End call"');
  });

  it('stands the push-to-talk mic down, and says why', () => {
    const mic = tagWithClass(composer(true), 'composer-voice-btn');
    expect(mic).toContain('disabled');
    expect(mic).toContain('aria-label="Mic in use by the call"');
  });

  it('leaves the push-to-talk mic usable when no call is up', () => {
    const mic = tagWithClass(composer(false), 'composer-voice-btn');
    expect(mic).not.toContain('disabled');
    expect(mic).toContain('aria-label="Hold to record voice"');
  });
});
