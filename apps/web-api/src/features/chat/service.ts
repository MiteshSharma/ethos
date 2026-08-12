import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  AgentBridge,
  type BufferedEvent,
  type SessionStreamBuffer,
} from '@ethosagent/agent-bridge';
import type { AgentLoop } from '@ethosagent/core';
import type { CardStore } from '@ethosagent/session-cards';
import { EthosError } from '@ethosagent/types';
import type { CardEnvelope, SseEvent } from '@ethosagent/web-contracts';
import type { SystemEventBus } from '../../services/system-event-bus';
import { gateStructuredCard } from './card-gate';
import type { ChatRepository } from './repository';

// Chat orchestrator. The one place that touches `AgentBridge` per the spec
// (architecture rule #6). Three jobs:
//
//   1. Resolve / pre-create a session row before kicking off the bridge —
//      so `chat.send` returns the same `sessionId` the SSE consumer
//      subscribes to.
//   2. Maintain ONE bridge per session (re-used across multiple `send`s on
//      the same session — the bridge has its own FIFO queue for concurrent
//      sends per finding 1.3).
//   3. Translate bridge events into wire-format `SseEvent`s, append to the
//      `SessionStreamBuffer` (for replay), and emit live to the SSE
//      handler via an internal event emitter.
//
// Bridges are reaped automatically once `SessionStreamBuffer.disconnect`
// fires its 5-minute timer — see TODO below.

export interface ChatDefaults {
  /** Used when creating a new session row for an unkeyed `chat.send`. */
  model: string;
  provider: string;
  /** Optional CWD to record on the session. Web-profile usually leaves this null. */
  workingDir?: string;
}

export interface ChatServiceOptions {
  loop: AgentLoop;
  sessions: ChatRepository;
  buffer: SessionStreamBuffer<SseEvent>;
  defaults: ChatDefaults;
  /** Surface label recorded on new sessions. Default: 'web'. */
  platform?: string;
  /**
   * Called when `forget(sessionId)` runs — surface code wires this to
   * `ApprovalsService.cancelForSession` so any awaiting `before_tool_call`
   * hook unblocks instead of leaving the agent loop hanging on a Promise
   * that will never resolve.
   */
  onForget?: (sessionId: string) => void;
  /** Cheapest/fastest LLM call for housekeeping (title gen, routing). Optional — when absent, auto-title is disabled. */
  titleFn?: (systemPrompt: string, userMessage: string) => Promise<string>;
  /** System-level event bus for broadcasting real-time events. When provided, a `session.titled` event is emitted after auto-titling. */
  systemBus?: SystemEventBus;
  /** Optional attachment cache for persisting inbound attachments. */
  attachmentCache?: import('@ethosagent/types').AttachmentCache;
  /**
   * Optional durable store for typed UI cards. When wired, a valid
   * `tool_end.structured.card` is persisted so `sessions.get` can replay it
   * after the in-memory stream buffer is reaped. Absent → cards live only for
   * the length of the stream (tests, embedders).
   */
  cardStore?: CardStore;
  /**
   * Optional refresh closure — reloads the loop's personality registry from
   * disk before a turn runs, so a hot-dropped or edited personality resolves
   * without a server restart. Absent → no refresh.
   */
  refreshPersonalities?: () => Promise<void>;
  /**
   * Called on every completed turn (`done` event). Boot code wires this to
   * the W4.1 funnel tracker (`funnel.first_reply`) — the tracker itself
   * no-ops after the first stamp, so the callback stays cheap.
   */
  onTurnDone?: () => void;
}

export interface ChatSendInput {
  sessionId?: string;
  clientId: string;
  /**
   * B1/B3 — the `x-request-id` of the HTTP request that asked for this turn.
   * Threaded in by the RPC layer. It becomes the returned `turnId`, so the
   * handle a tab gets back is the same id the response header and any error
   * envelope carry, instead of a third UUID that names nothing else. The
   * turn's own `traceId` is a DIFFERENT id and arrives on the SSE stream
   * (`run_start.traceId`) — see the note on `ChatSendOutput.turnId`.
   */
  requestId?: string;
  text: string;
  personalityId?: string;
  userId?: string;
  dryRun?: boolean;
  /** `voice` → `text` is a transcript of speech (talk-mode). Default `text`. */
  origin?: 'text' | 'voice';
  attachments?: Array<{
    type: 'image' | 'file';
    data: string;
    mimeType: string;
    name?: string;
  }>;
}

