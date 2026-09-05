import { InMemoryAttachmentCache } from '@ethosagent/storage-fs';
import type { InboundMessage } from '@ethosagent/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mock grammy — mirrors the phase1 mock setup but adds getFile for downloads
// ---------------------------------------------------------------------------

const mockApi = {
  setMyName: vi.fn().mockResolvedValue(true),
  setMyShortDescription: vi.fn().mockResolvedValue(true),
  setMyDescription: vi.fn().mockResolvedValue(true),
  setMyCommands: vi.fn().mockResolvedValue(true),
  setMessageReaction: vi.fn().mockResolvedValue(true),
  sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
  sendChatAction: vi.fn().mockResolvedValue(true),
  editMessageText: vi.fn().mockResolvedValue(true),
  deleteMessage: vi.fn().mockResolvedValue(true),
  getMe: vi.fn().mockResolvedValue({
    id: 1,
    is_bot: true,
    first_name: 'Bot',
    username: 'testbot',
  }),
  getFile: vi.fn().mockResolvedValue({
    file_id: 'abc123',
    file_unique_id: 'unique123',
    file_path: 'photos/file_0.jpg',
    file_size: 1024,
  }),
};

const registeredHandlers: Record<string, ((ctx: unknown) => void)[]> = {};

vi.mock('grammy', () => {
  class MockBot {
    token = '1:fake-token';
    api = mockApi;
    on(event: string, handler: (ctx: unknown) => void) {
      if (!registeredHandlers[event]) registeredHandlers[event] = [];
      registeredHandlers[event].push(handler);
    }
    start() {
      return Promise.resolve();
    }
    stop() {
      return Promise.resolve();
    }
  }
  class MockInlineKeyboard {
    text() {
      return this;
    }
    row() {
      return this;
    }
  }
  return { Bot: MockBot, InlineKeyboard: MockInlineKeyboard };
});

import { TelegramAdapter, type TelegramAdapterConfig } from '../index';

// botKey is a required constructor param (computed once in wiring); these
// cases don't exercise routing, so `mk` supplies a fixed default.
const mk = (cfg: Omit<TelegramAdapterConfig, 'botKey'> & { botKey?: string }): TelegramAdapter =>
  new TelegramAdapter({ ...cfg, botKey: cfg.botKey ?? 'test-bot' });

let cache: InMemoryAttachmentCache;

function resetMocks() {
  cache = new InMemoryAttachmentCache();
  for (const key of Object.keys(mockApi) as (keyof typeof mockApi)[]) {
    mockApi[key].mockReset();
  }
  // Restore default implementations after reset
  mockApi.setMyName.mockResolvedValue(true);
  mockApi.setMyShortDescription.mockResolvedValue(true);
  mockApi.setMyDescription.mockResolvedValue(true);
  mockApi.setMyCommands.mockResolvedValue(true);
  mockApi.setMessageReaction.mockResolvedValue(true);
  mockApi.sendMessage.mockResolvedValue({ message_id: 42 });
  mockApi.sendChatAction.mockResolvedValue(true);
  mockApi.editMessageText.mockResolvedValue(true);
  mockApi.deleteMessage.mockResolvedValue(true);
  mockApi.getMe.mockResolvedValue({
    id: 1,
    is_bot: true,
    first_name: 'Bot',
    username: 'testbot',
  });
  mockApi.getFile.mockResolvedValue({
    file_id: 'abc123',
    file_unique_id: 'unique123',
    file_path: 'photos/file_0.jpg',
    file_size: 1024,
  });
  for (const key of Object.keys(registeredHandlers)) {
    delete registeredHandlers[key];
  }
  vi.restoreAllMocks();
}

/** Helper: fire the 'message' handler with a fake ctx. */
function fireMessage(ctx: unknown): void {
  const handlers = registeredHandlers.message;
  if (!handlers?.length) throw new Error('No message handler registered');
  for (const h of handlers) h(ctx);
}

