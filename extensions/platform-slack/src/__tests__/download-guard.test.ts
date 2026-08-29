import { describe, expect, it } from 'vitest';
import { isSlackDownloadUrl } from '../adapter';
import { BackfillStateStore } from '../store/backfill-state';
import { ChannelOverrideStore } from '../store/channel-overrides';
import { ThreadStateStore } from '../store/thread-state';

// CHS-006 — `url_private_download` arrives on an event payload and the download
// carries the workspace bot token in an Authorization header, so the host is
// confined and redirects are refused at the call site.

describe('isSlackDownloadUrl', () => {
  it('accepts Slack hosts', () => {
    expect(isSlackDownloadUrl('https://files.slack.com/photo.png')).toBe(true);
    expect(isSlackDownloadUrl('https://slack.com/x')).toBe(true);
    expect(isSlackDownloadUrl('https://FILES.SLACK.COM/photo.png')).toBe(true);
  });

  it('rejects lookalike hosts', () => {
    // The suffix match is on a leading dot, so these are not Slack.
    expect(isSlackDownloadUrl('https://slack.com.evil.test/x')).toBe(false);
    expect(isSlackDownloadUrl('https://notslack.com/x')).toBe(false);
    expect(isSlackDownloadUrl('https://evilslack.com/x')).toBe(false);
  });

  it('rejects non-https and unparseable URLs', () => {
    expect(isSlackDownloadUrl('http://files.slack.com/x')).toBe(false);
    expect(isSlackDownloadUrl('file:///etc/passwd')).toBe(false);
    expect(isSlackDownloadUrl('not a url')).toBe(false);
    expect(isSlackDownloadUrl('')).toBe(false);
  });
});

// CHS-008 — `safeParse` guards the SCHEMA, not the parse. One truncated line
// used to throw out of load() and permanently block adapter startup.

function storageWith(contents: string) {
  return {
    read: async () => contents,
    write: async () => {},
    append: async () => {},
  } as never;
}

const TRUNCATED = '{"channel":"C1","threadTs":"1.0","firstPostedAt":1}\n{"channel":"C2","thre';

describe('JSONL stores survive a truncated line', () => {
  it('ThreadStateStore loads the intact records', async () => {
    const store = new ThreadStateStore(storageWith(TRUNCATED), '/slack', 'bot-a');
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.hasBotPosted('C1', '1.0')).toBe(true);
  });

  it('BackfillStateStore loads the intact records', async () => {
    const store = new BackfillStateStore(storageWith(TRUNCATED), '/slack', 'bot-a');
    await expect(store.load()).resolves.toBeUndefined();
  });

  it('ChannelOverrideStore loads the intact records', async () => {
    const store = new ChannelOverrideStore(
      storageWith('{"channel":"C1","mode":"all"}\n{"channel":"C2","mo'),
      '/slack',
      'bot-a',
    );
    await expect(store.load()).resolves.toBeUndefined();
  });
});
