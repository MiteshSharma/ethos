// Tests the slash-command surface (/allow, /deny, /communications) by
// driving runPairingCommand against a fresh on-disk pairing.db. We
// stub `ethosDir()` via $HOME / ETHOS_HOME so the command opens the
// throwaway DB rather than the user's real one.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from '@ethosagent/sqlite';
import { generateCode, initPairingDb } from '@ethosagent/wiring/security-kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'ethos-pairing-cmds-'));
  process.env.HOME = tmp;
  delete process.env.ETHOS_HOME;
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function importPairing() {
  // Import inside the test so each call picks up the per-test HOME.
  return await import('../pairing-commands');
}

describe('runPairingCommand', () => {
  it('reports a missing pairing DB cleanly', async () => {
    const { runPairingCommand } = await importPairing();
    const r = await runPairingCommand('list', {});
    expect(r).toMatch(/no pairing DB/);
  });

  it('approves a sender via /allow <code>', async () => {
    // Pre-create the DB with a pending code.
    await mkdtemp(join(tmp, '.ethos-marker-')); // ensure parent exists
    const ethosDirPath = join(tmp, '.ethos');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(ethosDirPath, { recursive: true });
    const db = new Database(join(ethosDirPath, 'pairing.db'));
    initPairingDb(db);
    const code = generateCode(db, 'alice', 'telegram');
    if (!code) throw new Error('failed to generate pairing code in test setup');
    db.close();

    const { runPairingCommand } = await importPairing();
    const r = await runPairingCommand('allow', { code });
    expect(r).toMatch(/approved sender alice on telegram/);
  });

  it('rejects an unknown code', async () => {
    const ethosDirPath = join(tmp, '.ethos');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(ethosDirPath, { recursive: true });
    const db = new Database(join(ethosDirPath, 'pairing.db'));
    initPairingDb(db);
    db.close();

    const { runPairingCommand } = await importPairing();
    const r = await runPairingCommand('allow', { code: 'NOT-A-REAL-CODE' });
    expect(r).toMatch(/allow failed/);
  });

  it('revokes a sender via /deny', async () => {
    const ethosDirPath = join(tmp, '.ethos');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(ethosDirPath, { recursive: true });
    const db = new Database(join(ethosDirPath, 'pairing.db'));
    initPairingDb(db);
    const code = generateCode(db, 'bob', 'discord');
    if (!code) throw new Error('failed to generate pairing code in test setup');
    const { consumeAndAllow } = await import('@ethosagent/wiring/security-kernel');
    const r1 = consumeAndAllow(db, code);
    expect(r1.ok).toBe(true);
    db.close();

    const { runPairingCommand } = await importPairing();
    const r = await runPairingCommand('deny', { platform: 'discord', senderId: 'bob' });
    expect(r).toMatch(/revoked bob on discord/);
  });

  it('rejects an unknown platform on /deny', async () => {
    const ethosDirPath = join(tmp, '.ethos');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(ethosDirPath, { recursive: true });
    const db = new Database(join(ethosDirPath, 'pairing.db'));
    initPairingDb(db);
    db.close();

    const { runPairingCommand } = await importPairing();
    const r = await runPairingCommand('deny', { platform: 'irc', senderId: 'x' });
    expect(r).toMatch(/unknown platform/);
  });

  it('lists approved senders + pending count', async () => {
    const ethosDirPath = join(tmp, '.ethos');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(ethosDirPath, { recursive: true });
    const db = new Database(join(ethosDirPath, 'pairing.db'));
    initPairingDb(db);
    const c1 = generateCode(db, 'alice', 'telegram');
    const c2 = generateCode(db, 'bob', 'slack');
    if (!c1 || !c2) throw new Error('failed to generate pairing codes in test setup');
    const { consumeAndAllow } = await import('@ethosagent/wiring/security-kernel');
    consumeAndAllow(db, c1);
    consumeAndAllow(db, c2);
    generateCode(db, 'charlie', 'telegram'); // pending
    db.close();

    const { runPairingCommand } = await importPairing();
    const r = await runPairingCommand('list', {});
    expect(r).toMatch(/telegram: 1 approved/);
    expect(r).toMatch(/slack: 1 approved/);
    expect(r).toMatch(/pending pairing codes: 1/);
  });
});
