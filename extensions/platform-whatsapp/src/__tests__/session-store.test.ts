import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveSessionDir } from '../session-store';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wa-session-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

describe('resolveSessionDir', () => {
  it('creates the credential directory owner-only (0700)', () => {
    const dir = resolveSessionDir({ sessionDir: join(root, 'whatsapp'), botKey: 'bot-1' });
    expect(dir).toBe(join(root, 'whatsapp', 'bot-1'));
    expect(modeOf(dir)).toBe(0o700);
  });

  it('tightens an existing world-readable directory on open', () => {
    const sessionDir = join(root, 'whatsapp');
    const dir = join(sessionDir, 'bot-1');
    mkdirSync(dir, { recursive: true });
    chmodSync(dir, 0o755);

    expect(resolveSessionDir({ sessionDir, botKey: 'bot-1' })).toBe(dir);
    expect(modeOf(dir)).toBe(0o700);
  });

  it('sanitizes the botKey into a single path segment', () => {
    const sessionDir = join(root, 'whatsapp');
    const dir = resolveSessionDir({ sessionDir, botKey: '../escape/me' });
    expect(dir).toBe(join(sessionDir, '___escape_me'));
    expect(modeOf(dir)).toBe(0o700);
  });
});
