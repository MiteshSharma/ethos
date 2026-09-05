import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { resolveExecutionBackendName } from '../resolve-execution-backend';

function p(extra: Partial<PersonalityConfig> & Record<string, unknown>): PersonalityConfig {
  return { id: 'p', name: 'p', ...extra } as unknown as PersonalityConfig;
}

// See the same constant in resolve-execution-posture.test.ts: an unrecognised
// `execution` value is unwritable in TypeScript but reachable from disk.
const BOGUS_OVERRIDE = {
  id: 'p',
  name: 'p',
  toolset: ['terminal'],
  execution: 'bogus',
} as unknown as PersonalityConfig;

describe('resolveExecutionBackendName', () => {
  it('selects docker for the terminal tool', () => {
    expect(resolveExecutionBackendName(p({ toolset: ['terminal'] }), false)).toBe('docker');
  });

  it('selects docker for the run_code tool', () => {
    expect(resolveExecutionBackendName(p({ toolset: ['run_code'] }), false)).toBe('docker');
  });

  it('selects docker for any process_* tool', () => {
    expect(resolveExecutionBackendName(p({ toolset: ['process_start'] }), false)).toBe('docker');
  });

  it('selects none for a chat-only personality (no exec tool)', () => {
    expect(resolveExecutionBackendName(p({ toolset: ['memory_read', 'web_search'] }), false)).toBe(
      'none',
    );
  });

  it('selects none when toolset is absent', () => {
    expect(resolveExecutionBackendName(p({}), false)).toBe('none');
  });

  it('honors an explicit execution override even when an exec tool is present', () => {
    expect(
      resolveExecutionBackendName(p({ toolset: ['terminal'], execution: 'local' }), false),
    ).toBe('local');
    expect(
      resolveExecutionBackendName(p({ toolset: ['terminal'], execution: 'none' }), false),
    ).toBe('none');
  });

  it('resolves an ssh override to ssh only when a target is configured', () => {
    // `sshConfigured: false` — nothing to connect to, so the honest answer is
    // `local` (host), never a posture claiming a remote machine.
    expect(resolveExecutionBackendName(p({ toolset: ['terminal'], execution: 'ssh' }), false)).toBe(
      'local',
    );
    expect(resolveExecutionBackendName(p({ toolset: ['terminal'], execution: 'ssh' }), true)).toBe(
      'ssh',
    );
  });

  it('ignores an unrecognized execution override and falls back to tool inference', () => {
    expect(resolveExecutionBackendName(BOGUS_OVERRIDE, false)).toBe('docker');
  });
});
