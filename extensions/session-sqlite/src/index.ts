import { randomUUID } from 'node:crypto';
import type {
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  SessionUsage,
  StoredMessage,
} from '@ethosagent/types';
import Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// SQLiteSessionStore
// WAL mode + FTS5 full-text search via external-content virtual table.
// ---------------------------------------------------------------------------

export class SQLiteSessionStore implements SessionStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.migrate();
  }

  // ---------------------------------------------------------------------------
  // Schema
  // ---------------------------------------------------------------------------

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id                   TEXT PRIMARY KEY,
        key                  TEXT UNIQUE NOT NULL,
        platform             TEXT NOT NULL,
        model                TEXT NOT NULL,
        provider             TEXT NOT NULL,
        personality_id       TEXT,
        parent_session_id    TEXT,
        working_dir          TEXT,
        title                TEXT,
        input_tokens         INTEGER NOT NULL DEFAULT 0,
        output_tokens        INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens    INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_cost_usd   REAL NOT NULL DEFAULT 0,
        api_call_count       INTEGER NOT NULL DEFAULT 0,
        compaction_count     INTEGER NOT NULL DEFAULT 0,
        metadata             TEXT,
        created_at           TEXT NOT NULL,
        updated_at           TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_sessions_key ON sessions(key);
      CREATE INDEX IF NOT EXISTS idx_sessions_platform ON sessions(platform);

      CREATE TABLE IF NOT EXISTS messages (
        id           TEXT PRIMARY KEY,
        session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role         TEXT NOT NULL,
        content      TEXT NOT NULL,
        tool_call_id TEXT,
        tool_name    TEXT,
        tool_calls   TEXT,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_creation_tokens INTEGER,
        estimated_cost_usd REAL,
        timestamp    TEXT NOT NULL
      ) STRICT;

      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, timestamp);

      CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
        content,
        content='messages',
        content_rowid='rowid',
        tokenize='porter ascii'
      );

      CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      END;

      CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content);
      END;
    `);
  }

  // ---------------------------------------------------------------------------
  // Session CRUD
  // ---------------------------------------------------------------------------

  async createSession(data: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session> {
    const id = randomUUID();
    const now = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO sessions
         (id, key, platform, model, provider, personality_id, parent_session_id, working_dir,
          title, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          estimated_cost_usd, api_call_count, compaction_count, metadata, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        data.key,
        data.platform,
        data.model,
        data.provider,
        data.personalityId ?? null,
        data.parentSessionId ?? null,
        data.workingDir ?? null,
        data.title ?? null,
        data.usage.inputTokens,
        data.usage.outputTokens,
        data.usage.cacheReadTokens,
        data.usage.cacheCreationTokens,
        data.usage.estimatedCostUsd,
        data.usage.apiCallCount,
        data.usage.compactionCount,
        data.metadata ? JSON.stringify(data.metadata) : null,
        now,
        now,
      );

    return { ...data, id, createdAt: new Date(now), updatedAt: new Date(now) };
  }

  async getSession(id: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    return row ? rowToSession(row as SessionRow) : null;
  }

  async getSessionByKey(key: string): Promise<Session | null> {
    const row = this.db.prepare('SELECT * FROM sessions WHERE key = ?').get(key);
    return row ? rowToSession(row as SessionRow) : null;
  }

  async updateSession(id: string, patch: Partial<Session>): Promise<void> {
    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [now];

    if (patch.title !== undefined) {
      sets.push('title = ?');
      values.push(patch.title);
    }
    if (patch.personalityId !== undefined) {
      sets.push('personality_id = ?');
      values.push(patch.personalityId);
    }
    if (patch.model !== undefined) {
      sets.push('model = ?');
      values.push(patch.model);
    }
    if (patch.metadata !== undefined) {
      sets.push('metadata = ?');
      values.push(JSON.stringify(patch.metadata));
    }

    values.push(id);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  async deleteSession(id: string): Promise<void> {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
  }

  async listSessions(filter?: SessionFilter): Promise<Session[]> {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter?.platform) {
      conditions.push('platform = ?');
      values.push(filter.platform);
    }
    if (filter?.personalityId) {
      conditions.push('personality_id = ?');
      values.push(filter.personalityId);
    }
    if (filter?.workingDir) {
      conditions.push('working_dir = ?');
      values.push(filter.workingDir);
    }
    if (filter?.since) {
      conditions.push('created_at >= ?');
      values.push(filter.since.toISOString());
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter?.limit ?? -1;
    const offset = filter?.offset ?? 0;

    const rows = this.db
      .prepare(`SELECT * FROM sessions ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset);

    return (rows as SessionRow[]).map(rowToSession);
  }

  // ---------------------------------------------------------------------------
  // Messages
  // ---------------------------------------------------------------------------

  async appendMessage(data: Omit<StoredMessage, 'id' | 'timestamp'>): Promise<StoredMessage> {
    const id = randomUUID();
    const timestamp = new Date().toISOString();

    this.db
      .prepare(
        `INSERT INTO messages
         (id, session_id, role, content, tool_call_id, tool_name, tool_calls,
          input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          estimated_cost_usd, timestamp)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        data.sessionId,
        data.role,
        data.content,
        data.toolCallId ?? null,
        data.toolName ?? null,
        data.toolCalls ? JSON.stringify(data.toolCalls) : null,
        data.usage?.inputTokens ?? null,
        data.usage?.outputTokens ?? null,
        data.usage?.cacheReadTokens ?? null,
        data.usage?.cacheCreationTokens ?? null,
        data.usage?.estimatedCostUsd ?? null,
        timestamp,
      );

    return { ...data, id, timestamp: new Date(timestamp) };
  }

  async getMessages(
    sessionId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<StoredMessage[]> {
    // Return most-recent `limit` messages in chronological order
    const offset = options?.offset ?? 0;
    const limit = options?.limit;

    // rowid breaks timestamp ties (insertion order). Must be explicit in SELECT to be visible
    // in the outer query.
    const rows = limit
      ? this.db
          .prepare(
            `SELECT * FROM (
               SELECT *, rowid AS _row FROM messages WHERE session_id = ?
               ORDER BY timestamp DESC, rowid DESC LIMIT ? OFFSET ?
             ) ORDER BY timestamp ASC, _row ASC`,
          )
          .all(sessionId, limit, offset)
      : this.db
          .prepare(
            `SELECT *, rowid AS _row FROM messages WHERE session_id = ?
             ORDER BY timestamp ASC, rowid ASC`,
          )
          .all(sessionId);

    return (rows as MessageRow[]).map(rowToMessage);
  }

  async updateUsage(sessionId: string, delta: Partial<SessionUsage>): Promise<void> {
    const sets: string[] = ['updated_at = ?'];
    const values: unknown[] = [new Date().toISOString()];

    const colMap: Record<keyof SessionUsage, string> = {
      inputTokens: 'input_tokens',
      outputTokens: 'output_tokens',
      cacheReadTokens: 'cache_read_tokens',
      cacheCreationTokens: 'cache_creation_tokens',
      estimatedCostUsd: 'estimated_cost_usd',
      apiCallCount: 'api_call_count',
      compactionCount: 'compaction_count',
    };

    for (const [key, val] of Object.entries(delta) as [keyof SessionUsage, number][]) {
      const col = colMap[key];
      sets.push(`${col} = ${col} + ?`);
      values.push(val);
    }

    values.push(sessionId);
    this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  // ---------------------------------------------------------------------------
  // Full-text search via FTS5
  // ---------------------------------------------------------------------------

  async search(
    query: string,
    options?: { limit?: number; sessionId?: string },
  ): Promise<SearchResult[]> {
    const limit = options?.limit ?? 20;
    const safeQuery = escapeFtsQuery(query);

    const rows = options?.sessionId
      ? (this.db
          .prepare(
            `SELECT m.id, m.session_id, m.content, m.timestamp,
                    bm25(messages_fts) AS score
             FROM messages_fts
             JOIN messages m ON m.rowid = messages_fts.rowid
             WHERE messages_fts MATCH ? AND m.session_id = ?
             ORDER BY bm25(messages_fts)
             LIMIT ?`,
          )
          .all(safeQuery, options.sessionId, limit) as FtsRow[])
      : (this.db
          .prepare(
            `SELECT m.id, m.session_id, m.content, m.timestamp,
                    bm25(messages_fts) AS score
             FROM messages_fts
             JOIN messages m ON m.rowid = messages_fts.rowid
             WHERE messages_fts MATCH ?
             ORDER BY bm25(messages_fts)
             LIMIT ?`,
          )
          .all(safeQuery, limit) as FtsRow[]);

    return rows.map((r) => ({
      sessionId: r.session_id,
      messageId: r.id,
      snippet: extractSnippet(r.content, query),
      score: -r.score, // bm25 returns negative; flip so higher = better
      timestamp: new Date(r.timestamp),
    }));
  }

  // ---------------------------------------------------------------------------
  // Maintenance
  // ---------------------------------------------------------------------------

  async pruneOldSessions(olderThan: Date): Promise<number> {
    const result = this.db
      .prepare('DELETE FROM sessions WHERE updated_at < ?')
      .run(olderThan.toISOString());
    return result.changes;
  }

  async vacuum(): Promise<void> {
    this.db.exec('VACUUM');
  }

  /** Close the database connection (useful in tests). */
  close(): void {
    this.db.close();
  }
}

// ---------------------------------------------------------------------------
// Row type helpers
// ---------------------------------------------------------------------------

interface SessionRow {
  id: string;
  key: string;
  platform: string;
  model: string;
  provider: string;
  personality_id: string | null;
  parent_session_id: string | null;
  working_dir: string | null;
  title: string | null;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  estimated_cost_usd: number;
  api_call_count: number;
  compaction_count: number;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  session_id: string;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_name: string | null;
  tool_calls: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  estimated_cost_usd: number | null;
  timestamp: string;
}

interface FtsRow {
  id: string;
  session_id: string;
  content: string;
  timestamp: string;
  score: number;
}

function rowToSession(r: SessionRow): Session {
  return {
    id: r.id,
    key: r.key,
    platform: r.platform,
    model: r.model,
    provider: r.provider,
    personalityId: r.personality_id ?? undefined,
    parentSessionId: r.parent_session_id ?? undefined,
    workingDir: r.working_dir ?? undefined,
    title: r.title ?? undefined,
    usage: {
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
      estimatedCostUsd: r.estimated_cost_usd,
      apiCallCount: r.api_call_count,
      compactionCount: r.compaction_count,
    },
    metadata: r.metadata ? (JSON.parse(r.metadata) as Record<string, unknown>) : undefined,
    createdAt: new Date(r.created_at),
    updatedAt: new Date(r.updated_at),
  };
}

function rowToMessage(r: MessageRow): StoredMessage {
  return {
    id: r.id,
    sessionId: r.session_id,
    role: r.role as StoredMessage['role'],
    content: r.content,
    toolCallId: r.tool_call_id ?? undefined,
    toolName: r.tool_name ?? undefined,
    toolCalls: r.tool_calls ? (JSON.parse(r.tool_calls) as StoredMessage['toolCalls']) : undefined,
    usage:
      r.input_tokens != null
        ? {
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens ?? 0,
            cacheReadTokens: r.cache_read_tokens ?? 0,
            cacheCreationTokens: r.cache_creation_tokens ?? 0,
            estimatedCostUsd: r.estimated_cost_usd ?? 0,
          }
        : undefined,
    timestamp: new Date(r.timestamp),
  };
}

// ---------------------------------------------------------------------------
// FTS helpers
// ---------------------------------------------------------------------------

function escapeFtsQuery(query: string): string {
  // Wrap in quotes to treat as a phrase; escape internal quotes
  return `"${query.replace(/"/g, '""')}"`;
}

function extractSnippet(content: string, query: string): string {
  const lower = content.toLowerCase();
  const idx = lower.indexOf(query.toLowerCase());
  if (idx < 0) return content.slice(0, 200);
  const start = Math.max(0, idx - 50);
  const end = Math.min(content.length, idx + 150);
  return content.slice(start, end);
}
