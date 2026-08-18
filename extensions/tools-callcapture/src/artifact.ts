// artifact.ts — assembles the call-capture transcript+summary markdown
// artifact and the digest-index line (plan/phases/call-capture-extension.md
// decision 7 storage/naming + decision 8 digest index).
//
// Mirrors `platform-meeting/src/transcript.ts`'s `buildTranscriptArtifact`
// shape (title / meta / `## Summary` / `## Transcript`) but cannot literally
// reuse it: `TranscriptEntry.speaker` here is a fixed `'you' | 'other'` union
// (decision 7's two-way attribution), not a free-text meeting-participant
// display name, and the summary is LLM-generated content, not a line-count
// roll-up (decision 7's "Correction to decision 4" — see summarize.ts).
//
// Key naming follows decision 7's flat filename-prefix convention:
// `MarkdownFileMemoryProvider.isSafeKey()` rejects any path separator, so
// there is no subdirectory support to build against — `<source>-<date>-<time>.md`
// is a plain file in the scope root, same as `buildTranscriptArtifact`'s
// `meeting-${now}.md`.

import type { TranscriptEntry } from '@ethosagent/platform-callcapture';
import { wrapUntrusted } from '@ethosagent/safety-injection';

/** Falls back to `'call'` per decision 7 when the caller-supplied source hint
 * is absent or not a plausible filename fragment — never lets an arbitrary
 * model-supplied string reach the memory key unsanitized. */
export function sanitizeSource(source: unknown): string {
  if (typeof source !== 'string') return 'call';
  const cleaned = source
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 32) : 'call';
}

/**
 * Formats one transcript line for the persisted artifact.
 *
 * "You" lines come from the operator's own mic — the same class of trust as
 * the user's own chat input, not adversary-controlled — so they are left
 * plain. "Other participant" lines are unauthenticated call audio: the same
 * laundering risk INB-003 fixed for `meet_join`'s participant speech, so
 * each one is individually wrapped in the `<untrusted>` provenance fence
 * before it is persisted to memory (the framework's default-TRUSTED store).
 *
 * This differs from `meet_join`'s blanket wrap-everything approach for a
 * concrete reason: `meet_join` wraps BOTH speakers because a Meet
 * participant's display name is self-chosen and therefore adversary-
 * controlled for either side. Here there is no participant-chosen name to
 * launder — the label is a fixed "You"/"Other participant" pair, never
 * model- or caller-supplied — so only the spoken content of the untrusted
 * side needs the fence.
 */
export function formatTranscriptLine(entry: TranscriptEntry, source: string): string {
  if (entry.speaker === 'you') {
    return `- **You:** ${entry.text}`;
  }
  const wrapped = wrapUntrusted({
    content: entry.text,
    toolName: 'call-capture',
    source,
  }).content;
  return `- **Other participant:** ${wrapped}`;
}

/** Builds the transcript body markdown from chronologically-sorted entries. */
export function buildTranscriptBody(entries: readonly TranscriptEntry[], source: string): string {
  if (entries.length === 0) return '_No speech was captured._';
  return entries.map((e) => formatTranscriptLine(e, source)).join('\n');
}

export interface CallCaptureArtifact {
  /** Memory key the artifact is stored under — a flat `.md` filename. */
  key: string;
  /** Full markdown document: title, meta, summary, and transcript body. */
  markdown: string;
}

export interface BuildArtifactInput {
  source: string;
  /** Wall-clock ms when capture started — used for both the filename and the header. */
  startedAt: number;
  /** Pre-formatted transcript body (see `buildTranscriptBody`). */
  body: string;
  /** Whether any speech was captured — gates summary wrapping below. */
  hasEntries: boolean;
  /** The (LLM-generated or plain-roll-up) summary text — not yet wrapped. */
  summary: string;
}

/**
 * Builds the one-file-per-call artifact: title, meta, `## Summary`,
 * `## Transcript` — matching `buildTranscriptArtifact`'s existing structure.
 */
