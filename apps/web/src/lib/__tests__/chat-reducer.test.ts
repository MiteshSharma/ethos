import type { SseEvent, StoredMessage } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  type AssistantTurn,
  applyAction,
  applyEvent,
  type ChatState,
  initialChatState,
  type TextBlock,
  type ToolBlock,
} from '../chat-reducer';

// Pure-function tests for the chat state machine. The reducer is the
// load-bearing logic in `useChat`; everything else is plumbing.

const NOW = 1000;

function storedMsg(over: Partial<StoredMessage> & { role: StoredMessage['role'] }): StoredMessage {
  return {
    id: 'm',
    sessionId: 's1',
    content: '',
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    timestamp: new Date(0).toISOString(),
    ...over,
  };
}

describe('applyEvent — text streaming', () => {
  it('text_delta on an empty state opens a fresh turn with one text block', () => {
    const next = applyEvent(initialChatState, { type: 'text_delta', text: 'Hi' }, NOW);
    expect(next.currentTurn?.blocks).toEqual([{ kind: 'text', content: 'Hi' }]);
    expect(next.isStreaming).toBe(true);
  });

  it('text_delta extends the trailing text block in place', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(s, { type: 'text_delta', text: 'Hel' }, NOW);
    s = applyEvent(s, { type: 'text_delta', text: 'lo, ' }, NOW);
    s = applyEvent(s, { type: 'text_delta', text: 'world.' }, NOW);
    expect(s.currentTurn?.blocks).toEqual([{ kind: 'text', content: 'Hello, world.' }]);
  });

  it('text_delta after a tool block opens a new text block', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(s, { type: 'text_delta', text: 'thinking' }, NOW);
    s = applyEvent(
      s,
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'read_file', args: { path: 'x' } },
      NOW,
    );
    s = applyEvent(s, { type: 'text_delta', text: 'now answering' }, NOW);
    const blocks = s.currentTurn?.blocks ?? [];
    expect(blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
    expect((blocks[2] as TextBlock).content).toBe('now answering');
  });

  it('done finalises the turn into messages', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(s, { type: 'text_delta', text: 'partial' }, NOW);
    s = applyEvent(s, { type: 'done', text: 'partial', turnCount: 1 }, NOW);
    expect(s.currentTurn).toBeNull();
    expect(s.isStreaming).toBe(false);
    expect(s.messages).toHaveLength(1);
    const turn = s.messages[0] as AssistantTurn;
    expect(turn.blocks).toEqual([{ kind: 'text', content: 'partial' }]);
  });

  it('done with no in-flight turn is a no-op (replay defense)', () => {
    const s = applyEvent(initialChatState, { type: 'done', text: 'old', turnCount: 1 }, NOW);
    expect(s.messages).toHaveLength(0);
    expect(s.isStreaming).toBe(false);
  });

  it('done is idempotent vs identical history (replay defense)', () => {
    let s: ChatState = applyAction(initialChatState, {
      type: 'history-loaded',
      messages: [
        storedMsg({
          id: 'asst-old',
          role: 'assistant',
          content: 'cached reply',
          timestamp: new Date(100).toISOString(),
        }),
      ],
    });
    // Stream the identical body and a done event — the live turn would
    // duplicate the historic message if the dedupe didn't fire.
    s = applyEvent(s, { type: 'text_delta', text: 'cached reply' }, NOW);
    s = applyEvent(s, { type: 'done', text: 'cached reply', turnCount: 1 }, NOW);
    expect(s.messages).toHaveLength(1);
    expect(s.currentTurn).toBeNull();
  });
});

