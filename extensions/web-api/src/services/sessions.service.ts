import { EthosError } from '@ethosagent/types';
import type {
  Session as WireSession,
  StoredMessage as WireStoredMessage,
} from '@ethosagent/web-contracts';
import type { SessionsRepository } from '../repositories/sessions.repository';

// Business logic for the `sessions` namespace. Wraps `SessionsRepository`,
// converts domain entities (Date objects, optional fields) into wire
// schemas, and translates not-found / malformed-input cases into `EthosError`
// so the error envelope renders them consistently.

export interface SessionsServiceOptions {
  sessions: SessionsRepository;
}

export interface ListInput {
  q?: string;
  limit?: number;
  cursor?: string | null;
  personalityId?: string;
}

export class SessionsService {
  constructor(private readonly opts: SessionsServiceOptions) {}

  async list(input: ListInput): Promise<{ sessions: WireSession[]; nextCursor: string | null }> {
    const limit = input.limit ?? 50;
    const page = await this.opts.sessions.list({
      ...(input.q !== undefined ? { q: input.q } : {}),
      limit,
      cursor: input.cursor ?? null,
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
    });
    return {
      sessions: page.sessions.map(toWireSession),
      nextCursor: page.nextCursor,
    };
  }

  async get(id: string): Promise<{ session: WireSession; messages: WireStoredMessage[] }> {
    const session = await this.opts.sessions.get(id);
    if (!session) throw notFound(id);
    const messages = await this.opts.sessions.messages(id);
    return {
      session: toWireSession(session),
      messages: messages.map(toWireMessage),
    };
  }

  async fork(id: string, personalityId?: string): Promise<{ session: WireSession }> {
    try {
      const fresh = await this.opts.sessions.fork(id, personalityId);
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
    usage: s.usage,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
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
