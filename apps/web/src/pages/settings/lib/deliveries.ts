// Coarse age for a delivery obligation. Module scope and exported because it is
// the one piece of the delivery readout that is testable without a DOM.

/** Coarse age — the question is "how stale", never "exactly when". */
export function deliveryAge(createdAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - createdAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}
