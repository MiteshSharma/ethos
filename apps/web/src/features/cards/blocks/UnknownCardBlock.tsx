import type { CardBlockProps } from '../registry';

// The terminal fallback: an envelope this build cannot render — an unknown
// `kind`, or a known kind at a spec version this client does not implement.
// It names what is missing and keeps the payload reachable behind a
// disclosure, because a card that silently disappears is indistinguishable
// from a bug in the tool that emitted it.

export function UnknownCardBlock({ card }: CardBlockProps) {
  return (
    <div className="card-block card-unknown">
      <div className="card-unknown-label">
        Card not rendered — kind <code>{card.kind}</code>, spec v{card.specVersion}. This client is
        older than the agent that sent it.
      </div>
      <details className="card-unknown-details">
        <summary>Payload</summary>
        <pre className="card-unknown-payload">{safeStringify(card.payload)}</pre>
      </details>
    </div>
  );
}

function safeStringify(payload: unknown): string {
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload);
  } catch {
    // Cycles cannot reach here through the wire (JSON in, JSON out), but the
    // fallback must never be the thing that throws.
    return String(payload);
  }
}