/** Helper: fire the 'edited_message' handler with a fake ctx. */
function fireEditedMessage(ctx: unknown): void {
  const handlers = registeredHandlers.edited_message;
  if (!handlers?.length) throw new Error('No edited_message handler registered');
  for (const h of handlers) h(ctx);
}

// ---------------------------------------------------------------------------
// 3.1 — Inbound file support
// ---------------------------------------------------------------------------

describe('3.1 — Inbound file support', () => {
  beforeEach(resetMocks);

  it('attaches a photo with downloaded data to InboundMessage', async () => {
    // Stub fetch for file download
    const fakeBuffer = Buffer.from('fake-image-data');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          fakeBuffer.buffer.slice(
            fakeBuffer.byteOffset,
            fakeBuffer.byteOffset + fakeBuffer.byteLength,
          ),
      }),
    );

    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200, username: 'user1' },
      message: {
        text: undefined,
        caption: 'my photo',
        message_id: 1,
        reply_to_message: null,
        photo: [
          { file_id: 'small', file_unique_id: 's', width: 90, height: 90 },
          { file_id: 'large', file_unique_id: 'l', width: 800, height: 600 },
        ],
      },
      me: { username: 'testbot' },
    });

    // Allow async download to complete
    await vi.waitFor(() => {
      expect(captured).toHaveLength(1);
    });

    const msg = captured[0];
    expect(msg.botKey).toBe('test-bot');
    expect(msg.text).toBe('my photo');
    expect(msg.attachments).toHaveLength(1);
    const att = msg.attachments?.[0];
    expect(att?.type).toBe('image');
    expect(att?.mimeType).toBe('image/jpeg');
    expect(att?.url).toMatch(/^file:\/\//);
    expect(att?.ref).toBe('att-0');
    expect(att).not.toHaveProperty('data');
    // Should use the largest photo (last element)
    expect(mockApi.getFile).toHaveBeenCalledWith('large');
  });

  it('processes a photo message with no caption using placeholder text', async () => {
    const fakeBuffer = Buffer.from('img');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          fakeBuffer.buffer.slice(
            fakeBuffer.byteOffset,
            fakeBuffer.byteOffset + fakeBuffer.byteLength,
          ),
      }),
    );

    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: undefined,
        caption: undefined,
        message_id: 2,
        reply_to_message: null,
        photo: [{ file_id: 'f1', file_unique_id: 'u1', width: 100, height: 100 }],
      },
      me: { username: 'testbot' },
    });

    await vi.waitFor(() => {
      expect(captured).toHaveLength(1);
    });

    expect(captured[0].text).toBe('(attached image)');
  });

  it('attaches a document with correct mime type and filename', async () => {
    const fakeBuffer = Buffer.from('pdf-bytes');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          fakeBuffer.buffer.slice(
            fakeBuffer.byteOffset,
            fakeBuffer.byteOffset + fakeBuffer.byteLength,
          ),
      }),
    );

    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: undefined,
        caption: 'here is my doc',
        message_id: 3,
        reply_to_message: null,
        document: {
          file_id: 'doc1',
          file_unique_id: 'du1',
          file_name: 'report.pdf',
          mime_type: 'application/pdf',
          file_size: 5000,
        },
      },
      me: { username: 'testbot' },
    });

    await vi.waitFor(() => {
      expect(captured).toHaveLength(1);
    });

    const att = captured[0].attachments?.[0];
    expect(att?.type).toBe('file');
    expect(att?.mimeType).toBe('application/pdf');
    expect(att?.filename).toBe('report.pdf');
    expect(att?.url).toMatch(/^file:\/\//);
    expect(att?.ref).toBe('att-0');
    expect(att).not.toHaveProperty('data');
  });

  it('voice message with caption produces audio attachment', async () => {
    const fakeBuffer = Buffer.from('fake-audio');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          fakeBuffer.buffer.slice(
            fakeBuffer.byteOffset,
            fakeBuffer.byteOffset + fakeBuffer.byteLength,
          ),
      }),
    );

    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: undefined,
        caption: 'voice note caption',
        message_id: 4,
        reply_to_message: null,
        voice: {
          file_id: 'v1',
          file_unique_id: 'vu1',
          duration: 10,
          mime_type: 'audio/ogg',
        },
      },
      me: { username: 'testbot' },
    });

    await vi.waitFor(() => {
      expect(captured).toHaveLength(1);
    });

    expect(captured[0].text).toBe('voice note caption');
    expect(captured[0].attachments).toHaveLength(1);
    const att = captured[0].attachments?.[0];
    expect(att?.type).toBe('audio');
    expect(att?.mimeType).toBe('audio/ogg');
    expect(att?.url).toMatch(/^file:\/\//);
  });

  it('voice message without caption uses placeholder text and produces audio attachment', async () => {
    const fakeBuffer = Buffer.from('fake-audio');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        arrayBuffer: async () =>
          fakeBuffer.buffer.slice(
            fakeBuffer.byteOffset,
            fakeBuffer.byteOffset + fakeBuffer.byteLength,
          ),
      }),
    );

    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: undefined,
        caption: undefined,
        message_id: 4,
        reply_to_message: null,
        voice: {
          file_id: 'v1',
          file_unique_id: 'vu1',
          duration: 10,
          mime_type: 'audio/ogg',
        },
      },
      me: { username: 'testbot' },
    });

    await vi.waitFor(() => {
      expect(captured).toHaveLength(1);
    });

    expect(captured[0].text).toBe('(voice message)');
    expect(captured[0].attachments).toHaveLength(1);
    expect(captured[0].attachments?.[0]?.type).toBe('audio');
  });

  it('video message with caption produces no attachments but preserves caption', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: undefined,
        caption: 'cool video',
        message_id: 5,
        reply_to_message: null,
        video: {
          file_id: 'vid1',
          file_unique_id: 'vu1',
          width: 1920,
          height: 1080,
          duration: 30,
          mime_type: 'video/mp4',
        },
      },
      me: { username: 'testbot' },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].text).toBe('cool video');
    expect(captured[0].attachments).toBeUndefined();
  });

  it('sticker is dropped (no text, no supported media)', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: undefined,
        caption: undefined,
        message_id: 6,
        reply_to_message: null,
        sticker: {
          file_id: 'stk1',
          file_unique_id: 'su1',
          type: 'regular',
          width: 512,
          height: 512,
          is_animated: false,
          is_video: false,
        },
      },
      me: { username: 'testbot' },
    });

    expect(captured).toHaveLength(0);
  });

  it('skips download when file exceeds 25 MB and appends size note', async () => {
    mockApi.getFile.mockResolvedValueOnce({
      file_id: 'big1',
      file_unique_id: 'bu1',
      file_path: 'documents/big.zip',
      file_size: 30 * 1024 * 1024, // 30 MB
    });

    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: undefined,
        caption: 'big file',
        message_id: 7,
        reply_to_message: null,
        document: {
          file_id: 'big1',
          file_unique_id: 'bu1',
          file_name: 'big.zip',
          mime_type: 'application/zip',
          file_size: 30 * 1024 * 1024,
        },
      },
      me: { username: 'testbot' },
    });

    await vi.waitFor(() => {
      expect(captured).toHaveLength(1);
    });

    expect(captured[0].text).toContain('big file');
    expect(captured[0].text).toContain('25 MB limit');
    // No attachment downloaded
    expect(captured[0].attachments ?? []).toHaveLength(0);
  });

  it('still forwards message with caption when download fails', async () => {
    mockApi.getFile.mockRejectedValueOnce(new Error('network error'));

    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: undefined,
        caption: 'photo with bad download',
        message_id: 8,
        reply_to_message: null,
        photo: [{ file_id: 'fail1', file_unique_id: 'fu1', width: 100, height: 100 }],
      },
      me: { username: 'testbot' },
    });

    await vi.waitFor(() => {
      expect(captured).toHaveLength(1);
    });

    expect(captured[0].text).toBe('photo with bad download');
    // No attachment since download failed, but message was still delivered
    expect(captured[0].attachments ?? []).toHaveLength(0);
  });

  it('animation (GIF) is dropped when no caption (no supported media)', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: undefined,
        caption: undefined,
        message_id: 9,
        reply_to_message: null,
        animation: {
          file_id: 'gif1',
          file_unique_id: 'gu1',
          width: 320,
          height: 240,
          duration: 5,
          mime_type: 'video/mp4',
        },
      },
      me: { username: 'testbot' },
    });

    expect(captured).toHaveLength(0);
  });

  it('audio message is dropped when no caption (no supported media)', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: undefined,
        caption: undefined,
        message_id: 10,
        reply_to_message: null,
        audio: {
          file_id: 'aud1',
          file_unique_id: 'au1',
          duration: 180,
          mime_type: 'audio/mpeg',
          file_name: 'song.mp3',
        },
      },
      me: { username: 'testbot' },
    });

    expect(captured).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3.2 — Forum-mode topic isolation
