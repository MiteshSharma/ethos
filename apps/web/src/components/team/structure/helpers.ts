import type { KanbanTask, Personality, TeamDetail } from '@ethosagent/web-contracts';

// Small pure helpers the Structure canvas and its sheets share.

/** The model a personality routes to, as one string; null when unset. */
export function modelLabel(personality: Personality | undefined): string | null {
  const m = personality?.model;
  if (!m) return null;
  if (typeof m === 'string') return m;
  return m.default ?? m.trivial ?? m.deep ?? null;
}

/** Tickets that are neither `done` nor `archived`. */
export function openCount(tasks: readonly KanbanTask[]): number {
  return tasks.filter((t) => t.status !== 'done' && t.status !== 'archived').length;
}

export function trustMode(team: Pick<TeamDetail, 'trustPolicy'>): string {
  return team.trustPolicy?.mode ?? 'flat';
}

/** The first bound channel, the one the canvas draws (§6). */
export function primaryChannel(team: Pick<TeamDetail, 'channels'>) {
  return team.channels[0] ?? null;
}
