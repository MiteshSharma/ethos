import type {
  ContextEvent,
  ContextLog,
  SearchResult,
  Session,
  SessionFilter,
  SessionStore,
  StoredMessage,
} from '@ethosagent/types';

// Thin wrapper over the `SessionStore` contract for the sessions feature.
// Hides the store's exact method names and Date/string conversions from
// the service layer so swapping backends (e.g. an in-memory store for
// tests, or a future vector-aware variant) doesn't require service changes.
//
// Cursor pagination uses base64-encoded offsets for now. Switching to a
// rowid-keyed cursor later is a non-breaking change — the cursor is opaque
// to the client.

/**
 * The subset of `ContextLog` behavior `fork()` needs: the 3 shared methods
 * plus `listForSession`, which is intentionally NOT part of the shared
 * `ContextLog` contract (plan/phases/model-visible-logged.md D5 — "keep it
 * small"; only this Phase E consumer needs raw per-session event history
 * rather than `resolveAt`'s merged projection). `SQLiteContextLog` satisfies
 * this structurally — no adapter needed.
 */
export interface ForkableContextLog extends ContextLog {
  listForSession(sessionId: string): Promise<ContextEvent[]>;
}

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
  /**
   * `contextLog` is optional — 25+ test files across `apps/web-api/src/__tests__/`
   * construct `SessionsRepository` (or call `createWebApi`) with no notion of a
   * context log, and making it required would force a much wider, out-of-scope
   * blast radius. Absent means `fork()` silently skips context-event copying
   * (today's behavior), which is correct: a session created before this
   * feature, or a deployment that hasn't wired one, has no context events to
   * copy anyway.
   */
  constructor(
    private readonly store: SessionStore,
    private readonly contextLog?: ForkableContextLog,
  ) {}

  async list(opts: ListOptions): Promise<ListPage> {
    if (opts.q?.trim()) {
      // store.search() uses a phrase-quoted FTS5 query, so multi-word queries
      // require per-term searches intersected by sessionId. Single-word queries
      // go through as-is.
      const terms = opts.q.trim().split(/\s+/).filter(Boolean);
      // Use a large internal limit so the intersection isn't artificially
      // truncated — a session that matches all terms might rank outside the
      // top opts.limit results for a single term.
      const termLimit = Math.max(opts.limit * 10, 100);
      const termResults = await Promise.all(
        terms.map((t) => this.store.search(t, { limit: termLimit })),
      );
      // Build a set of session IDs that appear in ALL term result sets.
      const sets = termResults.map((rs) => new Set(rs.map((r) => r.sessionId)));
      const [firstSet, ...restSets] = sets;
      const intersected = firstSet
        ? [...firstSet].filter((id) => restSets.every((s) => s.has(id)))
        : [];
      // Apply the caller's limit after intersection.
      const matchedIds = intersected.slice(0, opts.limit);
      const sessions = (await Promise.all(matchedIds.map((id) => this.store.getSession(id))))
        .filter((s): s is Session => s !== null)
        .filter((s) => !s.key.startsWith('goal:'));
      return { sessions, nextCursor: null };
    }

    const offset = decodeCursor(opts.cursor);
    const filter: SessionFilter & { excludeKeyPrefixes?: string[] } = {
      limit: opts.limit + 1,
      offset,
      excludeKeyPrefixes: ['goal:'],
    };
    if (opts.personalityId) filter.personalityId = opts.personalityId;

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

  async update(id: string, patch: { title?: string | null; pinned?: boolean }): Promise<void> {
    const exists = await this.store.getSession(id);
    if (!exists) throw new Error(`session not found: ${id}`);
    const updatePatch: Partial<import('@ethosagent/types').Session> = {};
    if (patch.title !== undefined) {
      updatePatch.title = patch.title as string | undefined;
    }
    if (patch.pinned !== undefined) {
      updatePatch.pinned = patch.pinned;
    }
    await this.store.updateSession(id, updatePatch);
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
    //
    // `appendMessage` always assigns a fresh id/timestamp — there is no way to
    // preserve the source message's id (or its original timestamp) on the copy.
    // Track old id -> new StoredMessage so context events (keyed by the
    // SOURCE's message ids) can be remapped onto the fork below; without this,
    // `resolveContextAt(fork.id, <fork message id>)` could never find
    // anything, since the copied event's `messageId` would reference an id
    // that doesn't exist in the fork.
    const history = await this.store.getMessages(source.id);
    const idMap = new Map<string, StoredMessage>();
    for (const msg of history) {
      const appended = await this.store.appendMessage({
        sessionId: fresh.id,
        role: msg.role,
        content: msg.content,
        ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
        ...(msg.toolName ? { toolName: msg.toolName } : {}),
        ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
        ...(msg.usage ? { usage: msg.usage } : {}),
      });
      idMap.set(msg.id, appended);
    }

    // Copy context events onto the child (plan/phases/model-visible-logged.md
    // D9) so `resolveContextAt` on the fork still reproduces what the parent
    // saw. `hash`/`kind`/`mode`/`meta` are copied UNCHANGED — the referenced
    // CAS blobs are content-addressed and global (not per-session), so only
    // the log rows are copied, never the blobs.
    //
    // `timestamp` is deliberately NOT copied unchanged (a deviation from the
    // original brief for this task, flagged here because it fixes a bug that
    // brief's own reasoning had): `resolveAt` picks the newest event with
    // `timestamp <= target message's timestamp`. Every replayed message above
    // gets a FRESH, later "now" timestamp (there is no way to preserve the
    // original one — see the loop above), so if a copied event kept its
    // original (always-earlier) timestamp, EVERY child message would query as
    // "after all copied events" and last-write-wins would collapse to the
    // single latest event for every turn — losing exactly the pre-/post-
    // hot-reload distinction this is supposed to preserve. Stamping each
    // copied event with the timestamp of the specific new message it was
    // remapped onto keeps the events ordered against each other exactly as
    // before (insertion order is preserved) while keeping each one correctly
    // "in the past" relative to only the later turns, so `resolveContextAt`
    // on the fork reproduces the parent's per-turn history, not just its
    // final state.
    //
    // `contentBlocks`/`traceId` are deliberately NOT copied here (D9) —
    // pre-existing gaps in this same message-copy loop, left as a named
    // follow-up rather than silently expanded.
    if (this.contextLog) {
      const events = await this.contextLog.listForSession(source.id);
      for (const event of events) {
        const newMessage = idMap.get(event.messageId);
        if (!newMessage) continue; // defensive; should not happen in practice
        await this.contextLog.append({
          ...event,
          sessionId: fresh.id,
          messageId: newMessage.id,
          timestamp: newMessage.timestamp.getTime(),
        });
      }
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
