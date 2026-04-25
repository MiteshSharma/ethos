// Adversarial patterns that could hijack the system prompt if injected from
// untrusted skill files or project AGENTS.md files.
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
  /disregard\s+(your|all|any|the)\s+(previous|prior|above|system|original)\s+/i,
  /you\s+are\s+now\s+(a|an|the)\s+/i,
  /forget\s+(everything|all)\s+(you|above|prior)/i,
  /override\s+(your|all|the)\s+(instructions|rules|constraints|guidelines)/i,
  /new\s+(system\s+)?prompt\s*:/i,
  /\[SYSTEM\]/i,
  /<\s*system\s*>/i,
];

/**
 * Strip lines from injected content that contain adversarial prompt-injection
 * patterns. Each removed line is replaced with a marker so the gap is visible.
 */
export function sanitize(content: string): string {
  const lines = content.split('\n');
  const cleaned = lines.map((line) => {
    if (INJECTION_PATTERNS.some((re) => re.test(line))) {
      return '[line removed by injection guard]';
    }
    return line;
  });
  return cleaned.join('\n');
}
