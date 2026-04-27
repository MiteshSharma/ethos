export interface MemoryContext {
  content: string;
  source: 'markdown' | 'vector' | 'honcho' | 'custom';
  truncated: boolean;
}

export interface MemoryLoadContext {
  sessionId: string;
  sessionKey: string;
  userId?: string;
  platform: string;
  workingDir?: string;
  personalityId?: string;
  /**
   * Resolved memory scope for the active personality. Providers that support
   * scoping (e.g. MarkdownFileMemoryProvider) route 'per-personality' writes
   * into a personality-isolated path; 'global' (or undefined) writes to the
   * shared root. AgentLoop fills this from the resolved personality.
   */
  memoryScope?: 'global' | 'per-personality';
  /** Current user message — used by VectorMemoryProvider for semantic retrieval */
  query?: string;
}

export type MemoryStore = 'memory' | 'user';

export interface MemoryUpdate {
  store: MemoryStore;
  action: 'add' | 'replace' | 'remove';
  content: string;
  substringMatch?: string;
}

export interface MemoryProvider {
  prefetch(ctx: MemoryLoadContext): Promise<MemoryContext | null>;
  sync(ctx: MemoryLoadContext, updates: MemoryUpdate[]): Promise<void>;
}
