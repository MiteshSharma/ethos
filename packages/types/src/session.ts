import type { MessageContent, TokenUsage } from './llm';

export interface Session {
  id: string;
  key: string;
  platform: string;
  model: string;
  provider: string;
  /**
   * The personality this session is bound to. Set at creation and immutable
   * thereafter: `updateSession` throws if a patch would change it to a
   * different id once set (setting it from unset is allowed, so legacy rows can
   * be bound on first use). To involve a different personality, create a new
   * session or fork this one into a child session.
   */
  personalityId?: string;
  parentSessionId?: string;
  workingDir?: string;
  title?: string;
  pinned?: boolean;
  usage: SessionUsage;
  createdAt: Date;
  updatedAt: Date;
  metadata?: Record<string, unknown>;
}

export interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  estimatedCostUsd: number;
  apiCallCount: number;
  compactionCount: number;
}

export type MessageRole = 'user' | 'assistant' | 'tool_result' | 'system' | 'user_steer';

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  /**
   * Inline image/document blocks for a `user` row whose attachments were sent
   * natively to a vision-capable model, so a resumed session re-sends the same
   * blocks instead of degrading to the annotation.
   *
   * Deliberately a SEPARATE field rather than widening `content` to
   * `string | MessageContent[]`, for the same reason `toolCalls` is separate:
   * `content` backs the FTS5 external-content index, and base64 payloads in
   * that column would bloat the index and pollute `session_search` results.
   * `content` therefore keeps the human-readable `<attachments>` annotation,
   * which is also the residue block-aging falls back to.
   *
   * Absent on every row that has no inline blocks, which is almost all of them.
   */
  contentBlocks?: MessageContent[];
  timestamp: Date;
  usage?: TokenUsage;
  /**
   * Observability trace id of the turn that persisted this message — the SAME
   * id the turn's trace carries in `observability.db`, so `sessions.db` rows
   * join to traces/spans without a second identity. Undefined — never `''` or
   * `'null'` — on messages written outside a traced turn (no observability
   * wired) or by a store that does not persist it.
   */
  traceId?: string;
  /**
   * Whether this `tool_result` row records a FAILURE. Mirrors the `is_error`
   * flag on the LLM-facing tool_result block, so a reloaded transcript can say
   * `ok` or `failed` instead of admitting it does not know.
   *
   * Tri-state on purpose. Absent means "not recorded" — every row written
   * before this field existed, and every store that does not persist it — and
   * must NOT be read back as `false`. `false` is a recorded success; `true` is
   * a recorded failure. Reading absent as success would fabricate the very
   * assurance this field exists to make honest.
   *
   * Only meaningful on `role: 'tool_result'`; absent everywhere else.
   */
  isError?: boolean;
}

export interface SessionFilter {
  platform?: string;
  keyPrefix?: string;
  personalityId?: string;
  workingDir?: string;
  since?: Date;
  limit?: number;
  offset?: number;
}

export interface SearchResult {
  sessionId: string;
  messageId: string;
  snippet: string;
  score: number;
  timestamp: Date;
}

/**
 * A persisted context-compaction event. Recorded every time a context engine
 * successfully compacts a session's LLM-facing history. The original messages
 * are never deleted from `messages` — this row only records what the agent
 * "remembered" at the moment of compaction, so a session stays auditable and
 * the LLM's view at turn N is reproducible.
 */
export interface CompressionEvent {
  id: string;
  sessionId: string;
  createdAt: Date;
  /** Context engine that produced the compaction (e.g. `semantic_summary`). */
  engineName: string;
  /** Message count before compaction. */
  originalCount: number;
  /** Message count after compaction. */
  keptCount: number;
  /** The synthetic summary text, when the engine produced one. */
  summaryText?: string;
  /**
   * Compaction watermark boundary. The id of the FIRST stored message kept
   * verbatim after this compaction — everything strictly older is represented
   * by `summaryText` (or dropped, for engines that don't summarize). When set,
   * the row is a replayable watermark: subsequent turns reconstruct the
   * LLM-facing history as `[summary, ...messages from this id onward]` instead
   * of shipping the raw prefix again. Absent on legacy rows and on engines that
   * produced no stable boundary.
   */
  keptFromMessageId?: string;
  /** Estimated token count of the summary message (0 when there is no summary). */
  summaryTokens: number;
  /** Estimated total context tokens (system + messages) before compaction. */
  preTotalTokens: number;
  /** Estimated total context tokens (system + messages) after compaction. */
  postTotalTokens: number;
  /** Wall-clock duration of the engine's `compact()` call. */
  durationMs: number;
}

export interface SessionStore {
  createSession(session: Omit<Session, 'id' | 'createdAt' | 'updatedAt'>): Promise<Session>;
  getSession(id: string): Promise<Session | null>;
  getSessionByKey(key: string): Promise<Session | null>;
  updateSession(id: string, patch: Partial<Session>): Promise<void>;
  deleteSession(id: string): Promise<void>;
  listSessions(filter?: SessionFilter): Promise<Session[]>;
  appendMessage(message: Omit<StoredMessage, 'id' | 'timestamp'>): Promise<StoredMessage>;
  getMessages(
    sessionId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<StoredMessage[]>;
  updateUsage(sessionId: string, delta: Partial<SessionUsage>): Promise<void>;
  /**
   * Search for messages by query text. Bounds are inclusive on `StoredMessage.timestamp`.
   * Both `since` and `until` are optional; provider behavior is open-ended when only one is supplied.
   */
  search(
    query: string,
    options?: { limit?: number; sessionId?: string; since?: Date; until?: Date },
  ): Promise<SearchResult[]>;
  /** Persist a context-compaction event. The original messages are untouched. */
  recordCompression(event: Omit<CompressionEvent, 'id' | 'createdAt'>): Promise<CompressionEvent>;
  /** List a session's compaction events, oldest first. */
  listCompressions(sessionId: string): Promise<CompressionEvent[]>;
  /**
   * Increment the session's turn counter and return the new turn number plus
   * the turn of the last compaction. Called once per agent turn; drives the
   * anti-thrashing compaction cooldown.
   */
  recordTurnStart(sessionId: string): Promise<{ turnNumber: number; lastCompactionTurn: number }>;
  /** Record the turn at which a compaction fired (for the cooldown gate). */
  recordCompactionTurn(sessionId: string, turnNumber: number): Promise<void>;
  undoTurns(sessionId: string, n: number): Promise<number>;
  pruneOldSessions(olderThan: Date): Promise<number>;
  vacuum(): Promise<void>;
}
