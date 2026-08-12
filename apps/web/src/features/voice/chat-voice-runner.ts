import { subscribeToSession } from '../../sse';

// Binds `createBatchVoiceCallClient`'s `runAgentTurn` to the EXISTING chat send +
// stream, so a spoken turn is a first-class turn in the active chat session:
// same session id, same personality, same persisted history as typing. The user
// utterance goes in via the chat hook's `sendMessage` (optimistic bubble + the
// normal streamed assistant reply into the chat view); this taps the same
// session SSE to also surface the reply text to the voice client for TTS.
//
// Browser-only wiring (uses EventSource via `subscribeToSession`); the client's
// core loop is unit-tested with a fake `runAgentTurn`, so this glue is verified
// manually rather than in CI.

export interface ChatVoiceRunnerDeps {
  /** The active chat session id, read lazily (it can change between turns). */
  sessionId: () => string | null;
  /**
   * The chat hook's send — drives the optimistic user bubble + streamed reply.
   * The third argument marks the turn as SPOKEN so the server annotates it; a
   * runner that omits it would produce a turn indistinguishable from typing,
   * which is the failure this exists to prevent.
   */
  sendMessage: (
    text: string,
    attachments?: undefined,
    opts?: { origin?: 'text' | 'voice' },
  ) => Promise<void>;
  /** Abort the running chat turn (barge-in / hang-up stops the agent server-side). */
  abortTurn: () => Promise<void>;
}

interface ReplyTap {
  stream: AsyncIterable<string>;
  close: () => void;
}

// Subscribe to a session's SSE and expose its assistant reply text as an async
// iterable of `text_delta`s. Subscribes eagerly (buffers) so no early delta is
// missed while `sendMessage` is in flight. Falls back to the `done` event's full
// text if no deltas were seen (e.g. a late subscribe on a just-created session).
function tapSessionReply(sessionId: string): ReplyTap {
  const queue: string[] = [];
  let doneText = '';
  let done = false;
  let wake: (() => void) | null = null;

  const notify = (): void => {
    const resume = wake;
    wake = null;
    resume?.();
  };

  const sub = subscribeToSession(sessionId, {
    onEvent: (event) => {
      if (event.type === 'text_delta') {
        queue.push(event.text);
        notify();
      } else if (event.type === 'done') {
        doneText = event.text;
        done = true;
        notify();
      } else if (event.type === 'error') {
        done = true;
        notify();
      }
    },
  });

  const stream = (async function* (): AsyncGenerator<string> {
    let anyYielded = false;
    while (true) {
      const next = queue.shift();
      if (next !== undefined) {
        anyYielded = true;
        yield next;
        continue;
      }
      if (done) {
        if (!anyYielded && doneText) yield doneText;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();

  return { stream, close: () => sub.close() };
}

export async function* runVoiceAgentTurn(
  text: string,
  signal: AbortSignal,
  deps: ChatVoiceRunnerDeps,
): AsyncIterable<string> {
  if (signal.aborted) return;

  const onAbort = (): void => {
    void deps.abortTurn();
  };
  signal.addEventListener('abort', onAbort, { once: true });

  // Subscribe before sending when a session already exists (no missed deltas);
  // otherwise subscribe to the id the send creates.
  const existingId = deps.sessionId();
  let tap = existingId ? tapSessionReply(existingId) : null;

  // `sendMessage` resolves only when the ENTIRE turn completes, so awaiting it
  // before consuming the tap would buffer every delta and yield them all at the
  // end. When the tap is already open (existing session, the common case), fire
  // the send WITHOUT awaiting and consume the tap concurrently, so each delta is
  // yielded as it streams in. The send is settled after the loop.
  let sendPromise: Promise<void> | null = null;

  try {
    if (tap) {
      sendPromise = deps.sendMessage(text, undefined, { origin: 'voice' });
    } else {
      // No existing session: await the send to learn the created id, then tap.
      await deps.sendMessage(text, undefined, { origin: 'voice' });
      const createdId = deps.sessionId();
      if (createdId) tap = tapSessionReply(createdId);
    }
    if (!tap) return;
    for await (const chunk of tap.stream) {
      if (signal.aborted) break;
      yield chunk;
    }
  } finally {
    // Settle the un-awaited send so a rejection isn't unhandled. The stream's
    // end is driven by SSE 'done'/'error', not by this promise; a transport
    // failure surfaces via the SSE 'error' path, so we only swallow here.
    await sendPromise?.catch(() => {});
    tap?.close();
    signal.removeEventListener('abort', onAbort);
  }
}
