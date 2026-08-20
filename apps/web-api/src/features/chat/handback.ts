import type { BackgroundJob } from '@ethosagent/types';

// Completion hand-back copy (pi-delegation §4.9 / D27).
//
// The run ends where it started: as a message in the PARENT conversation, from
// Ethos. Not the runner's tokens pasted into the chat — the chat keeps belonging
// to Ethos, and a delegated worker whose output nobody reads is a slower way to
// run a script.
//
// This is a TEMPLATE, not a model call. §4.9's "Ethos forms an opinion" reads as
// a summarising LLM pass, but nothing in the plan pins down which model, whose
// budget, or what happens when it fails — and a completion notice that can fail
// is worse than a plain one. So the facts the row already knows are stated
// plainly and the closing question is the invitation to go further. Swapping
// this for a real opinion later is a change at this one function.
//
// Templated on the runner (D19): the literal name of any harness appears
// nowhere in this file.

export interface RunHandBackInput {
  /** `JobRunner.name` — used as the display name, capitalised. */
  runner: string;
  label: string | undefined;
  status: BackgroundJob['status'];
  summary: string | undefined;
  error: string | undefined;
  spendUsd: number;
  elapsedMs: number | undefined;
}

/** Longest run summary quoted back into the conversation. */
const SUMMARY_CAP = 1_200;

export function formatRunHandBack(input: RunHandBackInput): string | null {
  // `aborted` is the user's own doing — they pressed Cancel and watched the card
  // go terminal. Announcing it back to them is noise, same call the CLI makes.
  if (input.status !== 'done' && input.status !== 'failed') return null;

  const runner = displayRunner(input.runner);
  const run = input.label ? `run ${input.label}` : 'the run';
  const cost = formatSpend(input.spendUsd);
  const elapsed = formatElapsed(input.elapsedMs);
  const meter = elapsed ? `${cost} in ${elapsed}` : cost;

  if (input.status === 'failed') {
    const reason = (input.error ?? '').trim() || 'no reason recorded';
    return [
      `${runner} failed ${run} after ${meter} — ${reason}.`,
      'Want me to dig into what went wrong, or start it again?',
    ].join('\n\n');
  }

  const summary = capText((input.summary ?? '').trim(), SUMMARY_CAP);
  return [
    `${runner} finished ${run} — ${meter}.`,
    ...(summary ? [summary] : []),
    'Want me to go through it before you look?',
  ].join('\n\n');
}

function displayRunner(runner: string): string {
  const trimmed = runner.trim();
  if (!trimmed) return 'The run';
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

function formatSpend(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

function formatElapsed(ms: number | undefined): string | null {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  if (min < 60) return sec === 0 ? `${min}m` : `${min}m ${sec}s`;
  const hours = Math.floor(min / 60);
  return `${hours}h ${min % 60}m`;
}

function capText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
