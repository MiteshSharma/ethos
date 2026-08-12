import { describe, expect, it } from 'vitest';
import { canInstall, DEFAULT_TRUSTED_GITHUB_ORGS, deriveTier, getTierPolicy } from '../trust-tiers';
import type { ScanResult } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function noFindings(): ScanResult {
  return { findings: [], hasRed: false, hasYellow: false };
}

function redFindings(): ScanResult {
  return {
    findings: [{ severity: 'red', rule: 'test', message: 'test red' }],
    hasRed: true,
    hasYellow: false,
  };
}

function yellowFindings(): ScanResult {
  return {
    findings: [{ severity: 'yellow', rule: 'test', message: 'test yellow' }],
    hasRed: false,
    hasYellow: true,
  };
}

// ---------------------------------------------------------------------------
// deriveTier
// ---------------------------------------------------------------------------

describe('deriveTier', () => {
  it('returns "builtin" for the literal string "builtin"', () => {
    expect(deriveTier('builtin')).toBe('builtin');
  });

  it('returns "trusted-repo" for github.com/ethosagent/ prefix', () => {
    expect(deriveTier('github.com/ethosagent/some-skill')).toBe('trusted-repo');
  });

  it('returns "trusted-repo" for github.com/anthropic/ prefix', () => {
    expect(deriveTier('github.com/anthropic/tools')).toBe('trusted-repo');
  });

  it('returns "community" for arbitrary github.com URL', () => {
    expect(deriveTier('github.com/random-user/hack')).toBe('community');
  });

  it('returns "community" for clawhub/ prefix', () => {
    expect(deriveTier('clawhub/some-skill')).toBe('community');
  });

  it('returns "community" for hermeshub/ prefix', () => {
    expect(deriveTier('hermeshub/my-skill')).toBe('community');
  });

  it('returns "untrusted" for local path', () => {
    expect(deriveTier('/local/path/skill')).toBe('untrusted');
  });

  it('returns "untrusted" for raw HTTP URL', () => {
    expect(deriveTier('https://my-server.com/skill')).toBe('untrusted');
  });

  it('returns "untrusted" for relative path', () => {
    expect(deriveTier('./my-skill')).toBe('untrusted');
  });

  it('rejects a traversal segment in the org position', () => {
    expect(deriveTier('github.com/../ethosagent/skill')).toBe('community');
    expect(deriveTier('github.com/./repo')).toBe('community');
  });

  it('rejects a traversal segment anywhere in the path', () => {
    expect(deriveTier('github.com/ethosagent/../../evil')).toBe('community');
    expect(deriveTier('github.com/ethosagent/./evil')).toBe('community');
  });

  it('does not prefix-match the org segment', () => {
    expect(deriveTier('github.com/ethosagent-evil/skill')).toBe('community');
  });

  it('requires both an org and a repo segment', () => {
    expect(deriveTier('github.com/ethosagent')).toBe('community');
  });
});

// ---------------------------------------------------------------------------
// deriveTier — operator-configurable trusted orgs
// ---------------------------------------------------------------------------

describe('deriveTier — configurable trusted orgs', () => {
  it('applies the shipped default when trustedGitHubOrgs is not configured', () => {
    expect(DEFAULT_TRUSTED_GITHUB_ORGS).toEqual(['ethosagent', 'anthropic']);
    for (const org of DEFAULT_TRUSTED_GITHUB_ORGS) {
      expect(deriveTier(`github.com/${org}/thing`)).toBe('trusted-repo');
      expect(deriveTier(`github.com/${org}/thing`, {})).toBe('trusted-repo');
      expect(deriveTier(`github.com/${org}/thing`, { trustedGitHubOrgs: undefined })).toBe(
        'trusted-repo',
      );
    }
  });

  it('a configured set REPLACES the default rather than merging with it', () => {
    const opts = { trustedGitHubOrgs: ['acme-corp'] };
    expect(deriveTier('github.com/acme-corp/skill', opts)).toBe('trusted-repo');
    // Both shipped defaults are gone — an operator can drop `anthropic`.
    expect(deriveTier('github.com/anthropic/tools', opts)).toBe('community');
    expect(deriveTier('github.com/ethosagent/some-skill', opts)).toBe('community');
  });

  it('an operator can keep one default org while dropping the other', () => {
    const opts = { trustedGitHubOrgs: ['ethosagent'] };
    expect(deriveTier('github.com/ethosagent/some-skill', opts)).toBe('trusted-repo');
    expect(deriveTier('github.com/anthropic/tools', opts)).toBe('community');
  });

  it('an empty configured set trusts no org and does not fall back to the default', () => {
    const opts = { trustedGitHubOrgs: [] };
    expect(deriveTier('github.com/ethosagent/some-skill', opts)).toBe('community');
    expect(deriveTier('github.com/anthropic/tools', opts)).toBe('community');
    expect(deriveTier('github.com/acme-corp/skill', opts)).toBe('community');
  });

  it('an org outside the configured set resolves to community', () => {
    expect(deriveTier('github.com/random-user/hack', { trustedGitHubOrgs: ['acme-corp'] })).toBe(
      'community',
    );
  });

  it('keeps the traversal rejection under a configured set', () => {
    const opts = { trustedGitHubOrgs: ['acme-corp'] };
    expect(deriveTier('github.com/acme-corp/../../evil', opts)).toBe('community');
    expect(deriveTier('github.com/acme-corp-evil/skill', opts)).toBe('community');
  });

  it('never promotes a non-github source, however the set is configured', () => {
    const opts = { trustedGitHubOrgs: ['acme-corp'] };
    expect(deriveTier('clawhub/acme-corp', opts)).toBe('community');
    expect(deriveTier('/local/acme-corp/skill', opts)).toBe('untrusted');
    expect(deriveTier('https://acme-corp.example.com/skill', opts)).toBe('untrusted');
  });

  it('still resolves "builtin" ahead of any org configuration', () => {
    expect(deriveTier('builtin', { trustedGitHubOrgs: [] })).toBe('builtin');
  });
});

