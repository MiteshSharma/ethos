// T4 — the bot-wall detector. A wall answers with a real page, so Playwright
// reports a successful navigation and the accessibility snapshot is an
// interstitial. Revert `detectBlock` to `return null` and every "fires" case
// below fails.

import { describe, expect, it } from 'vitest';
import { describeBlock, detectBlock } from '../block-detector';

describe('detectBlock — vendor markers', () => {
  it('names Cloudflare from the challenge title', () => {
    const signal = detectBlock({ status: 200, title: 'Just a moment...' });
    expect(signal?.vendor).toBe('Cloudflare');
  });

  it('names Cloudflare from the cf-mitigated header', () => {
    expect(detectBlock({ status: 200, headers: { 'cf-mitigated': 'challenge' } })?.vendor).toBe(
      'Cloudflare',
    );
  });

  it('names DataDome from its captcha host in the page text', () => {
    const signal = detectBlock({
      status: 200,
      text: 'window.location = "https://geo.captcha-delivery.com/captcha/"',
    });
    expect(signal?.vendor).toBe('DataDome');
  });

  it('names PerimeterX from its human-verification copy', () => {
    expect(detectBlock({ status: 200, text: 'Please verify you are a human' })?.vendor).toBe(
      'PerimeterX',
    );
  });

  it('names Akamai from its deny-page reference block', () => {
    expect(detectBlock({ status: 403, text: 'Reference #18.9f1a2b3c' })?.vendor).toBe('Akamai');
  });
});

describe('detectBlock — statuses alone', () => {
  for (const status of [403, 429, 503]) {
    it(`fires on HTTP ${status} with no vendor signature`, () => {
      const signal = detectBlock({ status, title: 'Error', text: 'Request rejected' });
      expect(signal).not.toBeNull();
      expect(signal?.status).toBe(status);
      expect(signal?.vendor).toBeUndefined();
    });
  }
});

describe('detectBlock — ordinary pages', () => {
  it('does not fire on a normal 200 page', () => {
    expect(
      detectBlock({
        status: 200,
        headers: { server: 'nginx', 'content-type': 'text/html' },
        title: 'Release notes',
        text: 'We shipped a moment ago. Access to the archive is open.',
      }),
    ).toBeNull();
  });

  // A large fraction of the web is fronted by Cloudflare and Akamai and serves
  // fine. Firing on the CDN's own Server header would wall the whole internet.
  it('does not fire on a page merely SERVED by Cloudflare or Akamai', () => {
    expect(
      detectBlock({ status: 200, headers: { server: 'cloudflare' }, title: 'Docs' }),
    ).toBeNull();
    expect(
      detectBlock({ status: 200, headers: { server: 'AkamaiGHost' }, title: 'Docs' }),
    ).toBeNull();
  });

  it('does not fire on 404 or 500 — those are not bot walls', () => {
    expect(detectBlock({ status: 404, title: 'Not Found' })).toBeNull();
    expect(detectBlock({ status: 500, title: 'Server Error' })).toBeNull();
  });
});

describe('describeBlock', () => {
  // The escalation tool is now the CALLER's to name — it is the only one that
  // knows which tools this process registered. `browser_stealth_session` is
  // gated behind a spike that has not run, so naming it here told the model to
  // call something that does not exist.
  it('names the vendor, says nothing was read, and points at the tool it was given', () => {
    const signal = detectBlock({ status: 403, title: 'Just a moment...' });
    expect(signal).not.toBeNull();
    if (!signal) return;
    const text = describeBlock('https://example.com/a', signal, 'browser_request_takeover');
    expect(text).toContain('Cloudflare');
    expect(text).toContain('HTTP 403');
    expect(text).toContain('https://example.com/a');
    expect(text).toContain('browser_request_takeover');
    expect(text).toContain('no retry was attempted');
  });

  it('names NO tool when the caller has none — and still gives a next step', () => {
    const signal = detectBlock({ status: 403, title: 'Just a moment...' });
    expect(signal).not.toBeNull();
    if (!signal) return;
    const text = describeBlock('https://example.com/a', signal);
    expect(text).not.toMatch(/browser_[a-z_]+/);
    expect(text).not.toContain('Escalate with');
    expect(text).toContain('ask them to fetch it');
  });

  it('reports an unnamed wall when only the status matched', () => {
    const signal = detectBlock({ status: 429 });
    expect(signal).not.toBeNull();
    if (!signal) return;
    expect(describeBlock('https://example.com/', signal)).toContain('a bot wall');
  });
});
