import { randomUUID } from 'node:crypto';
import type { AgentEvent, AgentLoop } from '@ethosagent/core';
import { createEventTranslator, type EventTranslator } from '@ethosagent/surface-kit';
import { type Attachment, EthosError } from '@ethosagent/types';
import type {
  ChatCompletionChunk,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMessage,
  ContentPart,
} from '../../routes/openai/schemas';
import type { ChatDefaults } from '../chat/service';
import type { CompletionsRepository } from './repository';

// F3 + F4 — drives `POST /v1/chat/completions`. Thinner than `ChatService`:
// no AgentBridge, no SSE replay buffer. Each request creates an ephemeral
// session (or resumes a stateful one via `X-Ethos-Session`), drives
// `AgentLoop.run`, and translates events into the OpenAI shape.
//
// Tool calls and team routing are explicit non-goals here — those land in
// C1 and W1. The route layer rejects those requests before they reach the
// service.

export interface CompletionsServiceOptions {
  loop: AgentLoop;
  sessions: CompletionsRepository;
  defaults: ChatDefaults;
  /** `now()` is injected so tests can pin the `created` timestamp + chat id seed. */
  now?: () => Date;
  /** Same — overridable so tests can assert deterministic ids. */
  newId?: () => string;
  /**
   * Optional refresh closure — reloads the loop's personality registry from
   * disk before a completion runs, so a hot-dropped or edited personality
   * resolves without a server restart. Absent → no refresh.
   */
  refreshPersonalities?: () => Promise<void>;
}

export interface CompletionsInput {
  req: ChatCompletionRequest;
  /**
   * Personality id to drive the loop with. `undefined` means "use the
   * registry default" — the route layer resolves `ethos-default` to that.
   */
  personalityId: string | undefined;
  /**
   * Opaque session id from `X-Ethos-Session`. When set, the session is
   * resumed (or created on first call with that id) and only the final
   * user message of `req.messages` is treated as new input. When unset,
   * a fresh ephemeral session is created and prior messages are
   * pre-populated.
   */
  sessionKeyOverride?: string;
  abortSignal?: AbortSignal;
  /** Warnings already collected by the route layer (e.g. dropped system msgs). */
  warnings?: string[];
}

export class CompletionsService {
  constructor(private readonly opts: CompletionsServiceOptions) {}

  async complete(input: CompletionsInput): Promise<ChatCompletionResponse> {
    const { sessionKey, lastUserText, attachments } = await this.prepareSession(input);
    const translator = createEventTranslator();

    for await (const event of this.driveLoop({
      sessionKey,
      lastUserText,
      personalityId: input.personalityId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.req.temperature !== undefined ? { temperature: input.req.temperature } : {}),
      ...(input.req.top_p !== undefined ? { topP: input.req.top_p } : {}),
      ...(input.req.max_tokens !== undefined ? { maxCompletionTokens: input.req.max_tokens } : {}),
      ...(input.req.seed !== undefined ? { seed: input.req.seed } : {}),
      ...(attachments?.length ? { attachments } : {}),
    })) {
      translator.push(event);
      if (translator.error) throw loopFailure(translator.error);
    }

