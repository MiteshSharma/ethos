import type {
  CompressionEvent,
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  SessionUsage,
  StoredMessage,
} from '@ethosagent/types';

export class InMemorySessionStore implements SessionStore {
  private sessions = new Map<string, Session>();
  private messages = new Map<string, StoredMessage[]>();
  private compressions = new Map<string, CompressionEvent[]>();
  private turnState = new Map<string, { turnCount: number; lastCompactionTurn: number }>();
  private idCounter = 0;

  async createSession(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session> {
    const session: Session = {
      ...data,
      id: `session_${++this.idCounter}`,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.sessions.set(session.id, session);
    this.messages.set(session.id, []);
    return session;
  }

  async getSession(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }

  async getSessionByKey(key: string): Promise<Session | null> {
    for (const s of this.sessions.values()) {
      if (s.key === key) return s;
    }
    return null;
  }

  async updateSession(id: string, patch: Partial<Session>): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) throw new Error(`Session not found: ${id}`);
    // A session's personality is bound at creation and immutable thereafter.
    // Binding an unset one is allowed; re-pointing a bound one never is.
    if (
      patch.personalityId !== undefined &&
      session.personalityId != null &&
      patch.personalityId !== session.personalityId
    ) {
      throw new Error(
        `Session ${id} is bound to personality "${session.personalityId}" and cannot be changed to "${patch.personalityId}".`,
      );
    }
    this.sessions.set(id, { ...session, ...patch, updatedAt: new Date() });
  }

  async deleteSession(id: string): Promise<void> {
    this.sessions.delete(id);
    this.messages.delete(id);
    this.compressions.delete(id);
    this.turnState.delete(id);
  }

  async listSessions(filter?: SessionFilter): Promise<Session[]> {
    let results = [...this.sessions.values()];
    if (filter?.platform) results = results.filter((s) => s.platform === filter.platform);
    if (filter?.personalityId)
      results = results.filter((s) => s.personalityId === filter.personalityId);
    if (filter?.workingDir) results = results.filter((s) => s.workingDir === filter.workingDir);
    if (filter?.since) {
      const since = filter.since;
      results = results.filter((s) => s.createdAt >= since);
    }
    results.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const offset = filter?.offset ?? 0;
    const limit = filter?.limit ?? results.length;
    return results.slice(offset, offset + limit);
  }

  async appendMessage(data: Omit<StoredMessage, 'id' | 'timestamp'>): Promise<StoredMessage> {
    const message: StoredMessage = {
      ...data,
      id: `msg_${++this.idCounter}`,
      timestamp: new Date(),
    };
    const list = this.messages.get(data.sessionId) ?? [];
    list.push(message);
    this.messages.set(data.sessionId, list);
    return message;
  }

  async getMessages(
    sessionId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<StoredMessage[]> {
    const all = this.messages.get(sessionId) ?? [];
    const offset = options?.offset ?? 0;
    // Return most-recent messages: trim from the tail, then skip `offset` from the end
    const end = all.length - offset;
    const start = options?.limit ? Math.max(0, end - options.limit) : 0;
    return all.slice(start, end);
  }

  async updateUsage(sessionId: string, delta: Partial<SessionUsage>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const usage = { ...session.usage };
    for (const [k, v] of Object.entries(delta) as [keyof SessionUsage, number][]) {
      (usage[k] as number) += v;
    }
    this.sessions.set(sessionId, { ...session, usage, updatedAt: new Date() });
  }

  async search(
    query: string,
    options?: {
      limit?: number;
      sessionId?: string;
      since?: Date;
      until?: Date;
    },
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const lower = query.toLowerCase();
    for (const [sessionId, msgs] of this.messages.entries()) {
      if (options?.sessionId && sessionId !== options.sessionId) continue;
      for (const msg of msgs) {
        if (options?.since && msg.timestamp < options.since) continue;
        if (options?.until && msg.timestamp > options.until) continue;
        const idx = msg.content.toLowerCase().indexOf(lower);
        if (idx >= 0) {
          results.push({
            sessionId,
            messageId: msg.id,
            snippet: msg.content.slice(Math.max(0, idx - 50), idx + 150),
            score: 1,
            timestamp: msg.timestamp,
          });
        }
      }
    }
    results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return results.slice(0, options?.limit ?? 20);
  }

  async recordCompression(
    event: Omit<CompressionEvent, 'id' | 'createdAt'>,
  ): Promise<CompressionEvent> {
    const full: CompressionEvent = {
      ...event,
      id: `compression_${++this.idCounter}`,
      createdAt: new Date(),
    };
    const list = this.compressions.get(event.sessionId) ?? [];
    list.push(full);
    this.compressions.set(event.sessionId, list);
    return full;
  }

  async listCompressions(sessionId: string): Promise<CompressionEvent[]> {
    return [...(this.compressions.get(sessionId) ?? [])];
  }

  async recordTurnStart(
    sessionId: string,
  ): Promise<{ turnNumber: number; lastCompactionTurn: number }> {
    const state = this.turnState.get(sessionId) ?? { turnCount: 0, lastCompactionTurn: 0 };
    state.turnCount += 1;
    this.turnState.set(sessionId, state);
    return { turnNumber: state.turnCount, lastCompactionTurn: state.lastCompactionTurn };
  }

  async recordCompactionTurn(sessionId: string, turnNumber: number): Promise<void> {
    const state = this.turnState.get(sessionId) ?? { turnCount: 0, lastCompactionTurn: 0 };
    state.lastCompactionTurn = turnNumber;
    this.turnState.set(sessionId, state);
  }

  async pruneOldSessions(olderThan: Date): Promise<number> {
    let count = 0;
    for (const [id, session] of this.sessions.entries()) {
      if (session.updatedAt < olderThan) {
        this.sessions.delete(id);
        this.messages.delete(id);
        count++;
      }
    }
    return count;
  }

  async undoTurns(_sessionId: string, _n: number): Promise<number> {
    return 0;
  }

  async vacuum(): Promise<void> {
    // No-op for in-memory store
  }
}
