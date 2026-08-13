// SP-B3 — long-answer snippet fallback.
//
// Past `longReplyThresholdChars` a reply stops being a 4+ message wall and
// becomes a lead message plus the complete text uploaded as `answer.md`. The
// tests below drive a fully mocked Slack client — no network, no Bolt socket.

import { describe, expect, it, vi } from 'vitest';
import { SlackAdapter, type SlackAdapterConfig } from '../adapter';

/** Real Bolt App constructed but never started; the client is a spy. Same
 *  harness shape as `outbound-media.test.ts`. */
function makeAdapter(config: Partial<SlackAdapterConfig> = {}) {
  const adapter = new SlackAdapter({
    botToken: 'xoxb-fake',
    appToken: 'xapp-fake',
    signingSecret: 'sig-fake',
    botKey: 'test-bot',
    ...config,
  });

  const posts: Array<Record<string, unknown>> = [];
  const updates: Array<Record<string, unknown>> = [];
  const deletes: Array<Record<string, unknown>> = [];
  const uploads: Array<Record<string, unknown>> = [];
  let seq = 0;

  const postMessage = vi.fn(async (args: Record<string, unknown>) => {
    posts.push(args);
    seq += 1;
    return { ts: `170000000.000${seq}` };
  });
  const update = vi.fn(async (args: Record<string, unknown>) => {
    updates.push(args);
    return { ok: true };
  });
  const del = vi.fn(async (args: Record<string, unknown>) => {
    deletes.push(args);
    return { ok: true };
  });
  const uploadV2 = vi.fn(async (args: Record<string, unknown>) => {
    uploads.push(args);
    return { files: [{ ts: '170000000.9999' }] };
  });

  (adapter as unknown as { client: unknown }).client = {
    chat: { postMessage, update, delete: del },
    files: { uploadV2 },
    reactions: { add: vi.fn(), remove: vi.fn() },
  } as never;

  return { adapter, posts, updates, deletes, uploads, uploadV2, postMessage };
}

/** Rejecting upload — the `missing_scope` / transient-failure shape. */
function failUploads(adapter: SlackAdapter, error = 'missing_scope'): void {
  const client = (adapter as unknown as { client: { files: { uploadV2: unknown } } }).client;
  client.files.uploadV2 = vi.fn(async () => {
    throw new Error(error);
  });
}

const SUFFIX = '\n\n*full answer attached*';
/** 9001 chars — one over the 9000 default, so exactly four chunks today. */
const LONG = 'x'.repeat(9001);
/** 9000 chars — exactly at the threshold, so still a plain chunked send. */
const AT_THRESHOLD = 'x'.repeat(9000);

describe('SlackAdapter long-answer fallback — non-streaming send', () => {
  it('posts a lead ending in "*full answer attached*" plus an answer.md upload', async () => {
    const { adapter, posts, uploads } = makeAdapter();

    const res = await adapter.send('C1', { text: LONG });

    expect(res).toEqual({ ok: true, messageId: '170000000.0001' });
    // One message, not four.
    expect(posts).toHaveLength(1);
    const lead = posts[0]?.text as string;
    expect(lead.endsWith(SUFFIX)).toBe(true);
    expect(lead.length).toBeLessThanOrEqual(adapter.maxMessageLength);
    expect(lead.slice(0, -SUFFIX.length)).toBe(LONG.slice(0, lead.length - SUFFIX.length));

    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({
      channel_id: 'C1',
      filename: 'answer.md',
      // Threads under the lead so the file lands with the message it belongs to.
      thread_ts: '170000000.0001',
    });
    // `initial_comment` unset — the lead already carries the opening text.
    expect(uploads[0]).not.toHaveProperty('initial_comment');
    expect(Buffer.isBuffer(uploads[0]?.file)).toBe(true);
    expect(String(uploads[0]?.file)).toBe(LONG);
  });

  it('uploads into the reply thread when the turn is threaded', async () => {
    const { adapter, posts, uploads } = makeAdapter();

    await adapter.send('C1', { text: LONG, threadId: '169999999.0001' });

    expect(posts[0]).toMatchObject({ thread_ts: '169999999.0001' });
    expect(uploads[0]).toMatchObject({ thread_ts: '169999999.0001' });
  });

  it('sends the ordinary chunk wall at exactly the threshold', async () => {
    const { adapter, posts, uploads } = makeAdapter();

    const res = await adapter.send('C1', { text: AT_THRESHOLD });

    expect(res.ok).toBe(true);
    expect(posts).toHaveLength(3);
    expect(uploads).toHaveLength(0);
    expect(posts.map((p) => p.text).join('')).toBe(AT_THRESHOLD);
  });

  it('honours a custom threshold', async () => {
    const { adapter, posts, uploads } = makeAdapter({ longReplyThresholdChars: 100 });

    await adapter.send('C1', { text: 'y'.repeat(101) });

    expect(posts).toHaveLength(1);
    expect(uploads).toHaveLength(1);
  });

  it('is disabled by longReplyThresholdChars: 0', async () => {
    const { adapter, posts, uploads } = makeAdapter({ longReplyThresholdChars: 0 });

    const res = await adapter.send('C1', { text: LONG });

    expect(res.ok).toBe(true);
    expect(posts).toHaveLength(4);
    expect(uploads).toHaveLength(0);
    expect(posts.map((p) => p.text).join('')).toBe(LONG);
  });

  it('expands the lead back into the chunk wall when the upload fails', async () => {
    const { adapter, posts, updates } = makeAdapter();
    failUploads(adapter);

    const res = await adapter.send('C1', { text: LONG });

    expect(res).toEqual({ ok: true, messageId: '170000000.0001' });
    // The lead promised an attachment...
    expect(posts[0]?.text as string).toContain('*full answer attached*');
    // ...so it is edited into the first real chunk and the rest are appended.
    expect(updates).toEqual([{ channel: 'C1', ts: '170000000.0001', text: LONG.slice(0, 3000) }]);
    expect(posts).toHaveLength(4);
    // Every character of the answer is on screen — no broken promise left.
    expect([updates[0]?.text, ...posts.slice(1).map((p) => p.text)].join('')).toBe(LONG);
  });
});

