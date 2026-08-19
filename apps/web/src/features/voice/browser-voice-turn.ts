import { rpc } from '../../rpc';

// The batch-RPC fallback tier's `BatchVoiceCallDeps.runAgentTurn` — the
// default `talk-mode-client.ts` wires in when no test double overrides it.
// Replaces `chat-voice-runner.ts`'s `runVoiceAgentTurn`, which drove the
// spoken turn through the CHAT session's own send + SSE stream. That was the
// bug: a batch-fallback call wrote its turns into the typed chat session's
// history, never a voice lane of its own — the exact anti-pattern
// `plan/phases/voice-live-personality.md` §7 "Conflict 1" locks against
// ("spoken turns live on a separate voice lane... chat view is a spectator").
//
// This runs the turn against `voice.runTurn` instead, which drives
// `AgentLoop` on the SAME browser voice lane
// (`voice:<botKey>:browser:<sessionId>`) a streaming connection for this
// chat session would use (`browser-voice-session.ts`'s
// `browserVoiceLaneKey`) — never the chat session.
//
// Browser-only wiring (imports the RPC client directly); the batch client's
// core loop is unit-tested with a fake `runAgentTurn`
// (`talk-mode-client.test.ts`, `talk-mode-regression-pin.test.ts`), so this
// glue is verified manually rather than in CI — same posture
// `chat-voice-runner.ts` had.

export interface BrowserVoiceTurnDeps {
  /** The voice lane's own id — NOT the chat session id. `talk-mode-client.ts`
   *  resolves this once per call: the chat session id when one exists, or a
   *  client-minted fallback id held for the call's lifetime otherwise (mirrors
   *  the streaming lane's own `hello.sessionId` fallback). */
  sessionId: () => string;
  personalityId?: string;
}

/**
 * One RPC call per turn (unlike the streaming lane's per-sentence chunks) —
 * the reply arrives as ONE unit rather than incrementally as the LLM
 * streams. `runAgentTurn`'s `AsyncIterable<string>` contract still splits it
 * into sentences downstream (`batch-voice-call-client.ts`'s
 * `splitSentences`), so synthesis still pipelines sentence by sentence; what
 * is lost is starting synthesis on the FIRST sentence before the LLM has
 * finished the reply. Acceptable here: the batch tier is already the
 * reduced-capability fallback for a browser that cannot stream audio at all.
 */
export async function* runBrowserVoiceTurn(
  text: string,
  signal: AbortSignal,
  deps: BrowserVoiceTurnDeps,
): AsyncIterable<string> {
  if (signal.aborted) return;
  const result = await rpc.voice.runTurn(
    {
      text,
      sessionId: deps.sessionId(),
      ...(deps.personalityId ? { personalityId: deps.personalityId } : {}),
    },
    { signal },
  );
  if (signal.aborted || !result.reply) return;
  yield result.reply;
}
