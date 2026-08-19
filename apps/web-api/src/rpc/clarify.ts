import { os } from './context';

// Thin RPC shell for the clarify namespace. Resolves a pending clarify
// request registered by the `clarify` tool; the request side flows out over
// SSE (`clarify.request`) and the resolution back over SSE (`clarify.resolved`)
// so every tab on the session sees the card collapse. Mirrors `tools.approve`.
//
// The `requestId` is an opaque random UUID only surfaced to browsers
// subscribed to the owning session's SSE stream — the same reachability
// posture as `approvalId` in the tool-approval transport.

export const clarifyRouter = {
  respond: os.clarify.respond.handler(async ({ input, context }) => {
    // D7 — a human acted on this surface; a background job's next question
    // may route here instead of always falling back to its origin lane.
    context.clarifyBridge?.recordPresence('web');
    await context.clarifyBridge?.respond({
      requestId: input.requestId,
      answer: input.answer,
      source: input.source,
    });
    return { ok: true as const };
  }),
};