describe('applyEvent — tool blocks', () => {
  it('tool_start appends a running tool block', () => {
    const s = applyEvent(
      initialChatState,
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'web_fetch', args: { url: 'x' } },
      NOW,
    );
    const block = s.currentTurn?.blocks[0] as ToolBlock | undefined;
    expect(block?.kind).toBe('tool');
    expect(block?.status).toBe('running');
    expect(block?.toolName).toBe('web_fetch');
    expect(block?.args).toEqual({ url: 'x' });
  });

  it('tool_end flips the matching block to ok with duration + result', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(
      s,
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'read_file', args: {} },
      NOW,
    );
    s = applyEvent(
      s,
      {
        type: 'tool_end',
        toolCallId: 'tc1',
        toolName: 'read_file',
        ok: true,
        durationMs: 42,
        result: 'file contents',
      },
      NOW,
    );
    const block = s.currentTurn?.blocks[0] as ToolBlock;
    expect(block.status).toBe('ok');
    expect(block.durationMs).toBe(42);
    expect(block.result).toBe('file contents');
  });

  it('tool_end with ok:false flips to failed and carries the error', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(
      s,
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'bash', args: { cmd: 'rm -rf /' } },
      NOW,
    );
    s = applyEvent(
      s,
      {
        type: 'tool_end',
        toolCallId: 'tc1',
        toolName: 'bash',
        ok: false,
        durationMs: 0,
        result: 'denied by user',
      },
      NOW,
    );
    const block = s.currentTurn?.blocks[0] as ToolBlock;
    expect(block.status).toBe('failed');
    expect(block.result).toBe('denied by user');
  });

  it('tool_end without a matching block is a no-op', () => {
    const s = applyEvent(
      initialChatState,
      { type: 'tool_end', toolCallId: 'unknown', toolName: 'x', ok: true, durationMs: 1 },
      NOW,
    );
    expect(s).toBe(initialChatState);
  });

  it('tool_end can update a block in the last finalised message (out-of-order delivery)', () => {
    // Simulate: tool_start → done → tool_end (rare but possible across
    // SSE reconnect). The block lives in `messages` by the time
    // tool_end arrives; the reducer should still find it.
    let s: ChatState = initialChatState;
    s = applyEvent(s, { type: 'tool_start', toolCallId: 'tc1', toolName: 'x', args: {} }, NOW);
    s = applyEvent(s, { type: 'done', text: '', turnCount: 1 }, NOW);
    s = applyEvent(
      s,
      { type: 'tool_end', toolCallId: 'tc1', toolName: 'x', ok: true, durationMs: 5, result: 'r' },
      NOW,
    );
    const turn = s.messages[0] as AssistantTurn;
    const block = turn.blocks[0] as ToolBlock;
    expect(block.status).toBe('ok');
    expect(block.result).toBe('r');
  });
});

describe('applyEvent — approval flow', () => {
  it('tool.approval_required pre-creates a pending-approval block + queues the request', () => {
    const s = applyEvent(
      initialChatState,
      {
        type: 'tool.approval_required',
        request: {
          approvalId: 'ap1',
          sessionId: 'sess_1',
          toolCallId: 'tc1',
          toolName: 'terminal',
          args: { command: 'rm -rf /' },
          reason: 'recursive force-delete',
        },
      },
      NOW,
    );
    expect(s.pendingApprovals).toHaveLength(1);
    expect(s.pendingApprovals[0]?.approvalId).toBe('ap1');
    const block = s.currentTurn?.blocks[0] as ToolBlock | undefined;
    expect(block?.status).toBe('pending-approval');
    expect(block?.toolName).toBe('terminal');
    expect(block?.reason).toBe('recursive force-delete');
  });

  it('tool_start after approval flips the pending block to running (no duplicate)', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(
      s,
      {
        type: 'tool.approval_required',
        request: {
          approvalId: 'ap1',
          sessionId: 's',
          toolCallId: 'tc1',
          toolName: 'bash',
          args: { cmd: 'x' },
          reason: null,
        },
      },
      NOW,
    );
    s = applyEvent(
      s,
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'bash', args: { cmd: 'x' } },
      NOW,
    );
    expect(s.currentTurn?.blocks).toHaveLength(1);
    const block = s.currentTurn?.blocks[0] as ToolBlock;
    expect(block.status).toBe('running');
  });

  it('approval.resolved drops the request from the modal queue', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(
      s,
      {
        type: 'tool.approval_required',
        request: {
          approvalId: 'ap1',
          sessionId: 's',
          toolCallId: 'tc1',
          toolName: 'bash',
          args: {},
          reason: null,
        },
      },
      NOW,
    );
    s = applyEvent(
      s,
      { type: 'approval.resolved', approvalId: 'ap1', decision: 'allow', decidedBy: 'tab-A' },
      NOW,
    );
    expect(s.pendingApprovals).toHaveLength(0);
  });

  it('deny path: tool_end with ok:false flips the pending block to failed (no tool_start)', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(
      s,
      {
        type: 'tool.approval_required',
        request: {
          approvalId: 'ap1',
          sessionId: 's',
          toolCallId: 'tc1',
          toolName: 'terminal',
          args: { command: 'rm -rf /' },
          reason: 'force-delete',
        },
      },
      NOW,
    );
    s = applyEvent(
      s,
      { type: 'approval.resolved', approvalId: 'ap1', decision: 'deny', decidedBy: 'tab-A' },
      NOW,
    );
    s = applyEvent(
      s,
      {
        type: 'tool_end',
        toolCallId: 'tc1',
        toolName: 'terminal',
        ok: false,
        durationMs: 0,
        result: 'denied by user',
      },
      NOW,
    );
    const block = s.currentTurn?.blocks[0] as ToolBlock;
    expect(block.status).toBe('failed');
    expect(block.result).toBe('denied by user');
    expect(s.pendingApprovals).toHaveLength(0);
  });

  it('repeated tool.approval_required for the same id does NOT duplicate the queue entry', () => {
    let s: ChatState = initialChatState;
    const req = {
      approvalId: 'ap1',
      sessionId: 's',
      toolCallId: 'tc1',
      toolName: 'bash',
      args: {},
      reason: null,
    };
    s = applyEvent(s, { type: 'tool.approval_required', request: req }, NOW);
    s = applyEvent(s, { type: 'tool.approval_required', request: req }, NOW);
    expect(s.pendingApprovals).toHaveLength(1);
    expect(s.currentTurn?.blocks).toHaveLength(1);
  });
});

