/**
 * TUI `/personality <id>` must rotate the session key.
 *
 * A session's personality is bound at creation and immutable — a turn naming a
 * different personality for an already-bound session is refused with
 * `personality_locked`. So the TUI's personality switch has to start a NEW
 * session, exactly like the CLI's `/personality` does.
 *
 * The App is driven the way a user drives it: real Ink render over a fake
 * stdin/stdout, real AgentBridge over a real AgentLoop with an in-memory
 * session store and a stub LLM.
 */

import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { AgentBridge } from '@ethosagent/agent-bridge';
import { AgentLoop, InMemorySessionStore } from '@ethosagent/core';
import type { CompletionChunk, LLMProvider } from '@ethosagent/types';
import { render } from 'ink';
import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { createTestSafety } from '../../../../packages/core/src/__tests__/helpers/test-safety';
import { App } from '../components/App';

class FakeStdout extends EventEmitter {
  columns = 100;
  rows = 40;
  write(): boolean {
    return true;
  }
}

function makeStdin() {
  const s = new PassThrough() as PassThrough & {
    isTTY: boolean;
    setRawMode: () => void;
    ref: () => void;
    unref: () => void;
  };
  s.isTTY = true;
  s.setRawMode = () => {};
  s.ref = () => {};
  s.unref = () => {};
  return s;
}

function makeStubLLM(): LLMProvider {
  return {
    name: 'stub',
    model: 'stub-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(): AsyncIterable<CompletionChunk> {
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/** Poll until `predicate` holds, or fail after `timeoutMs`. */
async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for: ${label}`);
}

describe('TUI /personality', () => {
  it('rotates the session key so the new personality binds to a fresh session', async () => {
    const session = new InMemorySessionStore();
    const loop = new AgentLoop({ llm: makeStubLLM(), session, safety: createTestSafety() });
    const bridge = new AgentBridge(loop);
    const errors: string[] = [];
    bridge.on('error', (_error, code) => errors.push(code));

    const stdout = new FakeStdout();
    const stdin = makeStdin();
    const initialSessionKey = 'cli:tui-personality-test';
    const instance = render(
      createElement(App, {
        bridge,
        model: 'stub-model',
        initialPersonality: 'researcher',
        initialSessionKey,
      }),
      {
        stdout: stdout as never,
        stdin: stdin as never,
        stderr: stdout as never,
        debug: true,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    );

    try {
      const type = async (text: string) => {
        stdin.write(text);
        await new Promise((r) => setTimeout(r, 30));
        stdin.write('\r');
        await new Promise((r) => setTimeout(r, 30));
      };

      // Turn 1 binds the original session to `researcher`.
      await type('first');
      await waitFor(async () => {
        const s = await session.getSessionByKey(initialSessionKey);
        return s !== null && (await session.getMessages(s.id)).some((m) => m.content === 'first');
      }, 'first turn recorded');

      // Switch, then take a turn as the new personality.
      await type('/personality engineer');
      await type('second');
      await waitFor(async () => (await session.listSessions()).length === 2, 'second session');

      const sessions = await session.listSessions();
      const original = sessions.find((s) => s.key === initialSessionKey);
      const rotated = sessions.find((s) => s.key !== initialSessionKey);
      if (!original || !rotated) throw new Error('expected an original and a rotated session');

      // The key rotated, and the new personality is applied to the new session.
      expect(rotated.key).not.toBe(initialSessionKey);
      expect(rotated.key.startsWith('cli:')).toBe(true);
      expect(rotated.personalityId).toBe('engineer');
      expect(original.personalityId).toBe('researcher');

      // The switch was not refused, and the transcripts did not mix.
      expect(errors).not.toContain('personality_locked');
      const rotatedMessages = await session.getMessages(rotated.id);
      expect(rotatedMessages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
        'second',
      ]);
      const originalMessages = await session.getMessages(original.id);
      expect(originalMessages.filter((m) => m.role === 'user').map((m) => m.content)).toEqual([
        'first',
      ]);
    } finally {
      instance.unmount();
    }
  });
});
