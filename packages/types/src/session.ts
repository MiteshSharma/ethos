import type { TokenUsage } from './llm';

export interface Session {
  id: string;
  key: string;
  platform: string;
  model: string;
  provider: string;
  personalityId?: string;
  parentSessionId?: string;
  workingDir?: string;
  title?: string;
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

export type MessageRole = 'user' | 'assistant' | 'tool_result' | 'system';

export interface StoredMessage {
  id: string;
  sessionId: string;
  role: MessageRole;
  content: string;
  toolCallId?: string;
  toolName?: string;
  toolCalls?: Array<{ id: string; name: string; input: unknown }>;
  timestamp: Date;
  usage?: TokenUsage;
}

export interface SessionFilter {
  platform?: string;
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
  search(query: string, options?: { limit?: number; sessionId?: string }): Promise<SearchResult[]>;
  pruneOldSessions(olderThan: Date): Promise<number>;
  vacuum(): Promise<void>;
}