describe('applyAction — reset', () => {
  it('reset wipes everything for a session change', () => {
    let s: ChatState = initialChatState;
    s = applyAction(s, {
      type: 'submit-user-message',
      id: 'u1',
      text: 'hi',
      timestamp: 1,
    });
    s = applyEvent(s, { type: 'text_delta', text: 'partial' }, NOW);
    expect(s.messages.length + (s.currentTurn ? 1 : 0)).toBeGreaterThan(0);
    s = applyAction(s, { type: 'reset' });
    expect(s).toEqual(initialChatState);
  });
});

describe('applyEvent — error and unhandled events', () => {
  it('error sets the surface error and stops streaming, preserves blocks', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(s, { type: 'text_delta', text: 'half-done' }, NOW);
    s = applyEvent(s, { type: 'error', error: 'rate limited', code: 'RATE_LIMIT' }, NOW);
    expect(s.error).toBe('rate limited');
    expect(s.isStreaming).toBe(false);
    expect(s.currentTurn?.blocks).toHaveLength(1);
  });

  it('thinking / progress / push events do not mutate state', () => {
    const events: SseEvent[] = [
      { type: 'thinking_delta', thinking: 'planning' },
      { type: 'tool_progress', toolName: 'x', message: 'wait', audience: 'user' },
      { type: 'usage', inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0 },
      { type: 'message_persisted', messageId: 'm1', role: 'assistant' },
    ];
    let s: ChatState = initialChatState;
    for (const event of events) s = applyEvent(s, event, NOW);
    expect(s).toEqual(initialChatState);
  });
});

describe('applyAction — UI/lifecycle transitions', () => {
  it('submit-user-message appends the user bubble and clears prior error', () => {
    const s = applyAction(
      { ...initialChatState, error: 'previous failure' },
      { type: 'submit-user-message', id: 'u1', text: 'hi', timestamp: 1 },
    );
    expect(s.messages).toEqual([{ id: 'u1', role: 'user', content: 'hi', timestamp: 1 }]);
    expect(s.error).toBeNull();
  });

  it('history-loaded interleaves assistant rows + tool_result rows into one turn', () => {
    const stored: StoredMessage[] = [
      storedMsg({
        id: 'u1',
        role: 'user',
        content: 'do the thing',
        timestamp: new Date(10).toISOString(),
      }),
      storedMsg({
        id: 'a1',
        role: 'assistant',
        content: 'let me check',
        toolCalls: [{ id: 'tc1', name: 'read_file', input: { path: 'x' } }],
        timestamp: new Date(20).toISOString(),
      }),
      storedMsg({
        id: 'tr1',
        role: 'tool_result',
        content: '<file body>',
        toolCallId: 'tc1',
        toolName: 'read_file',
        timestamp: new Date(25).toISOString(),
      }),
      storedMsg({
        id: 'a2',
        role: 'assistant',
        content: 'done',
        timestamp: new Date(30).toISOString(),
      }),
    ];
    const s = applyAction(initialChatState, { type: 'history-loaded', messages: stored });
    expect(s.messages).toHaveLength(2);
    expect(s.messages[0]?.role).toBe('user');
    const turn = s.messages[1] as AssistantTurn;
    expect(turn.blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'text']);
    expect((turn.blocks[1] as ToolBlock).result).toBe('<file body>');
    expect((turn.blocks[2] as TextBlock).content).toBe('done');
  });

  it('history-loaded skips tool_result that has no matching tool block', () => {
    const stored: StoredMessage[] = [
      storedMsg({
        id: 'tr-orphan',
        role: 'tool_result',
        content: 'no parent',
        toolCallId: 'tc-missing',
        timestamp: new Date(1).toISOString(),
      }),
    ];
    const s = applyAction(initialChatState, { type: 'history-loaded', messages: stored });
    expect(s.messages).toEqual([]);
  });

  it('history-loaded skips system messages and empty assistant rows', () => {
    const stored: StoredMessage[] = [
      storedMsg({
        id: 'sys',
        role: 'system',
        content: 'init',
        timestamp: new Date(1).toISOString(),
      }),
      storedMsg({
        id: 'a-empty',
        role: 'assistant',
        content: '   ',
        timestamp: new Date(2).toISOString(),
      }),
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
});