// ---------------------------------------------------------------------------
// getTierPolicy
// ---------------------------------------------------------------------------

describe('getTierPolicy', () => {
  it('builtin: can override red, auto-acknowledges yellow', () => {
    const p = getTierPolicy('builtin');
    expect(p.tier).toBe('builtin');
    expect(p.canOverrideRed).toBe(true);
    expect(p.autoAcknowledgeYellow).toBe(true);
  });

  it('trusted-repo: can override red, does NOT auto-acknowledge yellow', () => {
    const p = getTierPolicy('trusted-repo');
    expect(p.tier).toBe('trusted-repo');
    expect(p.canOverrideRed).toBe(true);
    expect(p.autoAcknowledgeYellow).toBe(false);
  });

  it('builtin is the only tier that auto-acknowledges yellow', () => {
    const tiers = ['builtin', 'trusted-repo', 'community', 'untrusted'] as const;
    const autoAck = tiers.filter((t) => getTierPolicy(t).autoAcknowledgeYellow);
    expect(autoAck).toEqual(['builtin']);
  });

  it('community: cannot override red, does not auto-acknowledge yellow', () => {
    const p = getTierPolicy('community');
    expect(p.tier).toBe('community');
    expect(p.canOverrideRed).toBe(false);
    expect(p.autoAcknowledgeYellow).toBe(false);
  });

  it('untrusted: cannot override red, does not auto-acknowledge yellow', () => {
    const p = getTierPolicy('untrusted');
    expect(p.tier).toBe('untrusted');
    expect(p.canOverrideRed).toBe(false);
    expect(p.autoAcknowledgeYellow).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// canInstall
// ---------------------------------------------------------------------------

describe('canInstall — no findings', () => {
  it('allows install for builtin with no findings', () => {
    expect(canInstall(noFindings(), 'builtin').allowed).toBe(true);
  });

  it('allows install for trusted-repo with no findings', () => {
    expect(canInstall(noFindings(), 'trusted-repo').allowed).toBe(true);
  });

  it('allows install for community with no findings', () => {
    expect(canInstall(noFindings(), 'community').allowed).toBe(true);
  });

  it('allows install for untrusted with no findings', () => {
    expect(canInstall(noFindings(), 'untrusted').allowed).toBe(true);
  });
});

describe('canInstall — red findings', () => {
  it('blocks install for community tier even with force', () => {
    const decision = canInstall(redFindings(), 'community', { force: true });
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain('cannot override');
  });

  it('blocks install for untrusted tier even with force', () => {
    const decision = canInstall(redFindings(), 'untrusted', { force: true });
    expect(decision.allowed).toBe(false);
  });

  it('allows install for trusted-repo with red finding and force=true', () => {
    const decision = canInstall(redFindings(), 'trusted-repo', { force: true });
    expect(decision.allowed).toBe(true);
  });

  it('blocks install for trusted-repo with red finding and force=false', () => {
    const decision = canInstall(redFindings(), 'trusted-repo', { force: false });
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain('pass --force');
  });

  it('blocks install for trusted-repo with red finding and no opts', () => {
    const decision = canInstall(redFindings(), 'trusted-repo');
    expect(decision.allowed).toBe(false);
  });

  it('allows install for builtin with red finding and force=true', () => {
    const decision = canInstall(redFindings(), 'builtin', { force: true });
    expect(decision.allowed).toBe(true);
  });
});

describe('canInstall — yellow findings', () => {
  it('allows install for builtin with yellow findings (auto-acknowledged)', () => {
    expect(canInstall(yellowFindings(), 'builtin').allowed).toBe(true);
  });

  it('blocks install for trusted-repo with yellow findings and no force', () => {
    const decision = canInstall(yellowFindings(), 'trusted-repo');
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain('acknowledgment');
  });

  it('allows install for trusted-repo with yellow findings and force=true', () => {
    expect(canInstall(yellowFindings(), 'trusted-repo', { force: true }).allowed).toBe(true);
  });

  it('blocks install for untrusted with yellow findings and no force', () => {
    const decision = canInstall(yellowFindings(), 'untrusted');
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy).toContain('acknowledgment');
  });

  it('allows install for untrusted with yellow findings and force=true', () => {
    const decision = canInstall(yellowFindings(), 'untrusted', { force: true });
    expect(decision.allowed).toBe(true);
  });

  it('blocks install for community with yellow findings and no force', () => {
    const decision = canInstall(yellowFindings(), 'community');
    expect(decision.allowed).toBe(false);
  });

  it('allows install for community with yellow findings and force=true', () => {
    const decision = canInstall(yellowFindings(), 'community', { force: true });
    expect(decision.allowed).toBe(true);
  });
});
