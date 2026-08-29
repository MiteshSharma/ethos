// CLI clarify prompt — formatting + answer parsing for the readline surface.
// Kept pure (no readline, no ANSI side effects) so it is unit-testable; the
// presenter wiring in chat.ts handles the actual stdin/stdout dance.

import type { PendingClarify } from '@ethosagent/types';

/**
 * Human-readable "in 14m" / "in 45s" for the default-timeout hint.
 * `deadlineAt` is `null` while a clarify is still queued behind another one
 * in the same lane (D2) — no timer has started yet.
 */
export function formatCountdown(deadlineAt: string | null, now: number = Date.now()): string {
  if (deadlineAt === null) return 'queued';
  const ms = new Date(deadlineAt).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'now';
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  return `${Math.round(totalSec / 60)}m`;
}

/**
 * Render the multi-line prompt block printed when a clarify request arrives.
 * Ends without a newline so the caller can append its `?> ` input cursor.
 */
export function formatClarifyPrompt(req: PendingClarify, now: number = Date.now()): string {
  const lines = [`? ${req.question}`];
  if (req.options && req.options.length > 0) {
    lines.push(`  ${req.options.map((opt, i) => `${i + 1}) ${opt}`).join('   ')}`);
  }
  const hint: string[] = [];
  if (req.default !== undefined) {
    hint.push(`default \`${req.default}\` in ${formatCountdown(req.defaultDeadlineAt, now)}`);
  }
  hint.push('ctrl-c to cancel');
  lines.push(`  (${hint.join(', ')})`);
  return `${lines.join('\n')}\n`;
}

/**
 * Resolve a typed line into the answer string. With `options`, a bare number
 * selects by 1-based index and a case-insensitive exact match selects that
 * option; anything else (and every free-form question) passes through verbatim.
 */
export function parseClarifyAnswer(line: string, options?: string[]): string {
  const trimmed = line.trim();
  if (!options || options.length === 0) return trimmed;

  const asIndex = Number(trimmed);
  if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= options.length) {
    return options[asIndex - 1] ?? trimmed;
  }
  const exact = options.find((opt) => opt.toLowerCase() === trimmed.toLowerCase());
  return exact ?? trimmed;
}
