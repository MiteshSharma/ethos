// Subagent task contract.
//
// The delegated task lives in the child's FIRST USER MESSAGE. Never the system
// prompt. Never a memory record an injector then pulls into the system prompt.
//
// This is an end-to-end regression test, not a unit test: a real `AgentLoop`
// runs the parent, the parent calls `delegate_task` with a known marker, the
// tool spawns a child loop, and we capture every `LLMProvider.complete()`
// request from BOTH parent and child. The assertion site is the final
// `system` field on each request — construction-time-only checks would miss
// memory/skill injection that re-injects the task at any turn.
//
// The test passes on the current implementation. It would fail on a
// deliberately-broken variant that copied the prompt into the system prompt
// directly OR into a memory record that the `## Memory` injector then merges
// into the system prompt. Both scenarios fall under assertion (a) below.

import { AgentLoop, DefaultToolRegistry } from '@ethosagent/core';
import type { CompletionChunk, LLMProvider, Message } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createDelegateTaskTool } from '../index';

const MARKER = 'PINEAPPLE-MARKER-30-1';

interface CapturedRequest {
  system?: string;
  messages: Message[];
}

function countMarkerOccurrences(text: string): number {
  // Simple substring count; the marker is fixed and has no regex-special chars.
  let count = 0;
  let from = 0;
  while (true) {
    const idx = text.indexOf(MARKER, from);
    if (idx < 0) return count;
    count++;
    from = idx + MARKER.length;
  }
}

describe('subagent task contract — task lives only in child first user message', () => {
  it('PINEAPPLE-MARKER never appears in any system prompt and exactly once across user messages (in child loop)', async () => {
    const seen: CapturedRequest[] = [];
    let llmCall = 0;

    const llm: LLMProvider = {
      name: 'mock',
      model: 'mock-model',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(messages, _tools, opts): AsyncIterable<CompletionChunk> {
        // Snapshot synchronously — the loop reuses message arrays across turns.
        seen.push({
          system: opts.system,
          messages: JSON.parse(JSON.stringify(messages)) as Message[],
        });
        llmCall++;

        if (llmCall === 1) {
          // Parent turn 1 → call delegate_task with the marker as the prompt.
          yield { type: 'tool_use_start', toolCallId: 'd1', toolName: 'delegate_task' };
          yield {
            type: 'tool_use_end',
            toolCallId: 'd1',
            inputJson: JSON.stringify({ prompt: `${MARKER} summarise the situation` }),
          };
          yield { type: 'done', finishReason: 'tool_use' };
        } else if (llmCall === 2) {
          // Child turn 1 → respond with plain text. The child's first user
          // message must contain the marker (asserted below).
          yield { type: 'text_delta', text: 'sub-agent response' };
          yield { type: 'done', finishReason: 'end_turn' };
        } else {
          // Parent turn 2 (after tool_result) → end the conversation.
          yield { type: 'text_delta', text: 'parent done' };
          yield { type: 'done', finishReason: 'end_turn' };
        }
      },
      async countTokens() {
        return 1;
      },
    };

    const tools = new DefaultToolRegistry();
    const loop = new AgentLoop({ llm, tools });
    tools.register(createDelegateTaskTool(loop));

    for await (const _event of loop.run('parent kickoff prompt')) {
      // drain
    }

    // (a) System prompt MUST NEVER carry the task marker — for ANY request,
    //     parent or child. This catches both broken variants: task copied
    //     directly into system, OR task copied into a memory record that the
    //     memory injector merges into system.
    for (const req of seen) {
      expect(req.system ?? '', 'task marker must never appear in any system prompt').not.toContain(
        MARKER,
      );
    }

    // (b) Marker appears exactly ONCE across all user-role messages, and that
    //     occurrence is the FIRST user message of the child loop's first
    //     `complete()` call.
    let userMarkerCount = 0;
    for (const req of seen) {
      for (const msg of req.messages) {
        if (msg.role !== 'user') continue;
        const text = typeof msg.content === 'string' ? msg.content : '';
        userMarkerCount += countMarkerOccurrences(text);
      }
    }
    expect(
      userMarkerCount,
      'task marker must appear exactly once across user-role messages — in the child first user message',
    ).toBe(1);

    // The child's first complete() call is the second `seen` entry (parent
    // went first to invoke delegate_task). Its first user message must carry
    // the marker.
    const childRequest = seen[1];
    expect(
      childRequest,
      'expected the child loop to issue at least one complete() call',
    ).toBeDefined();
    const firstChildUser = childRequest?.messages.find((m) => m.role === 'user');
    expect(firstChildUser, 'child must have a user message').toBeDefined();
    const firstUserText = typeof firstChildUser?.content === 'string' ? firstChildUser.content : '';
    expect(firstUserText).toContain(MARKER);
  });
});
