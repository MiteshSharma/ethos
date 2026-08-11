import type { CardStore } from '@ethosagent/session-cards';
import { EthosError } from '@ethosagent/types';
import type {
  ContextAnatomyWire,
  SessionCard,
  Session as WireSession,
  StoredMessage as WireStoredMessage,
} from '@ethosagent/web-contracts';
import { exportFilename, formatAsMarkdown } from '../../services/sessions.export';
import type { SessionsRepository } from './repository';

// Business logic for the `sessions` namespace. Wraps `SessionsRepository`,
// converts domain entities (Date objects, optional fields) into wire
// schemas, and translates not-found / malformed-input cases into `EthosError`
// so the error envelope renders them consistently.

export interface SessionsServiceOptions {
  sessions: SessionsRepository;
  /** Phase 0 — resolves the per-session context anatomy from observability.db
   *  `llm_call` spans. Injected by boot code (serve). Absent in contexts with
   *  no observability store (onboarding, tests) → the RPC returns null. */
  contextAnatomy?: (sessionId: string) => ContextAnatomyWire | null;
  /** Durable UI-card store (ui-cards-canvas B2). Absent → `get` replays no
   *  cards, which is the pre-B2 behaviour tests and embedders rely on. */
  cards?: CardStore;
}

export interface ListInput {
  q?: string;
  limit?: number;
  cursor?: string | null;
  personalityId?: string;
}

export class SessionsService {
  constructor(private readonly opts: SessionsServiceOptions) {}

  async list(input: ListInput): Promise<{ items: WireSession[]; nextCursor: string | null }> {
    const limit = input.limit ?? 50;
    const page = await this.opts.sessions.list({
      ...(input.q !== undefined ? { q: input.q } : {}),
      limit,
      cursor: input.cursor ?? null,
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
    });
    return {
      items: page.sessions.map(toWireSession),
      nextCursor: page.nextCursor,
    };
  }

  async get(
    id: string,
  ): Promise<{ session: WireSession; messages: WireStoredMessage[]; cards: SessionCard[] }> {
    const session = await this.opts.sessions.get(id);
    if (!session) throw notFound(id);
    const messages = await this.opts.sessions.messages(id);
    return {
      session: toWireSession(session),
      messages: messages.map(toWireMessage),
      // The contract always carries the array so the client never branches on
      // undefined; a session with no store wired simply replays none.
      cards: this.opts.cards?.list(id) ?? [],
    };
  }

  async contextAnatomy(id: string): Promise<{ anatomy: ContextAnatomyWire | null }> {
    const session = await this.opts.sessions.get(id);
    if (!session) throw notFound(id);
    return { anatomy: this.opts.contextAnatomy?.(id) ?? null };
  }

  async fork(id: string, personalityId?: string): Promise<{ session: WireSession }> {
    try {
      const fresh = await this.opts.sessions.fork(id, personalityId);
      // A fork is not a fresh conversation: `SessionsRepository.fork` replays
      // the source's entire message history into the new session, tool
      // messages included. Skipping the cards would render that same history
      // with its cards missing, so they come along.
      this.opts.cards?.copySession(id, fresh.id);
      return { session: toWireSession(fresh) };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('session not found:')) {
        throw notFound(id);
      }
      throw err;
    }
  }

  async delete(id: string): Promise<void> {
    const exists = await this.opts.sessions.get(id);
    if (!exists) throw notFound(id);
    await this.opts.sessions.delete(id);
    // Cards live in their own database, outside the sessions.db cascade — a
    // deleted session would otherwise leave its rows behind forever.
    this.opts.cards?.deleteSession(id);
  }

  async export(id: string, _format: 'markdown'): Promise<{ content: string; filename: string }> {
    const session = await this.opts.sessions.get(id);
    if (!session) throw notFound(id);
    const messages = await this.opts.sessions.messages(id);
    const wireSession = toWireSession(session);
    const wireMessages = messages.map(toWireMessage);
    const content = formatAsMarkdown(wireSession, wireMessages);
    const filename = exportFilename(wireSession.title, wireSession.createdAt);
    return { content, filename };
  }

  async update(id: string, patch: { title: string | null }): Promise<{ session: WireSession }> {
    try {
      await this.opts.sessions.update(id, patch);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('session not found:')) {
        throw notFound(id);
      }
      throw err;
    }
    const session = await this.opts.sessions.get(id);
    if (!session) throw notFound(id);
    return { session: toWireSession(session) };
  }

  async pin(id: string): Promise<{ session: WireSession }> {
    const exists = await this.opts.sessions.get(id);
    if (!exists) throw notFound(id);
    await this.opts.sessions.update(id, { pinned: true });
    const session = await this.opts.sessions.get(id);
    if (!session) throw notFound(id);
    return { session: toWireSession(session) };
  }

  async unpin(id: string): Promise<{ session: WireSession }> {
    const exists = await this.opts.sessions.get(id);
    if (!exists) throw notFound(id);
    await this.opts.sessions.update(id, { pinned: false });
    const session = await this.opts.sessions.get(id);
    if (!session) throw notFound(id);
    return { session: toWireSession(session) };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'SESSION_NOT_FOUND',
    cause: `Session ${id} not found`,
    action: 'Verify the ID. Open the Sessions tab to see the current list.',
  });
}

function toWireSession(s: import('@ethosagent/types').Session): WireSession {
  return {
    id: s.id,
    key: s.key,
    platform: s.platform,
    model: s.model,
    provider: s.provider,
    personalityId: s.personalityId ?? null,
    parentSessionId: s.parentSessionId ?? null,
    workingDir: s.workingDir ?? null,
    title: s.title ?? null,
    pinned: s.pinned ?? false,
    usage: s.usage,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
    version: 1,
  };
}

function toWireMessage(m: import('@ethosagent/types').StoredMessage): WireStoredMessage {
  return {
    id: m.id,
    sessionId: m.sessionId,
    role: m.role,
    content: m.content,
    toolCallId: m.toolCallId ?? null,
    toolName: m.toolName ?? null,
    toolCalls: m.toolCalls ?? null,
    timestamp: m.timestamp.toISOString(),
  };
}
