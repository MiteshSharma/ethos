import { describe, expect, it, vi } from 'vitest';
import { chunkText, reflowChunks, SlackAdapter } from '../index';

describe('Slack chunkText', () => {
  it('returns single chunk within limit', () => {
    expect(chunkText('hello', 3000)).toEqual(['hello']);
  });

  it('splits at newline boundary', () => {
    const text = 'paragraph\n'.repeat(400); // ~4000 chars
    const chunks = chunkText(text, 3000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe(text);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(3000);
  });

  it('preserves all content', () => {
    const text = 'word '.repeat(1000);
    const chunks = chunkText(text, 3000);
    expect(chunks.join('')).toBe(text);
  });
});

describe('reflowChunks', () => {
  it('edits, appends, and deletes as needed', async () => {
    const edits: Array<[string, string]> = [];
    const appends: string[] = [];
    const deletes: string[] = [];
    const ops = {
      edit: async (id: string, text: string) => {
        edits.push([id, text]);
        return id;
      },
      append: async (text: string) => {
        appends.push(text);
        return `new-${appends.length}`;
      },
      deleteId: async (id: string) => {
        deletes.push(id);
      },
    };

    // Three new chunks, two existing → 2 edits + 1 append
    const ids = await reflowChunks(['x', 'y', 'z'], ['a', 'b'], ops);
    expect(ids).toEqual(['a', 'b', 'new-1']);
    expect(edits).toEqual([
      ['a', 'x'],
      ['b', 'y'],
    ]);
    expect(appends).toEqual(['z']);
    expect(deletes).toEqual([]);

    // Now shrink: one new chunk, two existing → 1 edit + 1 delete
    edits.length = 0;
    appends.length = 0;
    deletes.length = 0;
    const ids2 = await reflowChunks(['only'], ['a', 'b'], ops);
    expect(ids2).toEqual(['a']);
    expect(edits).toEqual([['a', 'only']]);
    expect(deletes).toEqual(['b']);
  });
});

// ---------------------------------------------------------------------------
// SlackAdapter — multi-bot routing identity
// ---------------------------------------------------------------------------

describe('SlackAdapter — botKey identity', () => {
  it('stores the configured botKey and surfaces it through the id', () => {
    const adapter = new SlackAdapter({
      botToken: 'xoxb-fake',
      appToken: 'xapp-fake',
      signingSecret: 'sig-fake',
      botKey: 'coder-app',
    });
    expect(adapter.botKey).toBe('coder-app');
    expect(adapter.id).toBe('slack:coder-app');
  });

  it('two adapters bound to different apps have distinct ids', () => {
    const a = new SlackAdapter({
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
      signingSecret: 's1',
      botKey: 'a',
    });
    const b = new SlackAdapter({
      botToken: 'xoxb-2',
      appToken: 'xapp-2',
      signingSecret: 's2',
      botKey: 'b',
    });
    expect(a.id).not.toBe(b.id);
    expect(a.botKey).toBe('a');
    expect(b.botKey).toBe('b');
  });

  // P5.2 — botKey is computed once in wiring and passed as a required
  // constructor param; the adapter no longer derives it from the botToken.
  it('botKey (not the botToken) drives identity — same token, distinct botKeys, distinct ids', () => {
    const a = new SlackAdapter({
      botToken: 'xoxb-shared',
      appToken: 'xapp-1',
      signingSecret: 's1',
      botKey: 'alpha',
    });
    const b = new SlackAdapter({
      botToken: 'xoxb-shared',
      appToken: 'xapp-2',
      signingSecret: 's2',
      botKey: 'beta',
    });
    expect(a.botKey).not.toBe(b.botKey);
    expect(a.id).not.toBe(b.id);
    expect(b.botKey).toBe('beta');
  });
});

// ---------------------------------------------------------------------------
// SlackAdapter — webUiBaseUrl validation
// ---------------------------------------------------------------------------

describe('SlackAdapter — webUiBaseUrl normalization', () => {
  /** Reach into the private normalized field — the adapter has no public
   *  getter, and the value is observable nowhere else without a live Bolt
   *  app. The cast is the test's only honest seam. */
  const baseUrlOf = (adapter: SlackAdapter): string | undefined =>
    (adapter as unknown as { webUiBaseUrl: string | undefined }).webUiBaseUrl;

  const make = (webUiBaseUrl?: string): SlackAdapter =>
    new SlackAdapter({
      botToken: 'xoxb-fake',
      appToken: 'xapp-fake',
      signingSecret: 'sig-fake',
      botKey: 'test-bot',
      webUiBaseUrl,
    });

  it('keeps a valid https URL', () => {
    expect(baseUrlOf(make('https://ethos.example.com'))).toBe('https://ethos.example.com');
  });

  it('keeps a valid http URL', () => {
    expect(baseUrlOf(make('http://localhost:3000'))).toBe('http://localhost:3000');
  });

  it('strips trailing slashes', () => {
    expect(baseUrlOf(make('https://ethos.example.com/'))).toBe('https://ethos.example.com');
    expect(baseUrlOf(make('https://ethos.example.com///'))).toBe('https://ethos.example.com');
  });

  it('treats a non-http(s) URL as absent', () => {
    expect(baseUrlOf(make('ftp://ethos.example.com'))).toBeUndefined();
    expect(baseUrlOf(make('javascript:alert(1)'))).toBeUndefined();
  });

  it('treats garbage as absent without throwing', () => {
    expect(baseUrlOf(make('not a url'))).toBeUndefined();
    expect(baseUrlOf(make('https://ok|broken>markup'))).toBeUndefined();
  });

  it('canonicalizes chars that would breach Slack mrkdwn link delimiters', () => {
    // A `>` in the path parses fine but would close the `<url|text>` markup
    // if interpolated raw. We return the parser-encoded `href`, so it can't.
    const normalized = baseUrlOf(make('https://ethos.example.com/app>x'));
    expect(normalized).toBe('https://ethos.example.com/app%3Ex');
    expect(normalized).not.toContain('>');
  });

  it('preserves a path-prefixed base URL', () => {
    expect(baseUrlOf(make('https://company.example.com/ethos'))).toBe(
      'https://company.example.com/ethos',
    );
  });

  it('treats an absent value as absent', () => {
    expect(baseUrlOf(make(undefined))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// SlackAdapter — receipt reactions
//
// Same UX as Telegram's `setMessageReaction` — 👀 on inbound, cleared once
// the reply lands. Slack uses named emoji (`'eyes'`) via reactions.add /
// reactions.remove. Both calls are fire-and-forget; the bot still works
// without the `reactions:write` scope.
// ---------------------------------------------------------------------------

describe('SlackAdapter — receipt reactions', () => {
  /** Build an adapter with its Slack client swapped for a spy. The real Bolt
   *  App is constructed but its socket is never opened (no `start()`), so the
   *  network never fires — only the reactions client surface is exercised. */
  const makeAdapter = (opts?: { receiptReaction?: string }) => {
    const adapter = new SlackAdapter({
      botToken: 'xoxb-fake',
      appToken: 'xapp-fake',
      signingSecret: 'sig-fake',
      botKey: 'test-bot',
      ...(opts?.receiptReaction ? { receiptReaction: opts.receiptReaction } : {}),
    });

    const calls: Array<{ op: 'add' | 'remove'; channel: string; ts: string; name: string }> = [];
    const stub = {
      add: vi.fn(async (args: { channel: string; timestamp: string; name: string }) => {
        calls.push({ op: 'add', channel: args.channel, ts: args.timestamp, name: args.name });
      }),
      remove: vi.fn(async (args: { channel: string; timestamp: string; name: string }) => {
        calls.push({ op: 'remove', channel: args.channel, ts: args.timestamp, name: args.name });
      }),
    };
    (adapter as unknown as { client: { reactions: typeof stub } }).client = {
      reactions: stub,
    } as never;

    type ReactionInternals = {
      addReceiptReaction: (msg: unknown) => void;
      clearReceiptReaction: (chatId: string, threadTs: string | undefined) => void;
      pendingReactions: Map<string, string>;
    };
    const internals = adapter as unknown as ReactionInternals;
    return { adapter, internals, calls };
  };

  it('exposes canReact = true', () => {
    const { adapter } = makeAdapter();
    expect(adapter.canReact).toBe(true);
  });

  // Observe mode (plan/phases/ambient-group-monitoring.md R11). A 👀 on every
  // message is the bot answering — visibly, to everyone in the channel. The
  // guard lives inside `addReceiptReaction`, so it holds for any caller.
  it('adds no reaction to a record-only message, and tracks nothing to clear', () => {
    const { internals, calls } = makeAdapter();

    internals.addReceiptReaction({
      platform: 'slack',
      botKey: 'b',
      chatId: 'C_SITE_7',
      messageId: '111.222',
      recordOnly: true,
    });

    expect(calls).toEqual([]);
    expect(internals.pendingReactions.size).toBe(0);
  });

  it('still reacts on a message it will actually answer', () => {
    const { internals, calls } = makeAdapter();

    internals.addReceiptReaction({
      platform: 'slack',
      botKey: 'b',
      chatId: 'C_SITE_7',
      messageId: '111.222',
      recordOnly: false,
    });

    expect(calls).toEqual([{ op: 'add', channel: 'C_SITE_7', ts: '111.222', name: 'eyes' }]);
  });

  it("adds the 'eyes' reaction on inbound and clears it on reply (top-level post)", async () => {
    const { internals, calls } = makeAdapter();

    internals.addReceiptReaction({
      platform: 'slack',
      botKey: 'b',
      chatId: 'C123',
      messageId: '111.222',
    });
    expect(calls).toEqual([{ op: 'add', channel: 'C123', ts: '111.222', name: 'eyes' }]);

    internals.clearReceiptReaction('C123', undefined);
    expect(calls).toEqual([
      { op: 'add', channel: 'C123', ts: '111.222', name: 'eyes' },
      { op: 'remove', channel: 'C123', ts: '111.222', name: 'eyes' },
    ]);
    expect(internals.pendingReactions.size).toBe(0);
  });

  it('tracks concurrent inbounds in different threads of the same channel', async () => {
    const { internals, calls } = makeAdapter();

    internals.addReceiptReaction({
      platform: 'slack',
      botKey: 'b',
      chatId: 'C1',
      messageId: '200.0',
      threadId: '100.0',
    });
    internals.addReceiptReaction({
      platform: 'slack',
      botKey: 'b',
      chatId: 'C1',
      messageId: '300.0',
      threadId: '150.0',
    });

    // Clearing the second thread must not touch the first thread's reaction.
    internals.clearReceiptReaction('C1', '150.0');
    expect(calls.filter((c) => c.op === 'remove')).toEqual([
      { op: 'remove', channel: 'C1', ts: '300.0', name: 'eyes' },
    ]);
    expect(internals.pendingReactions.size).toBe(1);

    internals.clearReceiptReaction('C1', '100.0');
    expect(calls.filter((c) => c.op === 'remove')).toEqual([
      { op: 'remove', channel: 'C1', ts: '300.0', name: 'eyes' },
      { op: 'remove', channel: 'C1', ts: '200.0', name: 'eyes' },
    ]);
    expect(internals.pendingReactions.size).toBe(0);
  });

  it('honours a custom receiptReaction', () => {
    const { internals, calls } = makeAdapter({ receiptReaction: 'thinking_face' });
    internals.addReceiptReaction({
      platform: 'slack',
      botKey: 'b',
      chatId: 'C9',
      messageId: '9.9',
    });
    expect(calls[0]?.name).toBe('thinking_face');
  });

  it('is a no-op when the inbound has no messageId', () => {
    const { internals, calls } = makeAdapter();
    internals.addReceiptReaction({ platform: 'slack', botKey: 'b', chatId: 'C1' });
    expect(calls).toEqual([]);
    expect(internals.pendingReactions.size).toBe(0);
  });

  it('clear is a no-op when no reaction is pending for the lane', () => {
    const { internals, calls } = makeAdapter();
    internals.clearReceiptReaction('C1', undefined);
    expect(calls).toEqual([]);
  });
});