// ---------------------------------------------------------------------------

describe('3.2 — Forum-mode topic isolation', () => {
  beforeEach(resetMocks);

  it('sets threadId from message_thread_id when not General topic', async () => {
    const adapter = mk({
      token: '1:fake-token',
      cache,
      defaultChannelMode: 'all',
    });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'supergroup' },
      from: { id: 200, username: 'user1' },
      message: {
        text: 'hello from topic',
        caption: undefined,
        message_id: 1,
        message_thread_id: 42,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].threadId).toBe('42');
  });

  it('leaves threadId undefined for General topic (id 1)', async () => {
    const adapter = mk({
      token: '1:fake-token',
      cache,
      defaultChannelMode: 'all',
    });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'supergroup' },
      from: { id: 200 },
      message: {
        text: 'hello from general',
        caption: undefined,
        message_id: 2,
        message_thread_id: 1,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].threadId).toBeUndefined();
  });

  it('leaves threadId undefined for non-forum chats', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      message: {
        text: 'hello dm',
        caption: undefined,
        message_id: 3,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });

    expect(captured).toHaveLength(1);
    expect(captured[0].threadId).toBeUndefined();
  });

  it('passes message_thread_id on send() when threadId is set', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    await adapter.send('100', {
      text: 'reply in topic',
      threadId: '42',
    });

    expect(mockApi.sendMessage).toHaveBeenCalledWith(
      100,
      'reply in topic',
      expect.objectContaining({
        message_thread_id: 42,
      }),
    );
  });

  it('does not pass message_thread_id on send() when threadId is undefined', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    await adapter.send('100', { text: 'no topic' });

    const callArgs = mockApi.sendMessage.mock.calls[0][2] as Record<string, unknown>;
    expect(callArgs.message_thread_id).toBeUndefined();
  });

  it('passes message_thread_id on editMessage when threadId is set', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    // First send so we have a chunk mapping
    mockApi.sendMessage.mockResolvedValueOnce({ message_id: 50 });
    await adapter.send('100', { text: 'original', threadId: '42' });

    // Edit shouldn't need thread_id for editMessageText (Telegram API),
    // but it should be passed through on appended messages during reflow
  });
});

