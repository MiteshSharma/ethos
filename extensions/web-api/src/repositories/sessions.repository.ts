import type {
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  StoredMessage,
} from '@ethosagent/types';

// Thin wrapper over `@ethosagent/session-sqlite`'s `SessionStore`. Hides the
// store's exact method names and Date/string conversions from the service
// layer so swapping backends (e.g. an in-memory store for tests, or a future
// vector-aware variant) doesn't require service changes.
//
// Cursor pagination uses base64-encoded offsets for now. Switching to a
// rowid-keyed cursor later is a non-breaking change — the cursor is opaque
// to the client.

export interface ListPage {
  sessions: Session[];
  nextCursor: string | null;
}

export interface ListOptions {
  q?: string;
  limit: number;
  cursor: string | null;
  personalityId?: string;
}

export class SessionsRepository {
  constructor(private readonly store: SessionStore) {}

  async list(opts: ListOptions): Promise<ListPage> {
    const offset = decodeCursor(opts.cursor);
    const filter: SessionFilter = {
      limit: opts.limit + 1, // peek for `nextCursor`
      offset,
    };
    if (opts.personalityId) filter.personalityId = opts.personalityId;

    // TODO(26.3): FTS5-backed `q` filter. Today: `q` is accepted to keep the
    // contract honest but ignored — list-by-recency only. Adding a session-
    // level FTS query needs a `searchSessions` method on `SessionStore`.
    const rows = await this.store.listSessions(filter);
    const more = rows.length > opts.limit;
    const sessions = more ? rows.slice(0, opts.limit) : rows;
    const nextCursor = more ? encodeCursor(offset + opts.limit) : null;
    return { sessions, nextCursor };
  }

  async get(id: string): Promise<Session | null> {
    return this.store.getSession(id);
  }

  async getByKey(key: string): Promise<Session | null> {
    return this.store.getSessionByKey(key);
  }

  /**
   * Create a fresh session row. The agent loop will see this row when
   * `bridge.send(...)` runs (matched by `key`) instead of lazy-creating
   * one of its own — so the sessionId we return from `chat.send` is the
   * same row that ends up holding the conversation.
   */
  async create(input: {
    key: string;
    platform: string;
    model: string;
    provider: string;
    personalityId?: string;
    workingDir?: string;
  }): Promise<Session> {
    return this.store.createSession({
      key: input.key,
      platform: input.platform,
      model: input.model,
      provider: input.provider,
      ...(input.personalityId ? { personalityId: input.personalityId } : {}),
      ...(input.workingDir ? { workingDir: input.workingDir } : {}),
      usage: zeroUsage(),
    });
  }

  async messages(sessionId: string, limit?: number): Promise<StoredMessage[]> {
    const opts = limit !== undefined ? { limit } : undefined;
    return this.store.getMessages(sessionId, opts);
  }

  async delete(id: string): Promise<void> {
    return this.store.deleteSession(id);
  }

  async search(query: string, limit = 20): Promise<SearchResult[]> {
    return this.store.search(query, { limit });
  }

  /**
   * Create a new session that copies the source's shape (model / provider /
   * platform / personality) and replays its messages. The new session's
   * `parentSessionId` points at the source so the UI can surface the lineage.
   */
  async fork(sourceId: string, personalityOverride?: string): Promise<Session> {
    const source = await this.store.getSession(sourceId);
    if (!source) return Promise.reject(new Error(`session not found: ${sourceId}`));

    const fresh = await this.store.createSession({
      key: `${source.key}:fork:${Date.now()}`,
      platform: source.platform,
      model: source.model,
      provider: source.provider,
      ...(personalityOverride
        ? { personalityId: personalityOverride }
        : source.personalityId
          ? { personalityId: source.personalityId }
          : {}),
      parentSessionId: source.id,
      ...(source.workingDir ? { workingDir: source.workingDir } : {}),
      ...(source.title ? { title: source.title } : {}),
      usage: zeroUsage(),
      ...(source.metadata ? { metadata: source.metadata } : {}),
    });

    // Replay the source's history into the fork. Preserves tool_use / tool_result
    // pairing because we copy in chronological order.
    const history = await this.store.getMessages(source.id);
    for (const msg of history) {
      await this.store.appendMessage({
        sessionId: fresh.id,
        role: msg.role,
        content: msg.content,
        ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
        ...(msg.toolName ? { toolName: msg.toolName } : {}),
        ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
        ...(msg.usage ? { usage: msg.usage } : {}),
      });
    }
    return fresh;
  }
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

function encodeCursor(offset: number): string {
  return Buffer.from(String(offset), 'utf-8').toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): number {
  if (!cursor) return 0;
  try {
    const n = Number(Buffer.from(cursor, 'base64url').toString('utf-8'));
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}
