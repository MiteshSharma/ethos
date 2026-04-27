import { os } from './context';

// Thin RPC shells for the chat namespace. `chat.send` is fire-and-forget —
// the actual streamed response lands on SSE at /sse/sessions/:sessionId.

export const chatRouter = {
  send: os.chat.send.handler(({ input, context }) =>
    context.chat.send({
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      clientId: input.clientId,
      text: input.text,
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
    }),
  ),

  abort: os.chat.abort.handler(async ({ input, context }) => {
    await context.chat.abort(input.sessionId);
    return { ok: true as const };
  }),
};
