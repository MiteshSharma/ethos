import type { StoredMessage } from './session';

export interface PromptContext {
  sessionId: string;
  sessionKey: string;
  platform: string;
  model: string;
  history: StoredMessage[];
  workingDir?: string;
  isDm: boolean;
  turnNumber: number;
  personalityId?: string;
  // Mutable side-channel: injectors write metadata here; AgentLoop emits it as context_meta event.
  meta?: Record<string, unknown>;
}

export interface InjectionResult {
  content: string;
  position?: 'prepend' | 'append';
  section?: string;
}

export interface ContextInjector {
  readonly id: string;
  readonly priority: number;
  inject(ctx: PromptContext): Promise<InjectionResult | null>;
  shouldInject?(ctx: PromptContext): boolean;
}
