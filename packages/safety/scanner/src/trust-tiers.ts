import type { ScanResult, TierPolicy, TrustTier } from './types';

/**
 * Shipped default trusted GitHub organizations. Matched by exact segment
 * against the first two path segments of a `github.com/<org>/<repo>` source
 * string. Prefix matching (startsWith) is NOT used — it would allow an
 * attacker slug like `github.com/ethosagent/../../evil` to pass.
 *
 * This is a DEFAULT, not a floor: an operator replaces it wholesale via
 * `security.trusted_github_orgs` in `~/.ethos/config.yaml`, which reaches
 * this module as `TrustTierOptions.trustedGitHubOrgs`. Removing `anthropic`
 * — or trusting no org at all — must be expressible, so the configured value
 * replaces this list rather than extending it.
 */
export const DEFAULT_TRUSTED_GITHUB_ORGS: readonly string[] = ['ethosagent', 'anthropic'];

export interface TrustTierOptions {
  /**
   * Operator-configured trusted GitHub organizations, passed down from the
   * composition root (`packages/safety/*` is a Tier 0 kernel package — it
   * imports contracts only and never reads config or the environment at use
   * time).
   *
   * - `undefined` — not configured; `DEFAULT_TRUSTED_GITHUB_ORGS` applies.
   * - `[]` — configured empty; NO organization is trusted. This is a
   *   meaningful value and must not fall back to the default.
   */
  trustedGitHubOrgs?: readonly string[];
}

/**
 * Extract the organization segment from a `github.com/<org>/…` source.
 * Returns `undefined` when the source is not a valid github.com path
 * with at least an org and repo segment, or when any segment contains
 * path-traversal components (`.` or `..`).
 */
function extractGitHubOrg(source: string): string | undefined {
  if (!source.startsWith('github.com/')) return undefined;
  const rest = source.slice('github.com/'.length);
  const segments = rest.split('/');
  // Need at least org + repo (two non-empty segments).
  if (segments.length < 2) return undefined;
  const org = segments[0];
  if (!org || org === '.' || org === '..') return undefined;
  // Reject path traversal anywhere in the segments.
  if (segments.some((s) => s === '.' || s === '..')) return undefined;
  return org;
}

export function deriveTier(source: string, opts: TrustTierOptions = {}): TrustTier {
  if (source === 'builtin') return 'builtin';

  // `??` — and NOT `||` or a `.length` check — is what distinguishes "not
  // configured" (undefined → default) from "configured empty" (`[]` → trust
  // nobody by org).
  const trustedOrgs = opts.trustedGitHubOrgs ?? DEFAULT_TRUSTED_GITHUB_ORGS;
  const org = extractGitHubOrg(source);
  if (org && trustedOrgs.includes(org)) return 'trusted-repo';

  // community: clawhub, hermeshub, arbitrary github (not in trusted list)
  if (
    source.startsWith('clawhub/') ||
    source.startsWith('hermeshub/') ||
    source.startsWith('github.com/')
  )
    return 'community';
  // local path or raw URL
  return 'untrusted';
}

/**
 * `autoAcknowledgeYellow` is `builtin`-only. `builtin` means code shipped
 * inside this repository — a claim about provenance we can actually make.
 * "A repo owned by an org someone listed" is a different, weaker claim, so
 * `trusted-repo` no longer silently acknowledges yellow findings; they
 * surface and the operator acknowledges them.
 *
 * `trusted-repo` keeps `canOverrideRed` deliberately. It never fires on its
 * own — `canInstall` honours it only alongside an explicit `force` — so it
 * buys the operator a lever, not a silent pass, and the operator is the one
 * who put the org on the list. It is also the only thing left distinguishing
 * `trusted-repo` from `community`; collapsing the two would make the tier
 * vestigial. The residual risk is stated plainly: a red finding in a
 * configured org is overridable with `--force`.
 */
export function getTierPolicy(tier: TrustTier): TierPolicy {
  switch (tier) {
    case 'builtin':
      return { tier, canOverrideRed: true, autoAcknowledgeYellow: true };
    case 'trusted-repo':
      return { tier, canOverrideRed: true, autoAcknowledgeYellow: false };
    case 'community':
      return { tier, canOverrideRed: false, autoAcknowledgeYellow: false };
    case 'untrusted':
      return { tier, canOverrideRed: false, autoAcknowledgeYellow: false };
  }
}

export interface InstallDecision {
  allowed: boolean;
  blockedBy?: string;
}

/**
 * Decide whether a scan result allows install given the trust tier.
 * `force` is only respected when the tier's policy allows override.
 */
export function canInstall(
  result: ScanResult,
  tier: TrustTier,
  opts: { force?: boolean } = {},
): InstallDecision {
  const policy = getTierPolicy(tier);

  if (result.hasRed) {
    if (policy.canOverrideRed && opts.force) {
      return { allowed: true };
    }
    return {
      allowed: false,
      blockedBy: policy.canOverrideRed
        ? 'red findings (pass --force to override)'
        : 'red findings (community/untrusted tier — cannot override)',
    };
  }

  if (result.hasYellow && !policy.autoAcknowledgeYellow) {
    // Every tier but `builtin` requires per-finding acknowledgment — in the CLI this
    // means the user must confirm; in the API we treat unacknowledged yellow as blocking.
    if (!opts.force) {
      return {
        allowed: false,
        blockedBy: 'yellow findings require acknowledgment (source is not builtin)',
      };
    }
  }

  return { allowed: true };
}
