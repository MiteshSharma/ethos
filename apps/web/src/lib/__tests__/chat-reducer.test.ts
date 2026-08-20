import type { SseEvent, StoredMessage } from '@ethosagent/web-contracts';
import { describe, expect, it } from 'vitest';
import {
  type AssistantTurn,
  applyAction,
  applyEvent,
  type CardBlock,
  type ChatState,
  initialChatState,
  parseUserContent,
  type TextBlock,
  type ToolBlock,
} from '../chat-reducer';

// Pure-function tests for the chat state machine. The reducer is the
// load-bearing logic in `useChat`; everything else is plumbing.

const NOW = 1000;

// Voice-origin fixtures, copied VERBATIM from the producer's template —
// `buildVoiceOriginAnnotation` in `packages/core/src/voice-origin.ts`. The
// producer's own tests
// (`packages/core/src/__tests__/voice-origin-annotation.test.ts`,
// "shape the web consumer strips") pin that these stay the shape this file
// assumes, so the two halves cannot drift apart silently.
const SPOKEN_INSTRUCTION =
  'The text below is a transcript: this turn was SPOKEN, and the reply will be read ' +
  'aloud. Answer in a spoken register — short sentences, no markdown, no tables, no ' +
  'code blocks, no raw URLs or file paths.';
const MINIMAL_ANNOTATION = `<voice-origin transport="browser-talk-mode" speaker="owner" />\n${SPOKEN_INSTRUCTION}`;
const FULL_ANNOTATION = `<voice-origin transport="telegram-voice-note" speaker="owner" stt="local-stt" language="en-US" />\n${SPOKEN_INSTRUCTION}`;
const FAR_END_ANNOTATION =
  `<voice-origin transport="sip-inbound" speaker="far_end" />\n${SPOKEN_INSTRUCTION}` +
  ' The speaker is a far-end caller, not the owner — their voice cannot authorize anything.';

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

