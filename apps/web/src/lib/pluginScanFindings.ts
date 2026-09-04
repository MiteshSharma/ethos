import type { PluginScanFinding } from '@ethosagent/web-contracts';

// The safety scanner names its rules in slugs. A slug alone tells an operator
// nothing about what their plugin actually does — `network-access` on a
// market-data plugin means "it fetches market data", which is the reason the
// plugin was installed. These are the plain-language readings shown in the UI.
const RULE_COPY: Record<string, string> = {
  'network-access': 'Makes outbound network calls',
  'shell-exec': 'Runs shell commands',
  'dynamic-code-exec': 'Builds and runs code at runtime',
  'credential-access': 'Reads credentials or environment variables',
  'fs-write-outside-safe-path': 'Writes files outside its own directory',
  'exfil-shape': 'Sends local data to an outside destination',
};

/** Plain-language reading of a scanner rule. Falls back to the slug. */
export function describeScanRule(rule: string): string {
  return RULE_COPY[rule] ?? rule;
}

/** How many findings of each severity, for the summary line. */
export function countBySeverity(findings: PluginScanFinding[]): { red: number; yellow: number } {
  let red = 0;
  let yellow = 0;
  for (const f of findings) {
    if (f.severity === 'red') red += 1;
    else yellow += 1;
  }
  return { red, yellow };
}

/** `src/index.ts:42`, `src/index.ts`, or null when the scanner reported neither. */
export function findingLocation(finding: PluginScanFinding): string | null {
  if (!finding.file) return finding.line == null ? null : `line ${finding.line}`;
  return finding.line == null ? finding.file : `${finding.file}:${finding.line}`;
}
