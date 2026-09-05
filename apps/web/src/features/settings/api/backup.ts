// Query keys and the one raw-route href for the Backup pane
// (plan/phases/agent-state-backup.md §5, D6). Same three-file shape as
// `keys.ts` / `keys-queries.ts` / `keys-mutations.ts`.

export const backupKeys = {
  all: () => ['backup'] as const,
  status: () => [...backupKeys.all(), 'status'] as const,
};

/**
 * `GET /backup/download` href — deliberately RELATIVE, for exactly the reason
 * `documentDownloadHref` is (`lib/documents.ts`): the route is authenticated by
 * the httpOnly `SameSite=Strict` `ethos_auth` cookie, and an absolute origin
 * from the Vite dev server is cross-site, so the browser would drop the cookie
 * and the download would 401.
 *
 * `encodeURIComponent` rather than `URLSearchParams`, also for that file's
 * reason: the latter encodes a space as `+`, and an archive filename must
 * survive the round trip byte-for-byte.
 *
 * Whether this href is usable at all is `status.downloadAvailable`'s answer,
 * not this function's — a Bearer-authenticated caller cannot attach a header to
 * an `<a download>` navigation, so the pane renders the CLI path instead of a
 * link that would 401.
 */
export function backupDownloadHref(name: string): string {
  return `/backup/download?name=${encodeURIComponent(name)}`;
}