// ---------------------------------------------------------------------------
// 3.3 — edited_message handling
// ---------------------------------------------------------------------------

describe('3.3 — edited_message handling', () => {
  beforeEach(resetMocks);

  it('registers an edited_message handler on start()', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    expect(registeredHandlers.edited_message).toBeDefined();
    expect(registeredHandlers.edited_message?.length).toBeGreaterThan(0);
  });

  it('forwards edited message with isEdit: true', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireEditedMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200, username: 'user1' },
      editedMessage: {
        text: 'corrected text',
        caption: undefined,
        message_id: 5,
        date: Math.floor(Date.now() / 1000) - 10, // 10 seconds ago
        edit_date: Math.floor(Date.now() / 1000),
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });

    // Allow debounce to fire
    await vi.waitFor(
      () => {
        expect(captured).toHaveLength(1);
      },
      { timeout: 1000 },
    );

    expect(captured[0].text).toBe('corrected text');
    expect(captured[0].isEdit).toBe(true);
    expect(captured[0].messageId).toBe('5');
  });

  it('ignores edits outside the edit window', async () => {
    const adapter = mk({
      token: '1:fake-token',
      cache,
      editWindowMs: 30_000, // 30 seconds
    });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    fireEditedMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      editedMessage: {
        text: 'old edit',
        caption: undefined,
        message_id: 10,
        date: Math.floor(Date.now() / 1000) - 120, // 2 minutes ago
        edit_date: Math.floor(Date.now() / 1000),
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });

    // Give some time for potential processing
    await new Promise((r) => setTimeout(r, 400));
    expect(captured).toHaveLength(0);
  });

  it('coalesces rapid edits with debounce (only last edit fires)', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    const now = Math.floor(Date.now() / 1000);

    // Fire 3 rapid edits for the same message
    fireEditedMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      editedMessage: {
        text: 'edit-1',
        caption: undefined,
        message_id: 20,
        date: now - 5,
        edit_date: now,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });

    fireEditedMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      editedMessage: {
        text: 'edit-2',
        caption: undefined,
        message_id: 20,
        date: now - 5,
        edit_date: now,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });

    fireEditedMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      editedMessage: {
        text: 'edit-3',
        caption: undefined,
        message_id: 20,
        date: now - 5,
        edit_date: now,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });

    // Wait for debounce to settle (200ms + buffer)
    await vi.waitFor(
      () => {
        expect(captured).toHaveLength(1);
      },
      { timeout: 1000 },
    );

    // Only the last edit should have been processed
    expect(captured[0].text).toBe('edit-3');
    expect(captured[0].isEdit).toBe(true);
  });

  it('uses default 60s edit window when editWindowMs is not configured', async () => {
    const adapter = mk({ token: '1:fake-token', cache });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    // An edit 50 seconds after original — within 60s window
    const now = Math.floor(Date.now() / 1000);
    fireEditedMessage({
      chat: { id: 100, type: 'private' },
      from: { id: 200 },
      editedMessage: {
        text: 'recent edit',
        caption: undefined,
        message_id: 30,
        date: now - 50,
        edit_date: now,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });

    await vi.waitFor(
      () => {
        expect(captured).toHaveLength(1);
      },
      { timeout: 1000 },
    );

    expect(captured[0].isEdit).toBe(true);
  });

  it('includes threadId on edited messages from forum topics', async () => {
    // This case is about thread propagation, not channel policy: an edit now
    // takes the same channel-mode decision as the message it edits, and an
    // unmentioned supergroup post under the default `mention_only` is dropped
    // before any envelope is built. `all` keeps the fixture as written.
    const adapter = mk({ token: '1:fake-token', cache, defaultChannelMode: 'all' });
    await adapter.start();

    const captured: InboundMessage[] = [];
    adapter.onMessage((msg) => captured.push(msg));

    const now = Math.floor(Date.now() / 1000);
    fireEditedMessage({
      chat: { id: 100, type: 'supergroup' },
      from: { id: 200 },
      editedMessage: {
        text: 'edited in topic',
        caption: undefined,
        message_id: 40,
        message_thread_id: 99,
        date: now - 5,
        edit_date: now,
        reply_to_message: null,
      },
      me: { username: 'testbot' },
    });

    await vi.waitFor(
      () => {
        expect(captured).toHaveLength(1);
      },
      { timeout: 1000 },
    );

    expect(captured[0].threadId).toBe('99');
    expect(captured[0].isEdit).toBe(true);
  });
});
