import type { ToolResult } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import type { AgentLoopObservability } from '../../observability/agent-loop-observability';
import { recordMemoryWriteIfApplicable } from '../memory-telemetry';

// P2-counters — ethos_memory_writes_total must count actual writes, not read
// calls or rejected/invalid write attempts. See memory-telemetry.ts.

function makeObservability() {
  const recordMemoryWrite = vi.fn();
  const observability = { recordMemoryWrite } as unknown as AgentLoopObservability;
  return { observability, recordMemoryWrite };
}

const OK: ToolResult = { ok: true, value: 'Appended to MEMORY.md' };
const FAILED: ToolResult = {
  ok: false,
  error: 'store must be "memory" or "user"',
  code: 'input_invalid',
};

describe('recordMemoryWriteIfApplicable', () => {
  it('records a successful memory_write with store and action from args', () => {
    const { observability, recordMemoryWrite } = makeObservability();

    recordMemoryWriteIfApplicable(
      observability,
      'memory_write',
      { store: 'memory', action: 'add', content: 'x' },
      OK,
      't1',
    );

    expect(recordMemoryWrite).toHaveBeenCalledWith({
      traceId: 't1',
      store: 'memory',
      action: 'add',
    });
  });

  it('records a successful team_memory_write with store forced to "team"', () => {
    const { observability, recordMemoryWrite } = makeObservability();

    recordMemoryWriteIfApplicable(
      observability,
      'team_memory_write',
      { action: 'replace', key: 'architecture', content: 'x' },
      OK,
      't2',
    );

    expect(recordMemoryWrite).toHaveBeenCalledWith({
      traceId: 't2',
      store: 'team',
      action: 'replace',
    });
  });

  it('does not increment when the tool call was rejected/invalid (result.ok === false)', () => {
    const { observability, recordMemoryWrite } = makeObservability();

    recordMemoryWriteIfApplicable(
      observability,
      'memory_write',
      { store: 'memory', action: 'add', content: 'x' },
      FAILED,
      't3',
    );

    expect(recordMemoryWrite).not.toHaveBeenCalled();
  });

  it('does not increment for a non-memory-write tool call', () => {
    const { observability, recordMemoryWrite } = makeObservability();

    recordMemoryWriteIfApplicable(observability, 'memory_read', { store: 'both' }, OK, 't4');

    expect(recordMemoryWrite).not.toHaveBeenCalled();
  });

  it('is a no-op when observability is undefined', () => {
    expect(() =>
      recordMemoryWriteIfApplicable(
        undefined,
        'memory_write',
        { store: 'memory', action: 'add', content: 'x' },
        OK,
        't5',
      ),
    ).not.toThrow();
  });

  it('is a no-op when observability has no recordMemoryWrite (lighter adapter)', () => {
    const observability = {} as AgentLoopObservability;
    expect(() =>
      recordMemoryWriteIfApplicable(
        observability,
        'memory_write',
        { store: 'memory', action: 'add', content: 'x' },
        OK,
        't6',
      ),
    ).not.toThrow();
  });

  it('omits traceId when undefined', () => {
    const { observability, recordMemoryWrite } = makeObservability();

    recordMemoryWriteIfApplicable(
      observability,
      'memory_write',
      { store: 'user', action: 'remove', substring_match: 'foo' },
      OK,
      undefined,
    );

    expect(recordMemoryWrite).toHaveBeenCalledWith({ store: 'user', action: 'remove' });
  });
});