export function buildCallCaptureArtifact(input: BuildArtifactInput): CallCaptureArtifact {
  const { date, time } = formatKeyTimestamp(input.startedAt);
  const key = `${input.source}-${date}-${time}.md`;
  const iso = new Date(input.startedAt).toISOString();
  const title = `Call transcript — ${iso}`;

  // The summary may echo or paraphrase other-participant speech even when
  // it was generated from an already-wrapped transcript — wrap it too
  // before persisting, same rationale as meet_join's `persistedSummary`.
  // Skipped when nothing was captured: the "No speech was captured" summary
  // carries no adversary-controlled content.
  const persistedSummary = input.hasEntries
    ? wrapUntrusted({
        content: input.summary,
        toolName: 'call-capture',
        source: input.source,
      }).content
    : input.summary;

  const markdown = [
    `# ${title}`,
    '',
    `- Source: ${input.source}`,
    `- Captured: ${iso}`,
    '',
    '## Summary',
    '',
    persistedSummary,
    '',
    '## Transcript',
    '',
    input.body,
    '',
  ].join('\n');

  return { key, markdown };
}

const MAX_SHORT_SUMMARY_CHARS = 140;

export interface BuildDigestLineInput {
  startedAt: number;
  source: string;
  /** The fuller per-call summary (LLM-generated or plain roll-up) to derive the short line from. */
  summary: string;
  key: string;
  /** Whether any speech was captured — gates untrusted wrapping below, same
   *  condition `buildCallCaptureArtifact` gates `persistedSummary` on. */
  hasEntries: boolean;
}

/**
 * Decision 8's rolling digest-index entry, appended to `call-captures-index.md`:
 * `- 2026-08-16 14:30 — zoom — <one-line summary> (see zoom-....md)`.
 *
 * The one-line summary is deliberately short — the first sentence of the
 * fuller summary, capped — not the full detail, which stays in the per-call
 * file and is read on demand. The short summary carries the same
 * adversary-controlled content risk `persistedSummary` above guards against
 * (it may echo or paraphrase other-participant speech), so it gets the same
 * `<untrusted>` fence — collapsed onto one physical line via
 * `inlineWrapUntrusted` so the index stays one-entry-per-line. Skipped when
 * `hasEntries` is false: the "No speech was captured" summary carries no
 * adversary-controlled content, same gating logic as `persistedSummary`.
 */
export function buildDigestLine(input: BuildDigestLineInput): string {
  const shortSummary = shortSummaryLine(input.summary);
  const summaryForLine = input.hasEntries
    ? inlineWrapUntrusted(shortSummary, input.source)
    : shortSummary;
  return `- ${formatDigestTimestamp(input.startedAt)} — ${input.source} — ${summaryForLine} (see ${input.key})`;
}

// wrapUntrusted's output is always `<untrusted ...>\n{content}\n</untrusted>` (one \n right
// after the opening tag, one \n right before the closing tag). shortSummaryLine() already
// guarantees no internal newlines in its input, so collapsing exactly those two structural
// newlines is safe and keeps the digest index's one-line-per-entry format intact. Do NOT
// strip all whitespace globally — only these two specific newlines.
function inlineWrapUntrusted(content: string, source: string): string {
  const wrapped = wrapUntrusted({ content, toolName: 'call-capture', source }).content;
  return wrapped.replace(/>\n/, '>').replace(/\n<\/untrusted>$/, '</untrusted>');
}

function shortSummaryLine(summary: string): string {
  const firstLine = summary.split('\n').find((l) => l.trim().length > 0) ?? summary;
  const sentenceMatch = firstLine.match(/^.*?[.!?](?=\s|$)/);
  const candidate = (sentenceMatch ? sentenceMatch[0] : firstLine).trim();
  if (candidate.length <= MAX_SHORT_SUMMARY_CHARS) return candidate;
  return `${candidate.slice(0, MAX_SHORT_SUMMARY_CHARS - 1).trimEnd()}…`;
}

function formatKeyTimestamp(ms: number): { date: string; time: string } {
  const iso = new Date(ms).toISOString();
  // Millisecond precision (not whole-second): two captures of the same
  // source within the same second — still possible even with at most one
  // daemon owner (e.g. two genuinely rapid back-to-back calls) — would
  // otherwise collide on one memory key and silently clobber via `action:
  // 'replace'`. `:`/`.` are stripped for filename safety.
  return { date: iso.slice(0, 10), time: iso.slice(11, 23).replace(/[:.]/g, '') };
}

function formatDigestTimestamp(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
