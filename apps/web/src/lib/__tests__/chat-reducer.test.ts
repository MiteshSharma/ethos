import type { SseEvent, StoredMessage } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import { applyAction, applyEvent, type ChatState, initialChatState } from '../chat-reducer';

// Pure-function tests for the chat state machine. These run without React
// or EventSource — the reducer is the load-bearing logic in `useChat` and
// every other moving part is plumbing.

describe('applyEvent — SSE-driven transitions', () => {
  it('text_delta starts a streaming buffer when none is active', () => {
    const next = applyEvent(initialChatState, { type: 'text_delta', text: 'Hi' }, 0);
    expect(next.streamingText).toBe('Hi');
    expect(next.isStreaming).toBe(true);
  });

  it('text_delta accumulates across chunks', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(s, { type: 'text_delta', text: 'Hel' }, 0);
    s = applyEvent(s, { type: 'text_delta', text: 'lo, ' }, 0);
    s = applyEvent(s, { type: 'text_delta', text: 'world.' }, 0);
    expect(s.streamingText).toBe('Hello, world.');
  });

  it('done finalises the streaming buffer into an assistant message', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(s, { type: 'text_delta', text: 'partial' }, 0);
    s = applyEvent(s, { type: 'done', text: 'partial then full', turnCount: 1 }, 1234);
    expect(s.streamingText).toBeNull();
    expect(s.isStreaming).toBe(false);
    expect(s.messages).toHaveLength(1);
    expect(s.messages[0]).toMatchObject({
      role: 'assistant',
      content: 'partial then full',
      timestamp: 1234,
    });
  });

  it('done trusts server text over locally accumulated text', () => {
    // The server's `done.text` is canonical — even if a delta got lost
    // mid-stream, the final body should be what we render.
    let s: ChatState = initialChatState;
    s = applyEvent(s, { type: 'text_delta', text: 'incomplete' }, 0);
    s = applyEvent(s, { type: 'done', text: 'COMPLETE BODY', turnCount: 1 }, 5);
    expect(s.messages[0]?.content).toBe('COMPLETE BODY');
  });

  it('done is idempotent vs a replayed buffer (no double-append)', () => {
    // Simulates the page-refresh case where the SSE buffer replays the
    // last completed turn. History already contains the assistant
    // message; the replay should be a no-op for the messages list.
    let s: ChatState = applyAction(initialChatState, {
      type: 'history-loaded',
      messages: [
        {
          id: 'asst-old',
          sessionId: 's1',
          role: 'assistant',
          content: 'cached reply',
          toolCallId: null,
          toolName: null,
          toolCalls: null,
          timestamp: new Date(100).toISOString(),
        },
      ],
    });
    s = applyEvent(s, { type: 'done', text: 'cached reply', turnCount: 1 }, 200);
    expect(s.messages).toHaveLength(1);
    expect(s.streamingText).toBeNull();
    expect(s.isStreaming).toBe(false);
  });

  it('error sets the surface error and stops streaming', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(s, { type: 'text_delta', text: 'half-done' }, 0);
    s = applyEvent(s, { type: 'error', error: 'rate limited', code: 'RATE_LIMIT' }, 0);
    expect(s.error).toBe('rate limited');
    expect(s.isStreaming).toBe(false);
    // Streaming buffer preserved so the user can copy what came through.
    expect(s.streamingText).toBe('half-done');
  });

  it('thinking / tool / usage / push events do not mutate state in W2a', () => {
    const events: SseEvent[] = [
      { type: 'thinking_delta', thinking: 'planning' },
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'read_file', args: {} },
      { type: 'tool_progress', toolName: 'read_file', message: 'reading', audience: 'user' },
      { type: 'tool_end', toolCallId: 'tc1', toolName: 'read_file', ok: true, durationMs: 12 },
      { type: 'usage', inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.001 },
      { type: 'message_persisted', messageId: 'm1', role: 'assistant' },
    ];
    let s: ChatState = initialChatState;
    for (const event of events) s = applyEvent(s, event, 0);
    expect(s).toEqual(initialChatState);
  });
});

describe('applyAction — UI/lifecycle transitions', () => {
  it('submit-user-message appends the user bubble + clears prior error', () => {
    const s = applyAction(
      { ...initialChatState, error: 'previous failure' },
      { type: 'submit-user-message', id: 'u1', text: 'hi', timestamp: 1 },
    );
    expect(s.messages).toEqual([{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }]);
    expect(s.error).toBeNull();
  });

  it('history-loaded maps StoredMessage[] to ChatMessage[] and skips tool/system', () => {
    const stored: StoredMessage[] = [
      {
        id: 'u1',
        sessionId: 's1',
        role: 'user',
        content: 'first',
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        timestamp: new Date(10).toISOString(),
      },
      {
        id: 'a1',
        sessionId: 's1',
        role: 'assistant',
        content: 'reply',
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        timestamp: new Date(20).toISOString(),
      },
      {
        id: 'tr1',
        sessionId: 's1',
        role: 'tool_result',
        content: 'tool output',
        toolCallId: 'tc1',
        toolName: 'read_file',
        toolCalls: null,
        timestamp: new Date(15).toISOString(),
      },
      {
        id: 'sys1',
        sessionId: 's1',
        role: 'system',
        content: 'system note',
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        timestamp: new Date(5).toISOString(),
      },
    ];
    const s = applyAction(initialChatState, { type: 'history-loaded', messages: stored });
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('history-loaded skips empty assistant messages (mid-tool turn placeholders)', () => {
    const stored: StoredMessage[] = [
      {
        id: 'a-empty',
        sessionId: 's1',
        role: 'assistant',
        content: '   ',
        toolCallId: null,
        toolName: null,
        toolCalls: null,
        timestamp: new Date(1).toISOString(),
      },
    ];
    const s = applyAction(initialChatState, { type: 'history-loaded', messages: stored });
    expect(s.messages).toEqual([]);
  });

  it('send-failed drops the optimistic user message and surfaces the error', () => {
    let s = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u1',
      text: 'hi',
      timestamp: 1,
    });
    s = applyAction(s, { type: 'send-failed', userMessageId: 'u1', error: 'offline' });
    expect(s.messages).toEqual([]);
    expect(s.error).toBe('offline');
  });

  it('clear-error wipes the error without disturbing messages', () => {
    let s: ChatState = { ...initialChatState, error: 'something', messages: [] };
    s = applyAction(s, { type: 'clear-error' });
    expect(s.error).toBeNull();
  });
});