    return {
      id: `chatcmpl-${this.id()}`,
      object: 'chat.completion',
      created: this.unixNow(),
      model: input.req.model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: translator.text },
          finish_reason: finishReason(translator),
        },
      ],
      usage: {
        prompt_tokens: translator.usage.inputTokens,
        completion_tokens: translator.usage.outputTokens,
        total_tokens: translator.usage.inputTokens + translator.usage.outputTokens,
      },
    };
  }

  async *stream(input: CompletionsInput): AsyncGenerator<ChatCompletionChunk> {
    const { sessionKey, lastUserText, attachments } = await this.prepareSession(input);
    const id = `chatcmpl-${this.id()}`;
    const created = this.unixNow();
    const model = input.req.model;

    let yieldedRole = false;
    const translator = createEventTranslator();

    for await (const event of this.driveLoop({
      sessionKey,
      lastUserText,
      personalityId: input.personalityId,
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.req.temperature !== undefined ? { temperature: input.req.temperature } : {}),
      ...(input.req.top_p !== undefined ? { topP: input.req.top_p } : {}),
      ...(input.req.max_tokens !== undefined ? { maxCompletionTokens: input.req.max_tokens } : {}),
      ...(input.req.seed !== undefined ? { seed: input.req.seed } : {}),
      ...(attachments?.length ? { attachments } : {}),
    })) {
      translator.push(event);
      if (event.type === 'text_delta') {
        const delta: ChatCompletionChunk['choices'][0]['delta'] = yieldedRole
          ? { content: event.text }
          : { role: 'assistant', content: event.text };
        yieldedRole = true;
        yield {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta, finish_reason: null }],
        };
      } else if (translator.error) {
        throw loopFailure(translator.error);
      }
    }

    // Final chunk — empty delta + finish_reason terminator. OpenAI clients
    // gate on this. Same derivation as the non-streaming path.
    yield {
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finishReason(translator) }],
    };

    // Optional usage chunk — only when the client opted in. OpenAI's docs
    // show it as the absolute last data frame, with `choices: []`.
    if (input.req.stream_options?.include_usage) {
      yield {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage: {
          prompt_tokens: translator.usage.inputTokens,
          completion_tokens: translator.usage.outputTokens,
          total_tokens: translator.usage.inputTokens + translator.usage.outputTokens,
        },
      };
    }
  }

  /**
   * Refuse a request whose `model` selects a different personality than the
   * session pinned by `X-Ethos-Session` is bound to.
   *
   * A session's personality is bound at creation and immutable thereafter
   * (enforced in `setupTurn`). Stateful mode is the one place an OpenAI client
   * restates BOTH on every call — the session id in a header, the personality
   * in `model` — so the two can disagree from the second request onward. The
   * loop refuses that turn; catching it here turns the refusal into a request
   * error the caller can act on, and lets the streaming route answer before it
   * opens the SSE stream (once `streamSSE` starts, the status is pinned at 200
   * and only a `server_error` frame is left to say it with).
   *
   * Call this BEFORE `complete`/`stream`. Stateless requests and
   * `model: ethos-default` (no personality selector) can never conflict.
   */
  async assertPersonalityUnlocked(input: CompletionsInput): Promise<void> {
    if (!input.sessionKeyOverride || !input.personalityId) return;
    const session = await this.opts.sessions.getSessionByKey(`openai:${input.sessionKeyOverride}`);
    const bound = session?.personalityId;
    if (!bound || bound === input.personalityId) return;
    throw new EthosError({
      code: 'INVALID_INPUT',
      cause:
        `This session is already bound to personality "${bound}". A session's personality ` +
        `cannot be changed — "${input.personalityId}" would rewrite what it has already been.`,
      action:
        `Send this request as "${bound}", or start a new session for "${input.personalityId}" ` +
        'by using a different X-Ethos-Session value (or dropping the header).',
      details: { openAiCode: PERSONALITY_LOCKED_CODE },
    });
  }

  // ---------------------------------------------------------------------------
  // Session preparation
  // ---------------------------------------------------------------------------

  private async prepareSession(
    input: CompletionsInput,
  ): Promise<{ sessionKey: string; lastUserText: string; attachments?: Attachment[] }> {
    // Refresh the loop's personality registry from disk before the turn runs so
    // a hot-dropped or edited personality resolves without a restart. No-op when
    // no closure is wired (tests, embedders). Fail-open: a refresh that throws
    // (e.g. malformed personality YAML on disk) must not abort the turn — serve
    // the last-good registry (stale-but-alive beats a dead turn).
    try {
      await this.opts.refreshPersonalities?.();
    } catch (err) {
      console.warn(
        `[completions] personality refresh failed (serving last-good): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const lastUser = finalUserMessage(input.req.messages);
    if (!lastUser) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'messages must end with a `user` message.',
        action: 'Place the user prompt last in the messages array.',
      });
    }

    const attachments = lastUser.attachments;

    // Stateful mode — opt-in via `X-Ethos-Session`. Server-side history wins;
    // we only feed in the latest user text. Prior messages from the request
    // are ignored. (Per-message verification is a future enhancement.)
    if (input.sessionKeyOverride) {
      return {
        sessionKey: `openai:${input.sessionKeyOverride}`,
        lastUserText: lastUser.text,
        ...(attachments?.length ? { attachments } : {}),
      };
    }

    // Stateless mode — fresh ephemeral session, pre-populated with the
    // prior user/assistant turns so the LLM sees the full conversation.
    const sessionKey = `openai:ephem:${randomUUID()}`;
    const prior = priorTextMessages(input.req.messages, lastUser.index);
    if (prior.length === 0) {
      // No history to inject — AgentLoop will create the session lazily
      // on its first `getSessionByKey ?? createSession`.
      return {
        sessionKey,
        lastUserText: lastUser.text,
        ...(attachments?.length ? { attachments } : {}),
      };
    }
    const created = await this.opts.sessions.createSession({
      key: sessionKey,
      platform: 'openai',
      model: this.opts.defaults.model,
      provider: this.opts.defaults.provider,
      // Bind the personality at creation. Without it the loop would find an
      // unbound row on the very next line and bind it as a legacy session —
      // same outcome, but only by way of the compatibility path.
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      usage: zeroUsage(),
    });
    for (const msg of prior) {
      await this.opts.sessions.appendMessage({
        sessionId: created.id,
        role: msg.role,
        content: msg.text,
      });
    }
    return {
      sessionKey,
      lastUserText: lastUser.text,
      ...(attachments?.length ? { attachments } : {}),
    };
  }

  private driveLoop(input: {
    sessionKey: string;
    lastUserText: string;
    personalityId: string | undefined;
    abortSignal?: AbortSignal;
    temperature?: number;
    topP?: number;
    maxCompletionTokens?: number;
    seed?: number;
    attachments?: Attachment[];
  }): AsyncGenerator<AgentEvent> {
    const opts: Parameters<AgentLoop['run']>[1] = {
      sessionKey: input.sessionKey,
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      ...(input.abortSignal ? { abortSignal: input.abortSignal } : {}),
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.topP !== undefined ? { topP: input.topP } : {}),
      ...(input.maxCompletionTokens !== undefined
        ? { maxCompletionTokens: input.maxCompletionTokens }
        : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    };
    return this.opts.loop.run(input.lastUserText, opts);
  }

  private id(): string {
    return this.opts.newId ? this.opts.newId() : randomUUID();
  }

  private unixNow(): number {
    return Math.floor((this.opts.now ? this.opts.now() : new Date()).getTime() / 1000);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The loop's `personality_locked` refusal code, re-published as the OpenAI
 * envelope's `code`. Carried on `EthosError.details.openAiCode`, which the
 * route reads when it builds the 400 body.
 */
const PERSONALITY_LOCKED_CODE = 'personality_locked';

/**
 * Translate the loop's terminal `error` event into a thrown surface error. A
 * `personality_locked` refusal is the caller's mistake (the pinned session and
 * the requested personality disagree), so it becomes an `INVALID_INPUT` → 400
 * rather than a 500. This is the second line of defence behind
 * `assertPersonalityUnlocked`: the loop is the authority on the binding, and a
 * direct service consumer never runs the preflight.
 */
function loopFailure(err: { error: string; code: string }): EthosError {
  if (err.code === PERSONALITY_LOCKED_CODE) {
    return new EthosError({
      code: 'INVALID_INPUT',
      cause: err.error,
      action:
        "Send the request as the session's bound personality, or use a different " +
        'X-Ethos-Session value to start a new session.',
      details: { openAiCode: PERSONALITY_LOCKED_CODE },
    });
  }
  return new EthosError({
    code: 'INTERNAL',
    cause: err.error,
    action: 'Retry the request. If the error repeats, file an issue.',
  });
}

/**
 * Derive the OpenAI `finish_reason` from the folded event stream. A `halt`
 * event (tool budget tripped, or the safety watcher paused the turn) means the
 * loop cut the turn short, so the assistant text is partial — `'length'` is the
 * OpenAI-shaped way to tell the client "this answer is incomplete". Everything
 * else is `'stop'`.
 *
 * `'tool_calls'` is never returned: server-tools mode runs tools inside the
 * loop and never hands a tool call back to the client.
 *
 * The LLM's own `max_tokens` cutoff is NOT derivable here — the provider's
 * finish reason is captured for observability inside the loop but never
 * surfaced on the `AgentEvent` union, so this service cannot see it. Making
 * that case report `'length'` requires the loop to emit it (an `AgentEvent`
 * schema change, which is governed).
 */
function finishReason(translator: EventTranslator): 'stop' | 'length' {
  return translator.halt !== null ? 'length' : 'stop';
}

/**
 * The OpenAI contract is that the final message in `messages[]` is the new
 * turn the model is being asked to respond to. F3 only handles server-tools
 * mode, so the trailing message must be `user` with string content; trailing
 * `assistant` / `tool` lands in C1. Anything else is malformed — silently
 * rerunning an earlier user prompt would corrupt conversation semantics.
 *
 * Handles both plain string and array (multimodal) content. When the content
 * is an array, text parts are joined and image_url parts are translated into
 * Attachment refs so they can flow through the AgentLoop attachment pipeline.
 */
function finalUserMessage(
  messages: ChatMessage[],
): { index: number; text: string; attachments?: Attachment[] } | null {
  const lastIndex = messages.length - 1;
  const last = messages[lastIndex];
  if (last?.role !== 'user') return null;

  if (typeof last.content === 'string') {
    if (last.content.length === 0) return null;
    return { index: lastIndex, text: last.content };
  }

  if (Array.isArray(last.content)) {
    const textParts = last.content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text);
    const text = textParts.join('\n');
    if (text.length === 0) return null;

    const imageParts = last.content.filter(
      (p): p is Extract<ContentPart, { type: 'image_url' }> => p.type === 'image_url',
    );
    const attachments: Attachment[] = imageParts.map((p) => ({
      type: 'image' as const,
      ref: p.image_url.url,
      url: p.image_url.url,
      mimeType: 'image/png', // default; actual type determined at fetch time
    }));

    return { index: lastIndex, text, ...(attachments.length ? { attachments } : {}) };
  }

  return null;
}

function priorTextMessages(
  messages: ChatMessage[],
  lastUserIndex: number,
): Array<{ role: 'user' | 'assistant'; text: string }> {
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (let i = 0; i < lastUserIndex; i++) {
    const msg = messages[i];
    if (!msg) continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') continue; // skip system / tool
    const text = extractText(msg.content);
    if (text === null) continue;
    out.push({ role: msg.role, text });
  }
  return out;
}

function extractText(content: ChatMessage['content']): string | null {
  if (typeof content === 'string') return content.length === 0 ? null : content;
  if (Array.isArray(content)) {
    const text = content
      .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
      .map((p) => p.text)
      .join('\n');
    return text.length === 0 ? null : text;
  }
  return null;
}

function zeroUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    estimatedCostUsd: 0,
    apiCallCount: 0,
    compactionCount: 0,
  };
}
