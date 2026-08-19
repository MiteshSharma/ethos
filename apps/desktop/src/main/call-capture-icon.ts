// Shared brand-icon loader for the call-capture offer card and pill windows
// (`call-capture-notification-gate.ts`/`call-capture-pill.ts`). Both windows
// load their content via a `data:text/html` URL (no `file://` origin), so a
// plain `<img src="apps/desktop/assets/brand/icon-1024.png">` won't resolve —
// this reads the PNG once and inlines it as a base64 data URI instead, the
// same asset (`apps/desktop/assets/brand/icon-1024.png`) the native
// `capture-offer-card.swift`/`capture-indicator.swift` binaries already draw
// (see their "BRAND ICON"/"BADGE ICON" header comments) so both surfaces
// stay visually consistent.
//
// Unlike those two Swift files — which duplicate this same lookup on purpose
// because each is a self-contained, no-shared-module `swiftc` binary — this
// is one shared TS module used by both Electron windows, which already share
// an import graph, so duplicating it here would just be needless copy-paste.
//
// Resolution mirrors `tray.ts`'s `getIconDir()`: `app.getAppPath()` in dev,
// `process.resourcesPath` once packaged. Never throws — a missing/unreadable
// asset (or `electron`'s `app` being unavailable, as in this file's own
// tests) resolves to `null` and callers fall back to a plain brand-colored
// shape, exactly like the Swift originals' own "missing icon" fallback.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { app } from 'electron';

let cachedIconDataUri: string | null | undefined;

function iconAssetPath(): string {
  const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
  return path.join(base, 'assets', 'brand', 'icon-1024.png');
}

/** Returns a `data:image/png;base64,...` URI for the Ethos brand icon, or
 * `null` if it can't be resolved/read. Cached after the first (successful or
 * failed) resolution — the asset never changes at runtime. */
export function resolveCallCaptureIconDataUri(): string | null {
  if (cachedIconDataUri !== undefined) return cachedIconDataUri;
  try {
    const iconPath = iconAssetPath();
    cachedIconDataUri = existsSync(iconPath)
      ? `data:image/png;base64,${readFileSync(iconPath).toString('base64')}`
      : null;
  } catch {
    cachedIconDataUri = null;
  }
  return cachedIconDataUri;
}
