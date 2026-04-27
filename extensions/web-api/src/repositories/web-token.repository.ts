import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// File-backed store for the single web-UI auth token. The token lives at
// `<dataDir>/web-token` chmod 600 — same posture as `~/.ssh/id_*`.
//
// Two scenarios this needs to handle:
//   1. First run — no file exists. Generate a 32-byte hex token, write it,
//      print the URL with `?t=<token>`. Subsequent boots reuse the same token.
//   2. URL exchange — the user opens `?t=<token>`. We compare against the
//      stored value with `timingSafeEqual`, then ROTATE (write a new token,
//      invalidating the URL one). The cookie auth issued in the same step
//      becomes the steady-state credential.
//
// Repositories are thin: no business logic, just FS access.

const TOKEN_BYTES = 32;

export interface WebTokenRepositoryOptions {
  /** Where `~/.ethos` lives. The token file is `<dataDir>/web-token`. */
  dataDir: string;
}

export class WebTokenRepository {
  private readonly path: string;

  constructor(opts: WebTokenRepositoryOptions) {
    this.path = join(opts.dataDir, 'web-token');
  }

  /**
   * Read the current token, generating one on first call if the file is
   * missing. Always returns a usable token string. The file is chmod 600
   * after every write so a follow-up `ls -l` shows the right perms.
   */
  async getOrCreate(): Promise<string> {
    const existing = await this.readSafe();
    if (existing) return existing;
    const token = generateToken();
    await this.writeAtomic(token);
    return token;
  }

  /**
   * Constant-time compare against the stored token. Returns false on
   * length mismatch or missing file (rather than throwing) so callers can
   * treat invalid attempts uniformly.
   */
  async matches(candidate: string): Promise<boolean> {
    const stored = await this.readSafe();
    if (!stored) return false;
    const a = Buffer.from(stored, 'utf-8');
    const b = Buffer.from(candidate, 'utf-8');
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /** Generate + persist a fresh token, returning the new value. Used after
   *  successful URL exchange to invalidate the URL token. */
  async rotate(): Promise<string> {
    const token = generateToken();
    await this.writeAtomic(token);
    return token;
  }

  private async readSafe(): Promise<string | null> {
    try {
      const raw = (await readFile(this.path, 'utf-8')).trim();
      return raw || null;
    } catch {
      return null;
    }
  }

  /**
   * Atomic write: writes to `<path>.tmp` first, fsyncs implicitly via close,
   * then renames over the destination. Avoids leaving a half-written token
   * on disk if the process crashes mid-write.
   */
  private async writeAtomic(token: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, `${token}\n`, { encoding: 'utf-8', mode: 0o600 });
    await rename(tmp, this.path);
    await chmod(this.path, 0o600);
  }
}

function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}