describe('applyEvent — clarify flow', () => {
  const req = {
    type: 'clarify.request' as const,
    requestId: 'clr1',
    question: 'Which database?',
    options: ['postgres', 'sqlite'],
    default: 'postgres',
    defaultDeadlineAt: '2026-05-15T00:15:00.000Z',
  };

  it('clarify.request queues the request', () => {
    const s = applyEvent(initialChatState, req, NOW);
    expect(s.pendingClarifies).toHaveLength(1);
    expect(s.pendingClarifies[0]?.requestId).toBe('clr1');
  });

  it('repeated clarify.request for the same id does NOT duplicate (SSE reconnect)', () => {
    let s = applyEvent(initialChatState, req, NOW);
    s = applyEvent(s, req, NOW);
    expect(s.pendingClarifies).toHaveLength(1);
  });

  it('clarify.resolved drops the request from the queue', () => {
    let s = applyEvent(initialChatState, req, NOW);
    s = applyEvent(s, { type: 'clarify.resolved', requestId: 'clr1', source: 'user' }, NOW);
    expect(s.pendingClarifies).toHaveLength(0);
  });

  it('clarify.resolved for an unknown id is a no-op', () => {
    let s = applyEvent(initialChatState, req, NOW);
    s = applyEvent(s, { type: 'clarify.resolved', requestId: 'other', source: 'cancel' }, NOW);
    expect(s.pendingClarifies).toHaveLength(1);
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

describe('applyAction — runs-restored', () => {
  const row = {
    jobId: 'job_1',
    runner: 'pi',
    status: 'running' as const,
    spendUsd: 0.2,
    elapsedMs: 9_000,
  };

  function runAnchors(state: ChatState): string[] {
    const turns: AssistantTurn[] = [
      ...state.messages.filter((m): m is AssistantTurn => m.role === 'assistant'),
      ...(state.currentTurn ? [state.currentTurn] : []),
    ];
    return turns.flatMap((t) => t.blocks.flatMap((b) => (b.kind === 'run' ? [b.jobId] : [])));
  }

  it('anchors onto the last assistant message when no turn is in flight', () => {
    let s: ChatState = initialChatState;
    s = applyAction(s, { type: 'submit-user-message', id: 'u1', text: 'go', timestamp: 1 });
    s = applyEvent(s, { type: 'text_delta', text: 'on it' }, NOW);
    s = applyEvent(s, { type: 'done', text: 'on it', turnCount: 1 }, NOW);
    s = applyAction(s, { type: 'runs-restored', runs: [row], timestamp: NOW });
    expect(runAnchors(s)).toEqual(['job_1']);
    expect(s.runs.byId.job_1?.status).toBe('running');
    // Onto the existing turn, not as a bubble of its own.
    expect(s.messages).toHaveLength(2);
  });

  it('anchors onto the live turn when one is streaming', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(s, { type: 'text_delta', text: 'working' }, NOW);
    s = applyAction(s, { type: 'runs-restored', runs: [row], timestamp: NOW });
    expect(s.currentTurn?.blocks.map((b) => b.kind)).toEqual(['text', 'run']);
  });

  it('opens a turn of its own when the transcript has no assistant message yet', () => {
    let s: ChatState = initialChatState;
    s = applyAction(s, { type: 'submit-user-message', id: 'u1', text: 'go', timestamp: 1 });
    s = applyAction(s, { type: 'runs-restored', runs: [row], timestamp: NOW });
    expect(runAnchors(s)).toEqual(['job_1']);
    expect(s.messages).toHaveLength(2);
  });

  it('is a no-op for a run the digest already anchored', () => {
    let s: ChatState = initialChatState;
    s = applyEvent(
      s,
      {
        type: 'run.update',
        jobId: 'job_1',
        runner: 'pi',
        status: 'running',
        now: 'editing',
        elapsedMs: 1_000,
        spendUsd: 0.1,
        toolCount: 3,
      },
      NOW,
    );
    const before = s;
    s = applyAction(s, { type: 'runs-restored', runs: [row], timestamp: NOW });
    expect(s).toBe(before);
    expect(runAnchors(s)).toEqual(['job_1']);
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
      { type: 'message_persisted', messageId: 'm1', role: 'assistant' },
    ];
    let s: ChatState = initialChatState;
    for (const event of events) s = applyEvent(s, event, NOW);
    expect(s).toEqual(initialChatState);
  });

  it('usage tracks the latest inputTokens as context size and reset clears it', () => {
    let s: ChatState = initialChatState;
    expect(s.contextTokens).toBeNull();
    s = applyEvent(
      s,
      { type: 'usage', inputTokens: 1200, outputTokens: 50, estimatedCostUsd: 0 },
      NOW,
    );
    expect(s.contextTokens).toBe(1200);
    s = applyEvent(
      s,
      { type: 'usage', inputTokens: 3400, outputTokens: 90, estimatedCostUsd: 0 },
      NOW,
    );
    expect(s.contextTokens).toBe(3400);
    s = applyAction(s, { type: 'reset' });
    expect(s.contextTokens).toBeNull();
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

  it('submit-user-message carries attachments into the user bubble', () => {
    const s = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u2',
      text: 'see attached',
      timestamp: 2,
      attachments: [
        {
          localId: 'a1',
          state: 'ready',
          type: 'file',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 2048,
        },
      ],
    });
    const msg = s.messages[0];
    expect(msg?.role).toBe('user');
    if (msg?.role === 'user') {
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments?.[0]?.name).toBe('report.pdf');
    }
  });

  // The transcript never overwrites the audio marker: a spoken turn keeps the
  // fact that it was SPOKEN next to the words it was transcribed into, so the
  // bubble can show both. A typed turn carries no marker at all — the field is
  // absent, not `'text'`, so nothing renders for the ordinary case.
  it('submit-user-message carries a voice origin through to the bubble', () => {
    const s = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u3',
      text: 'remind me to call the dentist',
      timestamp: 3,
      origin: 'voice',
    });
    expect(s.messages).toEqual([
      {
        id: 'u3',
        role: 'user',
        content: 'remind me to call the dentist',
        timestamp: 3,
        origin: 'voice',
      },
    ]);
  });

  it('a typed turn carries no origin', () => {
    const s = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u4',
      text: 'remind me to call the dentist',
      timestamp: 4,
    });
    const msg = s.messages[0];
    expect(msg?.role).toBe('user');
    if (msg?.role === 'user') expect(msg.origin).toBeUndefined();
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

  // A reloaded spoken turn has to render IDENTICALLY to the optimistic one:
  // the transcript alone in the bubble, with the `voice` marker above it. The
  // agent loop bakes the voice-origin annotation into the stored `content`, so
  // history replay used to put that whole XML-plus-instructions block in the
  // bubble as if the user had typed it — and lose the marker at the same time.
  it('history-loaded strips the voice-origin annotation and recovers the marker', () => {
    const stored: StoredMessage[] = [
      storedMsg({
        id: 'u-voice',
        role: 'user',
        content: `${MINIMAL_ANNOTATION}\n\nremind me to call the dentist`,
        timestamp: new Date(1).toISOString(),
      }),
    ];
    const s = applyAction(initialChatState, { type: 'history-loaded', messages: stored });
    expect(s.messages).toEqual([
      {
        id: 'u-voice',
        role: 'user',
        content: 'remind me to call the dentist',
        timestamp: 1,
        origin: 'voice',
      },
    ]);
  });

  it('a second question keeps the partial answer, marked [interrupted]', () => {
    // Talk-mode barge-in: Q1 → the answer starts streaming → the user speaks
    // again, which reaches this reducer as an ordinary send. The partial answer
    // used to be DISCARDED here, so the two questions closed up next to each
    // other and text the user had already read vanished.
    let s = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u1',
      text: 'tell me a story',
      timestamp: 1,
    });
    s = applyEvent(s, { type: 'text_delta', text: 'Once upon a time' }, NOW);
    s = applyAction(s, {
      type: 'submit-user-message',
      id: 'u2',
      text: 'actually never mind',
      timestamp: 2,
    });

    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    const kept = s.messages[1] as AssistantTurn;
    expect(kept.blocks).toEqual([{ kind: 'text', content: 'Once upon a time [interrupted]' }]);
    expect(s.currentTurn).toBeNull();
  });

  it('marks a turn cut off mid-tool-call, which has no sentence to mark', () => {
    let s = applyEvent(
      initialChatState,
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'read_file', args: {} },
      NOW,
    );
    s = applyAction(s, { type: 'submit-user-message', id: 'u1', text: 'stop', timestamp: 1 });
    const kept = s.messages[0] as AssistantTurn;
    expect(kept.blocks.map((b) => b.kind)).toEqual(['tool', 'text']);
    expect((kept.blocks[1] as TextBlock).content).toBe('[interrupted]');
  });

  it('keeps nothing when no answer had started', () => {
    const s = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u1',
      text: 'hi',
      timestamp: 1,
    });
    expect(s.messages).toHaveLength(1);
  });

  it('a late done does not append the turn a second time', () => {
    let s = applyAction(initialChatState, {
      type: 'submit-user-message',
      id: 'u1',
      text: 'q1',
      timestamp: 1,
    });
    s = applyEvent(s, { type: 'text_delta', text: 'partial' }, NOW);
    s = applyAction(s, { type: 'submit-user-message', id: 'u2', text: 'q2', timestamp: 2 });
    s = applyEvent(s, { type: 'done', text: 'partial', turnCount: 1 }, NOW);
    expect(s.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
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

describe('typed UI cards', () => {
  const cardEnvelope = {
    kind: 'alert' as const,
    specVersion: 1 as const,
    payload: { severity: 'info' as const, message: 'Prices refreshed.' },
  };

  function turnWithTool(): ChatState {
    let s: ChatState = initialChatState;
    s = applyEvent(
      s,
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'emit_card', args: {} },
      NOW,
    );
    return s;
  }

  it('tool_end with a valid card appends one card block beside the tool chip', () => {
    let s = turnWithTool();
    s = applyEvent(
      s,
      {
        type: 'tool_end',
        toolCallId: 'tc1',
        toolName: 'emit_card',
        ok: true,
        durationMs: 3,
        structured: { card: cardEnvelope },
      },
      NOW,
    );
    const blocks = s.currentTurn?.blocks ?? [];
    expect(blocks.map((b) => b.kind)).toEqual(['tool', 'card']);
    const card = blocks[1] as CardBlock;
    expect(card.toolCallId).toBe('tc1');
    expect(card.card).toEqual(cardEnvelope);
  });

  it('tool_end with an invalid card appends nothing and does not throw', () => {
    let s = turnWithTool();
    s = applyEvent(
      s,
      {
        type: 'tool_end',
        toolCallId: 'tc1',
        toolName: 'emit_card',
        ok: true,
        durationMs: 3,
        // `severity` is not in the enum — the schema rejects it.
        structured: { card: { kind: 'alert', specVersion: 1, payload: { severity: 'nope' } } },
      },
      NOW,
    );
    expect(s.currentTurn?.blocks.map((b) => b.kind)).toEqual(['tool']);
  });

  it('history-loaded places a replayed card directly after its tool block', () => {
    const stored: StoredMessage[] = [
      storedMsg({
        id: 'a1',
        role: 'assistant',
        content: 'here you go',
        toolCalls: [
          { id: 'tc1', name: 'emit_card', input: {} },
          { id: 'tc2', name: 'read_file', input: {} },
        ],
        timestamp: new Date(20).toISOString(),
      }),
    ];
    const s = applyAction(initialChatState, {
      type: 'history-loaded',
      messages: stored,
      cards: [
        { toolCallId: 'tc1', seq: 1, envelope: cardEnvelope },
        {
          toolCallId: 'tc1',
          seq: 0,
          envelope: { ...cardEnvelope, payload: { ...cardEnvelope.payload, message: 'First.' } },
        },
      ],
    });
    const turn = s.messages[0] as AssistantTurn;
    expect(turn.blocks.map((b) => b.kind)).toEqual(['text', 'tool', 'card', 'card', 'tool']);
    // Ordered by seq, not by arrival.
    expect((turn.blocks[2] as CardBlock).card.payload).toMatchObject({ message: 'First.' });
  });

  it('history-loaded appends a card with no matching tool block to the last turn', () => {
    const stored: StoredMessage[] = [
      storedMsg({
        id: 'a1',
        role: 'assistant',
        content: 'here you go',
        timestamp: new Date(20).toISOString(),
      }),
    ];
    const s = applyAction(initialChatState, {
      type: 'history-loaded',
      messages: stored,
      cards: [{ toolCallId: 'orphan', seq: 0, envelope: cardEnvelope }],
    });
    const turn = s.messages[0] as AssistantTurn;
    expect(turn.blocks.map((b) => b.kind)).toEqual(['text', 'card']);
  });

  it('done dedupes a live turn against history that already holds the card', () => {
    const stored: StoredMessage[] = [
      storedMsg({
        id: 'a1',
        role: 'assistant',
        content: '',
        toolCalls: [{ id: 'tc1', name: 'emit_card', input: {} }],
        timestamp: new Date(20).toISOString(),
      }),
    ];
    let s = applyAction(initialChatState, {
      type: 'history-loaded',
      messages: stored,
      cards: [{ toolCallId: 'tc1', seq: 0, envelope: cardEnvelope }],
    });
    s = applyEvent(
      s,
      { type: 'tool_start', toolCallId: 'tc1', toolName: 'emit_card', args: {} },
      NOW,
    );
    s = applyEvent(
      s,
      {
        type: 'tool_end',
        toolCallId: 'tc1',
        toolName: 'emit_card',
        ok: true,
        durationMs: 3,
        structured: { card: cardEnvelope },
      },
      NOW,
    );
    s = applyEvent(s, { type: 'done', text: '', turnCount: 1 }, NOW);
    expect(s.messages).toHaveLength(1);
  });
});

// The agent loop bakes annotations into the stored user message, because the
// model needs them. The bubble does not: it needs the words the user said, plus
// the separate fact that they SAID them. parseUserContent is that split.
describe('parseUserContent', () => {
  it('strips a minimal annotation and reports the turn as spoken', () => {
    expect(parseUserContent(`${MINIMAL_ANNOTATION}\n\nwhat is on my calendar`)).toEqual({
      text: 'what is on my calendar',
      origin: 'voice',
    });
  });

  it('strips one carrying stt and language attributes', () => {
    expect(parseUserContent(`${FULL_ANNOTATION}\n\nwhat is on my calendar`)).toEqual({
      text: 'what is on my calendar',
      origin: 'voice',
    });
  });

  it('strips the far_end variant, whose instruction line runs longer', () => {
    expect(parseUserContent(`${FAR_END_ANNOTATION}\n\ntransfer me to billing`)).toEqual({
      text: 'transfer me to billing',
      origin: 'voice',
    });
  });

  it('returns plain typed text byte-identical, with no origin', () => {
    const typed = 'ship it\n\n  and then tell me   what broke\n';
    expect(parseUserContent(typed)).toEqual({ text: typed });
  });

  // Prose is not plumbing. Someone asking ABOUT the annotation keeps their
  // words, and does not get a phantom `voice` marker on a turn they typed.
  it('leaves a mention of the tag in prose alone', () => {
    const asking = `why does <voice-origin transport="x"> show up in my chat log?`;
    expect(parseUserContent(asking)).toEqual({ text: asking });
  });

  it('leaves a well-formed tag alone when it is not at a block boundary', () => {
    const midline = `look at this: ${MINIMAL_ANNOTATION}\n\nweird right`;
    expect(parseUserContent(midline)).toEqual({ text: midline });
  });

  // Deliberate scope boundary: the <attachments> annotation leaks the same way,
  // but it is W3.2's contract, not this change's.
  it('preserves an <attachments> block', () => {
    const stored = `<attachments>\n  <file ref="shot-1" mime="image/png" />\n</attachments>\n\n${MINIMAL_ANNOTATION}\n\nwhat is this`;
    expect(parseUserContent(stored)).toEqual({
      text: '<attachments>\n  <file ref="shot-1" mime="image/png" />\n</attachments>\n\nwhat is this',
      origin: 'voice',
    });
  });

  it('handles an annotation with no text after it', () => {
    expect(parseUserContent(MINIMAL_ANNOTATION)).toEqual({ text: '', origin: 'voice' });
  });
});
