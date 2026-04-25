import type { MemoryLoadContext, MemoryProvider, MemoryUpdate } from '@ethosagent/types';

export class NoopMemoryProvider implements MemoryProvider {
  async prefetch(_ctx: MemoryLoadContext) {
    return null;
  }

  async sync(_ctx: MemoryLoadContext, _updates: MemoryUpdate[]): Promise<void> {
    // No-op
  }
}
