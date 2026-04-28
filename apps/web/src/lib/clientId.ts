// Stable per-tab client identity for the multi-window protocol described
// in CEO finding 4.1 (plan/phases/26-web-ui.md). Two tabs talking to the
// same session each carry their own `clientId`, so the server's
// `approval.resolved` SSE event names which tab decided — the other tab's
// modal auto-dismisses with "approved by another window."
//
// Persistence model:
//   • localStorage — survives page refresh and tab restore.
//   • Per-origin (the browser scopes localStorage by origin) — different
//     ports / hosts get separate ids, which matches how the auth cookie
//     is scoped.
//
// We do NOT regenerate on every mount: a refresh keeps the same id so
// SSE reconnects look like the same client to the server.

const STORAGE_KEY = 'ethos.clientId';

export function getClientId(): string {
  // SSR safety — never call this in a Node context, but type-check the path.
  if (typeof window === 'undefined') return 'ssr';

  const existing = window.localStorage.getItem(STORAGE_KEY);
  if (existing) return existing;

  const fresh = generateClientId();
  window.localStorage.setItem(STORAGE_KEY, fresh);
  return fresh;
}

function generateClientId(): string {
  // Web Crypto's randomUUID is now ubiquitous in modern browsers; the
  // dev `setupTests` mock or a fallback can step in if a test runs this.
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback: 16 hex chars, sufficient entropy for tab identity.
  return Math.random().toString(16).slice(2, 18).padEnd(16, '0');
}
