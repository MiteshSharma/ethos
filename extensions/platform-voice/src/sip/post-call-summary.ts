// Post-call summary — on call end, summarize the conversation and post it to a
// paired text channel (plan/phases/gap-voice-realtime.md §4 Phase C).
//
// The summary flows through `adapter.sendArtifactMessage()` -> the injected
// `sendArtifact` sink, which in production is the gateway's single deduped
// `send()` gate (MessageDedupCache). This is the SAME path every outbound
// channel message uses — NEVER a new adapter-local dedup layer (see the adapter
// README dedup boundary note).

import type { VoiceChannelAdapter } from '../adapter';

export interface PostCallSummaryDeps {
  /**
   * Custom summarizer over the honest played transcript. Defaults to a
   * deterministic one-line summary; an LLM-backed summarizer can be injected
   * here without changing the send path.
   */
  summarize?: (input: { callerId: string; lastReplyText: string }) => string | Promise<string>;
  /**
   * Alternative delivery, used INSTEAD of `adapter.sendArtifactMessage()`.
   *
   * The difference matters: `sendArtifactMessage` stops a DOUBLE send (dedup),
   * but nothing stops a LOST one — and the summary is the only durable record
   * of a call the operator did not hear. An app supplying `deliver` routes it
   * through the delivery ledger instead, which writes a `pending` obligation
   * before the platform call and confirms it only on `ok: true`, so a summary
   * that fails to send is redelivered rather than silently dropped on hang-up.
   * Dedup still applies downstream — the ledger sits in front of the same gate.
   */
  deliver?: (summary: { laneKey: string; callerId: string; text: string }) => Promise<void>;
  /**
   * Where a summarizer or delivery failure is reported. The handler itself
   * NEVER throws: it runs on the hang-up path, often from a transport callback
   * with no caller to catch it, and a failed summary must not take the call
   * teardown down with it.
   */
  onError?: (err: unknown) => void;
}

/**
 * Returns a call-end handler that builds a summary from the adapter's honest
 * transcript (`lastReplyText()` — includes the `[interrupted]` marker on
 * barge-in) and posts it via `deliver` when supplied, otherwise via
 * `adapter.sendArtifactMessage()`. A no-op (from the adapter's side) when no
 * `sendArtifact` sink was wired.
 */
export function createPostCallSummary(
  deps: PostCallSummaryDeps = {},
): (adapter: VoiceChannelAdapter) => Promise<void> {
  return async (adapter: VoiceChannelAdapter): Promise<void> => {
    try {
      const lastReplyText = adapter.lastReplyText();
      const text = deps.summarize
        ? await deps.summarize({ callerId: adapter.callerId, lastReplyText })
        : defaultCallSummary(adapter.callerId, lastReplyText);
      if (deps.deliver) {
        await deps.deliver({ laneKey: adapter.laneKey, callerId: adapter.callerId, text });
      } else {
        await adapter.sendArtifactMessage(text);
      }
    } catch (err) {
      deps.onError?.(err);
    }
  };
}

function defaultCallSummary(callerId: string, lastReplyText: string): string {
  const body = lastReplyText.trim() || '(no reply was spoken)';
  return `Call summary — ${callerId}: ${body}`;
}