export interface ChatSendOutput {
  sessionId: string;
  /**
   * The request id of the `chat.send` that started this turn (see
   * `ChatSendInput.requestId`). It is NOT the turn's `traceId`: `send` returns
   * before the loop has run turn-setup, and blocking until it had would mean
   * waiting behind the bridge's FIFO queue for any turn already in flight. The
   * `traceId` reaches the client on the SSE stream instead.
   */
  turnId: string;
}

interface InternalEventMap {
  /** One event per (sessionId, append). The handler reads `sessionId` from the closure. */
  appended: [sessionId: string, buffered: BufferedEvent<SseEvent>];
}

export class ChatService {
  private readonly bridges = new Map<string, AgentBridge>();
  private readonly firstUserMessages = new Map<string, string>();
  private readonly emitter = new EventEmitter<InternalEventMap>();

  constructor(private readonly opts: ChatServiceOptions) {
    // Allow many SSE connections per session (multi-tab) without warnings.
    this.emitter.setMaxListeners(0);
  }

  // ---------------------------------------------------------------------------
  // RPC entry points
  // ---------------------------------------------------------------------------

  async send(input: ChatSendInput): Promise<ChatSendOutput> {
    const session = input.sessionId
      ? await this.requireSession(input.sessionId)
      : await this.opts.sessions.create({
          key: `web:${randomUUID()}`,
          platform: this.opts.platform ?? 'web',
          model: this.opts.defaults.model,
          provider: this.opts.defaults.provider,
          ...(input.personalityId ? { personalityId: input.personalityId } : {}),
          ...(this.opts.defaults.workingDir ? { workingDir: this.opts.defaults.workingDir } : {}),
        });

    if (!this.firstUserMessages.has(session.id)) {
      this.firstUserMessages.set(session.id, input.text);
    }

    const bridge = this.getOrCreateBridge(session.id);

    const MAX_ATTACHMENTS = 10;
    const MAX_TOTAL_BYTES = 10 * 1024 * 1024; // 10 MB

    let loopAttachments: import('@ethosagent/types').Attachment[] | undefined;
    if (input.attachments?.length) {
      if (input.attachments.length > MAX_ATTACHMENTS) {
        throw new EthosError({
          code: 'INVALID_INPUT',
          cause: `Too many attachments: ${input.attachments.length} (max ${MAX_ATTACHMENTS})`,
          action: 'Reduce the number of attachments.',
        });
      }
      if (!this.opts.attachmentCache) {
        throw new EthosError({
          code: 'NOT_CONFIGURED',
          cause: 'File attachments are not available — attachment cache is not configured',
          action: 'Configure the attachment cache in the server options.',
        });
      }
      const messageId = randomUUID();
      loopAttachments = [];
      let totalBytes = 0;
      for (const raw of input.attachments) {
        const bytes = Uint8Array.from(Buffer.from(raw.data, 'base64'));
        totalBytes += bytes.length;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new EthosError({
            code: 'INVALID_INPUT',
            cause: `Total attachment size exceeds ${MAX_TOTAL_BYTES / (1024 * 1024)} MB`,
            action: 'Reduce attachment sizes or count.',
          });
        }
        const url = await this.opts.attachmentCache.write(bytes, {
          sessionKey: session.key,
          messageId,
          filename: raw.name ?? 'attachment',
          mime: raw.mimeType,
        });
        loopAttachments.push({
          type: raw.type,
          ref: url,
          url,
          mimeType: raw.mimeType,
          filename: raw.name,
          sizeBytes: bytes.length,
        });
      }
    }

    // No UUID minted here: the request that started the turn already has an id
    // (`x-request-id`). The fallback covers callers with no HTTP request behind
    // them (tests, embedders).
    const turnId = input.requestId ?? randomUUID();

