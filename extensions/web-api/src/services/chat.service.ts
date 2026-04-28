import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  AgentBridge,
  type BufferedEvent,
  type SessionStreamBuffer,
} from '@ethosagent/agent-bridge';
import type { AgentLoop } from '@ethosagent/core';
import { EthosError } from '@ethosagent/types';
import type { SseEvent } from '@ethosagent/web-contracts';
import type { SessionsRepository } from '../repositories/sessions.repository';

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
  sessions: SessionsRepository;
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
}

export interface ChatSendInput {
  sessionId?: string;
  clientId: string;
  text: string;
  personalityId?: string;
}

export interface ChatSendOutput {
  sessionId: string;
  turnId: string;
}

interface InternalEventMap {
  /** One event per (sessionId, append). The handler reads `sessionId` from the closure. */
  appended: [sessionId: string, buffered: BufferedEvent<SseEvent>];
}

export class ChatService {
  private readonly bridges = new Map<string, AgentBridge>();
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

    const bridge = this.getOrCreateBridge(session.id);
    const turnId = randomUUID();

    // Fire and forget — the bridge streams events through our subscription
    // and persists messages via the agent loop. `chat.send` returns as soon
    // as the turn is queued so the client can connect SSE.
    void bridge
      .send(input.text, {
        sessionKey: session.key,
        ...(input.personalityId ? { personalityId: input.personalityId } : {}),
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
    onEvent: (e: BufferedEvent<SseEvent>) => void,
  ): () => void {
    // Tell the buffer the session is active so it cancels any pending reap.
    this.opts.buffer.touch(sessionId);

    // 1. Replay missed events first, in seq order.
    for (const e of this.opts.buffer.replay(sessionId, sinceSeq)) {
      onEvent(e);
    }

    // 2. Subscribe to future appends.
    const handler = (id: string, buffered: BufferedEvent<SseEvent>) => {
      if (id === sessionId) onEvent(buffered);
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
    bridge.on('tool_start', (toolCallId, toolName, args) =>
      this.append(sessionId, { type: 'tool_start', toolCallId, toolName, args }),
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
    bridge.on('tool_end', (toolCallId, toolName, ok, durationMs, result) =>
      this.append(sessionId, {
        type: 'tool_end',
        toolCallId,
        toolName,
        ok,
        durationMs,
        ...(result !== undefined ? { result } : {}),
      }),
    );
    bridge.on('usage', (inputTokens, outputTokens, estimatedCostUsd) =>
      this.append(sessionId, {
        type: 'usage',
        inputTokens,
        outputTokens,
        estimatedCostUsd,
      }),
    );
    bridge.on('error', (error, code) => this.append(sessionId, { type: 'error', error, code }));
    bridge.on('done', (text, turnCount) =>
      this.append(sessionId, { type: 'done', text, turnCount }),
    );
  }

  private append(sessionId: string, event: SseEvent): void {
    const seq = this.opts.buffer.append(sessionId, event);
    this.emitter.emit('appended', sessionId, { seq, event });
  }
}
