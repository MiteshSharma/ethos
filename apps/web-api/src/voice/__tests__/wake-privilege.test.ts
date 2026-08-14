import type { PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { isPrivilegedPersonality } from '../wake-privilege';

// The wake surface's access control, until speaker-ID lands. What is being
// pinned here is the DEFINITION — "privileged" means the toolset can reach a
// tool the approval layer would already stop and ask about — not a hand-written
// list of personality names.

function p(toolset?: string[]): PersonalityConfig {
  return { id: 'x', name: 'X', ...(toolset ? { toolset } : {}) };
}

describe('isPrivilegedPersonality', () => {
  it('treats a shell-capable personality as privileged', () => {
    expect(isPrivilegedPersonality(p(['read_file', 'terminal']))).toBe(true);
  });

  it('treats a file-writing personality as privileged', () => {
    expect(isPrivilegedPersonality(p(['write_file']))).toBe(true);
    expect(isPrivilegedPersonality(p(['patch_file']))).toBe(true);
    expect(isPrivilegedPersonality(p(['process_start']))).toBe(true);
  });

  it('covers the approval-surface set too, not just the smart-mode one', () => {
    // `call` dials someone's phone in the operator's name — the least
    // reversible thing in the registry, and reachable from across a room.
    expect(isPrivilegedPersonality(p(['call']))).toBe(true);
    expect(isPrivilegedPersonality(p(['skills_pending_approve']))).toBe(true);
  });

  it('leaves a read-only personality on the default wake surface', () => {
    expect(
      isPrivilegedPersonality(p(['web_search', 'read_file', 'memory_read', 'session_search'])),
    ).toBe(false);
    expect(isPrivilegedPersonality(p([]))).toBe(false);
  });

  it('treats an unrestricted toolset as privileged — fail closed', () => {
    // No `toolset` means every registered tool, consequential ones included.
    // The cost of a false positive is one config line; the cost of a false
    // negative is a stranger at the window running `terminal`.
    expect(isPrivilegedPersonality(p())).toBe(true);
  });
});
