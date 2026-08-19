// Network sequencing for the avatar picker, pulled out of both call sites
// (`NewAgentDialog`'s create flow and `Personalities.tsx`'s `IdentityEditor`)
// as plain async functions so the ordering rules are unit-testable without
// rendering either component — mirrors `PersonalityVoiceFields`'s
// `voiceCreateInput`/`voiceUpdateInput` split.

export type AvatarSelection = { kind: 'curated'; url: string } | { kind: 'file'; file: File };

export interface AvatarActionDeps {
  /** `rpc.personalities.update({ id, display: { avatar_url } })`. */
  setAvatarUrl: (id: string, url: string) => Promise<unknown>;
  /** `fetch(\`/api/personalities/${id}/avatar\`, { method: 'POST', ... })`. */
  uploadAvatar: (id: string, file: File) => Promise<Response>;
  /** `fetch(\`/api/personalities/${id}/avatar\`, { method: 'DELETE' })`. */
  deleteAvatar: (id: string) => Promise<Response>;
}

/**
 * Apply an avatar selection on a personality that already exists (the edit
 * surface, `IdentityEditor`). A curated pick first DELETEs any previously
 * stored uploaded file — cleanup, not an error path, so an old upload never
 * lingers on disk once the personality points at a curated icon instead —
 * then writes the curated URL. A file upload POSTs bytes directly; the
 * upload route sets `display.avatar_url` itself.
 */
export async function applyAvatarSelection(
  id: string,
  selection: AvatarSelection,
  deps: AvatarActionDeps,
): Promise<void> {
  if (selection.kind === 'curated') {
    await deps.deleteAvatar(id);
    await deps.setAvatarUrl(id, selection.url);
  } else {
    await upload(id, selection.file, deps);
  }
}

/**
 * Attach an avatar selection right after `personalities.create` resolves
 * (the create surface, `NewAgentDialog`). No prior upload can exist yet, so
 * there is nothing to clean up first.
 */
export async function attachAvatarAfterCreate(
  id: string,
  selection: AvatarSelection,
  deps: Pick<AvatarActionDeps, 'setAvatarUrl' | 'uploadAvatar'>,
): Promise<void> {
  if (selection.kind === 'curated') {
    await deps.setAvatarUrl(id, selection.url);
  } else {
    await upload(id, selection.file, deps);
  }
}

/** Remove a personality's avatar — always the DELETE route, never a bare
 *  `update({ display: { avatar_url: '' } })`, so the stored bytes are
 *  actually cleaned up rather than merely unlinked from the config. */
export async function removeAvatar(
  id: string,
  deps: Pick<AvatarActionDeps, 'deleteAvatar'>,
): Promise<void> {
  const response = await deps.deleteAvatar(id);
  if (!response.ok) throw new Error(`Avatar removal failed (${response.status})`);
}

/**
 * The two raw-`fetch` legs of `AvatarActionDeps`. Deliberately RELATIVE URLs
 * — same reasoning as `documentDownloadHref` in `lib/documents.ts`: the
 * route is authenticated by the `SameSite=Strict` `ethos_auth` cookie, so an
 * absolute cross-port URL from the Vite dev server would be cross-site and
 * silently drop the cookie.
 */
export function uploadAvatarBytes(id: string, file: File): Promise<Response> {
  return fetch(`/api/personalities/${id}/avatar`, {
    method: 'POST',
    headers: { 'content-type': file.type },
    body: file,
  });
}

export function deleteAvatarRoute(id: string): Promise<Response> {
  return fetch(`/api/personalities/${id}/avatar`, { method: 'DELETE' });
}

async function upload(
  id: string,
  file: File,
  deps: Pick<AvatarActionDeps, 'uploadAvatar'>,
): Promise<void> {
  const response = await deps.uploadAvatar(id, file);
  if (!response.ok) throw new Error(`Avatar upload failed (${response.status})`);
}
