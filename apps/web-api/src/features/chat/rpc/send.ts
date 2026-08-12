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
