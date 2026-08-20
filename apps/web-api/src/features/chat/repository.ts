import type { Session, SessionStore } from '@ethosagent/types';

// Storage access for the chat feature. Wraps the subset of SessionStore
// operations that ChatService needs: create a session row before kicking
// off the bridge, look up a session by id, and update metadata (title).
// No business logic — that lives in service.ts.

export interface ChatSessionCreate {
  key: string;
  platform: string;
  model: string;
  provider: string;
  personalityId?: string;
  workingDir?: string;
}

export class ChatRepository {
  constructor(private readonly store: SessionStore) {}

  async create(input: ChatSessionCreate): Promise<Session> {
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

  async get(id: string): Promise<Session | null> {
    return this.store.getSession(id);
  }

  async update(id: string, patch: Partial<Pick<Session, 'title'>>): Promise<void> {
    const exists = await this.store.getSession(id);
    if (!exists) throw new Error(`session not found: ${id}`);
    await this.store.updateSession(id, patch);
  }

  /**
   * Persist one assistant message that no live turn produced — today, the
   * delegated-run completion hand-back (pi-delegation §4.9/D27). It goes through
   * the same `appendMessage` a turn uses, so a reload replays it in place rather
   * than as a notice that evaporated.
   */
  async appendAssistantMessage(sessionId: string, content: string): Promise<void> {
    await this.store.appendMessage({ sessionId, role: 'assistant', content });
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