    // Refresh the loop's personality registry from disk before the turn runs so
    // a hot-dropped or edited personality resolves without a restart. No-op when
    // no closure is wired (tests, embedders). Fail-open: a refresh that throws
    // (e.g. malformed personality YAML on disk) must not abort the turn — serve
    // the last-good registry (stale-but-alive beats a dead turn).
    try {
      await this.opts.refreshPersonalities?.();
    } catch (err) {
      console.warn(
        `[chat] personality refresh failed (serving last-good): ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    // Fire and forget — the bridge streams events through our subscription
    // and persists messages via the agent loop. `chat.send` returns as soon
    // as the turn is queued so the client can connect SSE.
    void bridge
      .send(input.text, {
        sessionKey: session.key,
        ...(input.personalityId ? { personalityId: input.personalityId } : {}),
        ...(input.userId ? { userId: input.userId } : {}),
        ...(input.dryRun ? { dryRun: true } : {}),
        ...(loopAttachments?.length ? { attachments: loopAttachments } : {}),
        // Talk-mode turn: the loop renders a message-level `<voice-origin>`
        // annotation on the persisted user message so the model knows it is
        // speaking. `owner` — this is the operator's own browser session,
        // behind the same auth as the rest of the surface; a far-end caller
        // can never reach this code path.
        ...(input.origin === 'voice'
          ? { voiceOrigin: { transport: 'browser-talk-mode', speaker: 'owner' as const } }
          : {}),
      })
      .catch((err) => {
        // bridge.send doesn't reject for in-flight failures (those land as
        // 'error' events). Anything that escapes here is a programming bug.
        const message = err instanceof Error ? err.message : String(err);
        this.append(session.id, { type: 'error', error: message, code: 'INTERNAL' });
      });

    return { sessionId: session.id, turnId };
  }

  async abort(sessionId: string): Promise<void> {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) return; // No bridge → nothing to abort. Idempotent.
    bridge.abortTurn();
  }

  steer(sessionId: string, text: string): boolean {
    const bridge = this.bridges.get(sessionId);
    if (!bridge) return false;
    return bridge.steer(text);
  }

  // ---------------------------------------------------------------------------
  // SSE entry point
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to the live stream for a session. Replays everything after
   * `sinceSeq` synchronously, then registers `onEvent` to receive future
   * events as they arrive. Returns an unsubscribe handle that the SSE
   * route calls when the connection drops.
   */
  subscribe(
    sessionId: string,
    sinceSeq: number,
    onEvent: (e: BufferedEvent<SseEvent>) => void | Promise<void>,
  ): () => void {
    // Tell the buffer the session is active so it cancels any pending reap.
    this.opts.buffer.touch(sessionId);

    // 1. Replay missed events first, in seq order.
    for (const e of this.opts.buffer.replay(sessionId, sinceSeq)) {
      this.invokeSubscriber(onEvent, e);
    }

    // 2. Subscribe to future appends.
    const handler = (id: string, buffered: BufferedEvent<SseEvent>) => {
      if (id === sessionId) this.invokeSubscriber(onEvent, buffered);
    };
    this.emitter.on('appended', handler);

    return () => {
      this.emitter.off('appended', handler);
      // Start the reap timer; if another tab connects before reapMs, touch
      // (in subscribe) cancels it.
      this.opts.buffer.disconnect(sessionId);
    };
  }

  /**
   * Push an out-of-band SSE event into a session — used by the approvals
   * pipeline (`tool.approval_required`, `approval.resolved`) and any future
   * push events that aren't tied to a specific bridge turn. Goes through the
   * same buffer + emitter pipeline as bridge events so SSE replay covers it.
   */
  broadcast(sessionId: string, event: SseEvent): void {
    this.append(sessionId, event);
  }

  /**
   * Fan-out push events that aren't tied to any specific session
   * (`cron.fired`, `mesh.changed`, `evolve.skill_pending`). Writes the
   * event into every currently-buffered session so whichever tab the
   * user has open hears it. Single-user app posture: the mesh of "open
   * sessions" maps roughly 1:1 to "tabs the user has touched lately,"
   * and the buffer's reap window (5min) keeps stale entries from
   * fanning to.
   */
  broadcastAll(event: SseEvent): void {
    for (const sessionId of this.opts.buffer.activeSessions()) {
      this.append(sessionId, event);
    }
  }

  /** Drop bridge + buffer for a session — called by tests / future /new flow. */
  forget(sessionId: string): void {
    const bridge = this.bridges.get(sessionId);
    if (bridge) {
      bridge.removeAllListeners();
      bridge.abortTurn();
      this.bridges.delete(sessionId);
    }
    this.firstUserMessages.delete(sessionId);
    this.opts.buffer.clear(sessionId);
    // If approvals are wired, drop any pending requests for this session
    // so the awaiting hook unblocks (`{ decision: 'deny', reason: 'session
    // ended' }`) instead of leaving the agent loop hanging forever.
    this.opts.onForget?.(sessionId);
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private async requireSession(id: string) {
    const session = await this.opts.sessions.get(id);
    if (!session) {
      throw new EthosError({
        code: 'SESSION_NOT_FOUND',
        cause: `Session ${id} not found`,
        action: 'Verify the ID. If the session was deleted, call chat.send without sessionId.',
      });
    }
    return session;
  }

  private getOrCreateBridge(sessionId: string): AgentBridge {
    const existing = this.bridges.get(sessionId);
    if (existing) return existing;

    const bridge = new AgentBridge(this.opts.loop);
    this.wireBridge(sessionId, bridge);
    this.bridges.set(sessionId, bridge);
    return bridge;
  }

  /**
   * Subscribe an `AgentBridge`'s EventEmitter output to the buffer + live
   * emitter. `text_delta`, `tool_*`, `usage`, `error`, `done` map to wire
   * `SseEvent`s. `idle` and `queued` are bridge-internal — don't surface.
   */
  private wireBridge(sessionId: string, bridge: AgentBridge): void {
    bridge.on('text_delta', (text) => this.append(sessionId, { type: 'text_delta', text }));
    bridge.on('thinking_delta', (thinking) =>
      this.append(sessionId, { type: 'thinking_delta', thinking }),
    );
    bridge.on('tool_start', (toolCallId, toolName, args, audience) =>
      this.append(sessionId, {
        type: 'tool_start',
        toolCallId,
        toolName,
        args,
        ...(audience !== undefined ? { audience } : {}),
      }),
    );
    bridge.on('tool_progress', (toolName, message, percent) =>
      this.append(sessionId, {
        type: 'tool_progress',
        toolName,
        message,
        ...(percent !== undefined ? { percent } : {}),
        // The agent loop already gates `audience: 'internal'` events; bridge
        // events flow only when audience would surface them.
        audience: 'user',
      }),
    );
    bridge.on('tool_end', (toolCallId, toolName, ok, durationMs, result, structured, audience) => {
      // Cards are gated before anything else sees them: an envelope that does
      // not match the contract is neither broadcast nor persisted.
      const gated = gateStructuredCard(structured);
      if (gated.issues) {
        console.warn(
          `[chat] dropped invalid card envelope from ${toolName} (${toolCallId}): ${gated.issues.join('; ')}`,
        );
      }
      if (gated.card) this.persistCard(sessionId, toolCallId, gated.card);
      this.append(sessionId, {
        type: 'tool_end',
        toolCallId,
        toolName,
        ok,
        durationMs,
        ...(result !== undefined ? { result } : {}),
        ...(gated.structured !== undefined ? { structured: gated.structured } : {}),
        ...(audience !== undefined ? { audience } : {}),
      });
    });
    bridge.on('usage', (inputTokens, outputTokens, estimatedCostUsd) =>
      this.append(sessionId, {
        type: 'usage',
        inputTokens,
        outputTokens,
        estimatedCostUsd,
      }),
    );
    bridge.on('dry_run_summary', (plan, capped) =>
      this.append(sessionId, { type: 'dry_run_summary', plan, capped }),
    );
    // B3 — the turn's `traceId` is passed straight through onto the stream on
    // both the opening and closing event of the turn. This is the only turn
    // identity web-api publishes; it does not mint one of its own.
    bridge.on('run_start', (provider, model, source, traceId) =>
      this.append(sessionId, {
        type: 'run_start',
        provider,
        model,
        source,
        ...(traceId ? { traceId } : {}),
      }),
    );
    bridge.on('error', (error, code) => this.append(sessionId, { type: 'error', error, code }));
    bridge.on('done', (text, turnCount, traceId) => {
      this.append(sessionId, { type: 'done', text, turnCount, ...(traceId ? { traceId } : {}) });
      try {
        this.opts.onTurnDone?.();
      } catch {
        // Funnel/analytics callbacks are best-effort — never break the stream.
      }
      void this.tryAutoTitle(sessionId);
    });
  }

  /**
   * Persist a validated card for replay. Best-effort by design: a store
   * failure costs one card on a later reload, and must never break the live
   * stream the user is watching.
   */
  private persistCard(sessionId: string, toolCallId: string, envelope: CardEnvelope): void {
    try {
      this.opts.cardStore?.append(sessionId, toolCallId, envelope);
    } catch (err) {
      console.warn(
        `[chat] card persist failed for session ${sessionId} (${toolCallId}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async tryAutoTitle(sessionId: string): Promise<void> {
    try {
      const session = await this.opts.sessions.get(sessionId);
      if (!session) {
        return;
      }
      if (session.title) {
        return;
      }
      const firstMessage = this.firstUserMessages.get(sessionId);
      if (!firstMessage) {
        return;
      }
      this.firstUserMessages.delete(sessionId);
      await this.titleSession(sessionId, firstMessage);
    } catch (err) {
      // Best-effort: auto-title failures are non-fatal, but log so a persistent
      // failure (e.g. the session store rejecting the update) is diagnosable.
      console.warn(`[chat] auto-title failed for session ${sessionId}:`, err);
    }
  }

  /**
   * Title a session from its first user message. Prefers the injected `titleFn`
   * (an LLM call); when that is absent, throws, or yields an empty title, falls
   * back to a deterministic title derived from the first user message. Net
   * effect: every session with a non-empty first message ends up titled.
   */
  private async titleSession(sessionId: string, firstUserMessage: string): Promise<void> {
    let title = '';
    if (this.opts.titleFn) {
      try {
        const generated = await this.opts.titleFn(
          'Generate a title for this conversation in 6 words or fewer. Reply with only the title, no punctuation.',
          firstUserMessage,
        );
        title = generated.trim().slice(0, 200);
      } catch (err) {
        // Non-fatal: fall through to the deterministic fallback below.
        console.warn(
          `[chat] auto-title LLM failed for session ${sessionId}; using fallback title:`,
          err,
        );
      }
    }

    if (!title) {
      title = deriveFallbackTitle(firstUserMessage);
    }
    if (!title) {
      return; // Empty first message — nothing meaningful to title with.
    }

    await this.opts.sessions.update(sessionId, { title });
    this.opts.systemBus?.emitSystem({ type: 'session.titled', sessionId, title });
  }

  private invokeSubscriber(
    onEvent: (e: BufferedEvent<SseEvent>) => void | Promise<void>,
    e: BufferedEvent<SseEvent>,
  ): void {
    // A subscriber-local failure (sync throw or async rejection) must never
    // crash the emitter or abort delivery to other subscribers.
    try {
      Promise.resolve(onEvent(e)).catch(() => {});
    } catch {
      /* sync throw contained */
    }
  }

  private append(sessionId: string, event: SseEvent): void {
    const seq = this.opts.buffer.append(sessionId, event);
    this.emitter.emit('appended', sessionId, { seq, event });
  }
}

/** Max length of a deterministic fallback title (before the ellipsis). */
const FALLBACK_TITLE_MAX = 60;

/**
 * Derive a deterministic session title from the first user message. Takes the
 * first line, strips a leading slash-command token, collapses whitespace, and
 * truncates to `FALLBACK_TITLE_MAX` chars (appending an ellipsis when cut).
 * Returns '' only when the message has no titleable content.
 */
function deriveFallbackTitle(firstUserMessage: string): string {
  const firstLine = firstUserMessage.split('\n', 1)[0] ?? '';
  // Strip a leading slash-command token (e.g. "/new", "/deploy the app").
  const withoutCommand = firstLine.replace(/^\/\S+\s*/, '');
  const source = withoutCommand.trim() ? withoutCommand : firstLine;
  const collapsed = source.replace(/\s+/g, ' ').trim();
  if (!collapsed) {
    return '';
  }
  if (collapsed.length <= FALLBACK_TITLE_MAX) {
    return collapsed;
  }
  return `${collapsed.slice(0, FALLBACK_TITLE_MAX).trimEnd()}…`;
}
