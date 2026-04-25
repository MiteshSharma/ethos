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
