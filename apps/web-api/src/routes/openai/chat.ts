import { randomUUID } from 'node:crypto';
import { EthosError } from '@ethosagent/types';
import { type Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { CompletionsService } from '../../features/completions/service';
import { openAiErrorBody } from '../../middleware/bearer-auth';
import type { PersonalitiesService } from '../../services/personalities.service';
import { type ChatCompletionRequest, ChatCompletionRequestSchema } from './schemas';

// `POST /v1/chat/completions` — F3 (non-streaming) + F4 (streaming SSE).
// Server-tools mode only; client-tools mode and team routing are explicit
// non-goals here (C1 + W1).

export interface OpenAiChatRouteOptions {
  completions: CompletionsService;
  personalities: PersonalitiesService;
}

export function openAiChatRoutes(opts: OpenAiChatRouteOptions): Hono {
  const app = new Hono();

  app.post('/completions', async (c) => {
    // 1. Parse body. Zod failures produce a precise 400 with OpenAI envelope.
    const raw = await c.req.json().catch(() => null);
    const parse = ChatCompletionRequestSchema.safeParse(raw);
    if (!parse.success) {
      const first = parse.error.issues[0];
      return c.json(
        openAiErrorBody({
          message: first
            ? `${first.path.join('.') || 'body'}: ${first.message}`
            : 'invalid request body',
          type: 'invalid_request_error',
          code: 'invalid_request_body',
          param: first?.path[0]?.toString() ?? null,
        }),
        400,
      );
    }
    const req = parse.data;

    // 2. Reject features that land in later PRs. Loud rejection beats silent
    //    drop — clients see immediately that they need the next release.
    const rejection = rejectUnsupported(req);
    if (rejection) {
      return c.json(
        openAiErrorBody({
          message: rejection.message,
          type: 'invalid_request_error',
          code: rejection.code,
          param: rejection.param ?? null,
        }),
        400,
      );
    }

    // 3. Resolve `model` → personalityId per principle #2.
    const resolved = await resolveModel(req.model, opts.personalities);
    if (resolved.kind === 'team') {
      return c.json(
        openAiErrorBody({
          message: 'Team routing lands in W1. Use a personality id or `ethos-default` for now.',
          type: 'invalid_request_error',
          code: 'team_routing_not_implemented',
          param: 'model',
        }),
        400,
      );
    }
    if (resolved.kind === 'unknown') {
      return c.json(
        openAiErrorBody({
          message: `Model "${req.model}" not found. Use \`GET /v1/models\` to list available ids.`,
          type: 'invalid_request_error',
          code: 'model_not_found',
          param: 'model',
        }),
        404,
      );
    }

    // 4. Collect best-effort warnings (e.g. vision content without capability check).
    const warnings = collectWarnings(req);
    if (warnings.length > 0) c.header('x-ethos-warning', warnings.join('; '));

    const rawSessionKey = c.req.header('x-ethos-session') ?? c.req.header('X-Ethos-Session');
    // Scope the session key to the authenticated API key so sessions cannot
    // be resumed cross-key. The apiKey record is stamped by bearer-auth
    // middleware; its `id` is a stable UUID per key.
    const apiKeyRecord = c.get('apiKey');
    const sessionKeyOverride =
      rawSessionKey && apiKeyRecord ? `${apiKeyRecord.id}:${rawSessionKey}` : rawSessionKey;

    const input = {
      req,
      personalityId: resolved.personalityId,
      ...(sessionKeyOverride ? { sessionKeyOverride } : {}),
    };

    // 5. Branch: streaming vs JSON.
    if (req.stream === true) {
      return streamCompletion(c, opts.completions, input);
    }
    try {
      const result = await opts.completions.complete(input);
      return c.json(result);
    } catch (err) {
      return jsonError(c, err);
    }
  });

  return app;
}

function streamCompletion(
  c: Context,
  service: CompletionsService,
  input: Parameters<CompletionsService['stream']>[0],
): Response {
  return streamSSE(c, async (stream) => {
    const controller = new AbortController();
    stream.onAbort(() => controller.abort());
    try {
      for await (const chunk of service.stream({ ...input, abortSignal: controller.signal })) {
        await stream.writeSSE({ data: JSON.stringify(chunk) });
        if (controller.signal.aborted) return;
      }
      await stream.writeSSE({ data: '[DONE]' });
    } catch (err) {
      // Emit OpenAI-shaped error then close. SDK clients surface this as a
      // stream error rather than a malformed JSON parse. Never reflect raw
      // error.message — it may contain internal paths or stack traces.
      const requestId = randomUUID();
      console.error('[stream_failed]', requestId, err);
      const env = openAiErrorBody({
        message: 'Internal server error',
        type: 'server_error',
        code: 'stream_failed',
        request_id: requestId,
      });
      await stream.writeSSE({ data: JSON.stringify(env) });
      await stream.writeSSE({ data: '[DONE]' });
    }
  });
}

function jsonError(c: Context, err: unknown): Response {
  // EthosError with INVALID_INPUT is an intentionally user-facing message.
  if (err instanceof EthosError && err.code === 'INVALID_INPUT') {
    return c.json(
      openAiErrorBody({
        message: err.cause,
        type: 'invalid_request_error',
        code: 'invalid_request_body',
      }),
      400,
    );
  }
  // For unexpected errors, never reflect raw error.message to the client —
  // it may contain internal paths, stack traces, or database errors.
  const requestId = randomUUID();
  console.error('[internal_error]', requestId, err);
  return c.json(
    openAiErrorBody({
      message: 'Internal server error',
      type: 'server_error',
      code: 'internal_error',
      request_id: requestId,
    }),
    500,
  );
}

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

type Resolved =
  | { kind: 'personality'; personalityId: string | undefined }
  | { kind: 'team' }
  | { kind: 'unknown' };

async function resolveModel(model: string, personalities: PersonalitiesService): Promise<Resolved> {
  if (model.startsWith('team:')) return { kind: 'team' };
  if (model === 'ethos-default') {
    return { kind: 'personality', personalityId: undefined };
  }
  const found = (await personalities.list()).items.find((p) => p.id === model);
  if (!found) return { kind: 'unknown' };
  return { kind: 'personality', personalityId: model };
}

// ---------------------------------------------------------------------------
// Validation + warnings
// ---------------------------------------------------------------------------

interface Rejection {
  message: string;
  code: string;
  param?: string;
}

function hasImageContent(req: ChatCompletionRequest): boolean {
  return req.messages.some(
    (msg) =>
      Array.isArray(msg.content) &&
      msg.content.some(
        (part) => typeof part === 'object' && 'type' in part && part.type === 'image_url',
      ),
  );
}

function rejectUnsupported(req: ChatCompletionRequest): Rejection | null {
  for (const msg of req.messages) {
    if (msg.role === 'system') {
      return {
        message:
          'System messages are not supported. The personality owns the system prompt. ' +
          'Configure the personality (SOUL.md, config.yaml) instead of overriding per-request.',
        code: 'system_messages_not_supported',
        param: 'messages',
      };
    }
  }
  if (req.tools && req.tools.length > 0) {
    return {
      message:
        'Client-side `tools` are not supported. Ethos runs tools server-side — the ' +
        "personality's toolset decides what the agent can call. Turn off tool/function " +
        'calling in your client and omit the `tools` field.',
      code: 'client_tools_not_implemented',
      param: 'tools',
    };
  }
  for (const msg of req.messages) {
    if (msg.role === 'tool') {
      return {
        message:
          '`role: "tool"` messages are not supported. Ethos executes tools server-side, so ' +
          'there are no client tool results to send back. Turn off tool/function calling in ' +
          'your client and send only `user` and `assistant` messages.',
        code: 'client_tools_not_implemented',
        param: 'messages',
      };
    }
    if (msg.role === 'assistant' && msg.tool_calls && msg.tool_calls.length > 0) {
      return {
        message:
          '`assistant.tool_calls` is not supported. Ethos runs tools server-side and never ' +
          'returns tool calls to the client. Turn off tool/function calling in your client ' +
          'and drop `tool_calls` from the assistant messages.',
        code: 'client_tools_not_implemented',
        param: 'messages',
      };
    }
  }
  return null;
}

function collectWarnings(req: ChatCompletionRequest): string[] {
  const out: string[] = [];
  if (hasImageContent(req)) {
    out.push('image_url content parts accepted but vision support depends on the personality');
  }
  return out;
}
