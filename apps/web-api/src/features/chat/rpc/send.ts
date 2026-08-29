import { os } from '../../../rpc/context';

/**
 * B1/B3 — read the `x-request-id` the Hono layer threaded onto the oRPC
 * context (routes/rpc.ts), same shape as the `_mcp*` properties documented in
 * rpc/mcp.ts. The cast is the established idiom here: widening the oRPC
 * context type for a transport-level field would push HTTP concerns into every
 * service signature.
 */
function requestId(context: object): string | undefined {
  const value: unknown = (context as { _requestId?: unknown })._requestId;
  return typeof value === 'string' ? value : undefined;
}

export const chatSend = os.chat.send.handler(({ input, context }) => {
  const reqId = requestId(context);
  // Fix 5 (pi-delegation.md D7) — an ordinary chat message establishes
  // presence too, not just answering a clarify (mirrors `clarify.ts`'s
  // `recordPresence('web')` on `respond()`). Otherwise a background job's
  // later question only ever routes to wherever the human last happened to
  // answer a clarify, never to wherever they're just casually chatting. Web
  // has no per-request chat identity beyond the session itself, so no
  // `surfaceContext` — same as the clarify RPC.
  context.clarifyBridge?.recordPresence('web');
  return context.chat.send({
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    clientId: input.clientId,
    ...(reqId ? { requestId: reqId } : {}),
    text: input.text,
    ...(input.personalityId ? { personalityId: input.personalityId } : {}),
    ...(input.dryRun ? { dryRun: true } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
  });
});
