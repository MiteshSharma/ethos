// Raw node:fs is an allowed exception here (same as session-sqlite and memory-vector).
// Baileys' useMultiFileAuthState manages its own file layout for auth credentials and pre-keys.
// See CLAUDE.md "Allowed exceptions" — session persistence backends
// that manage their own WAL/file format are exempt from the Storage
// abstraction.
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Owner-only. The directory holds Baileys device credentials and pre-keys,
 * and Baileys writes those files itself — the directory mode is the only
 * lever we have over who can read them. Same lockdown FileSecretsResolver
 * applies to `~/.ethos/secrets` (packages/storage-fs/src/secrets.ts).
 */
const SESSION_DIR_MODE = 0o700;

function sanitizeBotKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '_');
}

export interface SessionStoreConfig {
  sessionDir: string;
  botKey: string;
}

export function resolveSessionDir(config: SessionStoreConfig): string {
  const dir = join(config.sessionDir, sanitizeBotKey(config.botKey));
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: SESSION_DIR_MODE });
  }
  // Idempotent tightening on every open — installs created before the mode
  // was set have a 0o755 directory on disk, and a credential directory that
  // only new installs lock down is not locked down. Same repair-on-write
  // pattern as FileSecretsResolver's chmod in `set`.
  chmodSync(dir, SESSION_DIR_MODE);
  return dir;
}