describe('SlackAdapter long-answer fallback — streaming terminal edit', () => {
  /** Seed the chunk ledger the way a streaming draft does: an ordinary send
   *  whose ids `editMessage` later re-flows. */
  async function seedDraft(adapter: SlackAdapter): Promise<string> {
    const res = await adapter.send('C1', { text: 'z'.repeat(8000) });
    return res.messageId ?? '';
  }

  it('collapses the posted chunks to one lead + answer.md on the terminal edit', async () => {
    const { adapter, posts, updates, deletes, uploads } = makeAdapter();
    const draftId = await seedDraft(adapter);
    expect(posts).toHaveLength(3);

    const res = await adapter.editMessage('C1', draftId, LONG, { final: true });

    expect(res).toEqual({ ok: true, messageId: draftId });
    // Upload happens once, threaded under the surviving lead message.
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ filename: 'answer.md', thread_ts: draftId });
    // Chunk 1 becomes the lead; chunks 2 and 3 are deleted (reflowChunks).
    expect(updates).toHaveLength(1);
    const collapsedLead = String(updates[0]?.text);
    expect(collapsedLead.endsWith(SUFFIX)).toBe(true);
    expect(collapsedLead.length).toBeLessThanOrEqual(adapter.maxMessageLength);
    expect(deletes.map((d) => d.ts)).toEqual(['170000000.0002', '170000000.0003']);
    // No new messages posted by the collapse.
    expect(posts).toHaveLength(3);
  });

  it('leaves the wall intact on an intermediate edit — no upload per flush', async () => {
    const { adapter, updates, deletes, uploads } = makeAdapter();
    const draftId = await seedDraft(adapter);

    const res = await adapter.editMessage('C1', draftId, LONG);

    expect(res.ok).toBe(true);
    expect(uploads).toHaveLength(0);
    // Four chunks over three existing ids → 3 edits + 1 append, nothing deleted.
    expect(updates).toHaveLength(3);
    expect(deletes).toHaveLength(0);
  });

  it('keeps the chunk wall when the terminal upload fails', async () => {
    const { adapter, updates, deletes } = makeAdapter();
    const draftId = await seedDraft(adapter);
    failUploads(adapter);

    const res = await adapter.editMessage('C1', draftId, LONG, { final: true });

    expect(res.ok).toBe(true);
    // Same reflow as today: no collapse, and no message deleted that we could
    // not replace with an attachment.
    expect(updates).toHaveLength(3);
    expect(deletes).toHaveLength(0);
    expect(updates.map((u) => u.text).join('')).toBe(LONG.slice(0, 9000));
  });

  it('does not collapse a terminal edit below the threshold', async () => {
    const { adapter, uploads, updates } = makeAdapter();
    const draftId = await seedDraft(adapter);

    await adapter.editMessage('C1', draftId, AT_THRESHOLD, { final: true });

    expect(uploads).toHaveLength(0);
    expect(updates).toHaveLength(3);
  });
});
