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

  it('honors an explicit execution requirement even when an exec tool is present', () => {
    expect(
      resolveExecutionBackendName(p({ toolset: ['terminal'], execution: 'none' }), false),
    ).toBe('none');
  });

  it('maps a remote requirement to ssh, and NEVER to the host when no target exists', () => {
    // A requirement is not a preference. With no `execution.ssh.host` there is
    // nothing to connect to — and the answer is still `ssh`, refused by the
    // posture, never `local`. Resolving to the host here would run the work on
    // precisely the machine the personality said it did not belong on.
    expect(
      resolveExecutionBackendName(p({ toolset: ['terminal'], execution: 'remote' }), false),
    ).toBe('ssh');
    expect(
      resolveExecutionBackendName(p({ toolset: ['terminal'], execution: 'remote' }), true),
    ).toBe('ssh');
  });

  it('ignores an unrecognized execution override and falls back to tool inference', () => {
    expect(resolveExecutionBackendName(BOGUS_OVERRIDE, false)).toBe('docker');
  });
});
