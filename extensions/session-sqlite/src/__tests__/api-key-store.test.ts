import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AmbiguousPrefixError, hashApiKey, SqliteApiKeyStore } from '../api-key-store';

describe('SqliteApiKeyStore', () => {
  let store: SqliteApiKeyStore;

  beforeEach(() => {
    store = new SqliteApiKeyStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('create', () => {
    it('returns a secret + record with the expected shape', async () => {
      const { secret, record } = await store.create({ name: 'cursor', scopes: ['chat'] });
      expect(secret).toMatch(/^sk-ethos-[0-9a-f]+$/);
      expect(record.prefix).toBe(secret.slice(0, 'sk-ethos-'.length + 8));
      expect(record.name).toBe('cursor');
      expect(record.scopes).toEqual(['chat']);
      expect(record.createdAt).toBeInstanceOf(Date);
      expect(record.lastUsed).toBeNull();
      expect(record.revokedAt).toBeNull();
    });

    it('generates distinct secrets across calls', async () => {
      const a = await store.create({ name: 'a', scopes: ['chat'] });
      const b = await store.create({ name: 'b', scopes: ['chat'] });
      expect(a.secret).not.toBe(b.secret);
      expect(a.record.id).not.toBe(b.record.id);
    });

    it('persists multi-scope keys', async () => {
      await store.create({ name: 'admin', scopes: ['chat', 'admin'] });
      const all = await store.list();
      expect(all[0]?.scopes).toEqual(['chat', 'admin']);
    });
  });

  describe('findByHash', () => {
    it('returns the record for a valid key', async () => {
      const { secret, record } = await store.create({ name: 'k', scopes: ['chat'] });
      const found = await store.findByHash(hashApiKey(secret));
      expect(found?.id).toBe(record.id);
      expect(found?.name).toBe('k');
    });

    it('returns null for an unknown hash', async () => {
      const found = await store.findByHash(hashApiKey('sk-ethos-does-not-exist'));
      expect(found).toBeNull();
    });

    it('returns null for a revoked key', async () => {
      const { secret, record } = await store.create({ name: 'k', scopes: ['chat'] });
      await store.revoke(record.prefix);
      const found = await store.findByHash(hashApiKey(secret));
      expect(found).toBeNull();
    });
  });

  describe('touchLastUsed', () => {
    it('updates last_used and is visible via list', async () => {
      const { record } = await store.create({ name: 'k', scopes: ['chat'] });
      expect((await store.list())[0]?.lastUsed).toBeNull();
      await store.touchLastUsed(record.id);
      const after = await store.list();
      expect(after[0]?.lastUsed).toBeInstanceOf(Date);
    });
  });

  describe('revoke', () => {
    it('marks revoked_at on the matching key', async () => {
      const { record } = await store.create({ name: 'k', scopes: ['chat'] });
      const revoked = await store.revoke(record.prefix);
      expect(revoked?.revokedAt).toBeInstanceOf(Date);
      const listed = await store.list();
      expect(listed[0]?.revokedAt).toBeInstanceOf(Date);
    });

    it('matches by prefix substring (LIKE)', async () => {
      const { record } = await store.create({ name: 'k', scopes: ['chat'] });
      // Take a strictly shorter prefix than the stored value; LIKE-match must
      // still resolve to the single key.
      const shortPrefix = record.prefix.slice(0, 'sk-ethos-'.length + 4);
      const revoked = await store.revoke(shortPrefix);
      expect(revoked?.id).toBe(record.id);
    });

    it('returns null when no key matches', async () => {
      const revoked = await store.revoke('sk-ethos-deadbeef');
      expect(revoked).toBeNull();
    });

    it('throws AmbiguousPrefixError when multiple keys match the same prefix', async () => {
      // The literal `sk-ethos-` prefix matches every key created in this store,
      // so two creations trip the ambiguity guard.
      await store.create({ name: 'a', scopes: ['chat'] });
      await store.create({ name: 'b', scopes: ['chat'] });
      await expect(store.revoke('sk-ethos-')).rejects.toBeInstanceOf(AmbiguousPrefixError);
    });

    it('does not re-revoke an already-revoked key', async () => {
      const { record } = await store.create({ name: 'k', scopes: ['chat'] });
      await store.revoke(record.prefix);
      const second = await store.revoke(record.prefix);
      expect(second).toBeNull();
    });
  });

  describe('list', () => {
    it('returns every key including revoked ones', async () => {
      const { record: first } = await store.create({ name: 'first', scopes: ['chat'] });
      const { record: second } = await store.create({ name: 'second', scopes: ['chat'] });
      await store.revoke(first.prefix);
      const all = await store.list();
      const ids = all.map((r) => r.id).sort();
      expect(ids).toEqual([first.id, second.id].sort());
      const revoked = all.find((r) => r.id === first.id);
      expect(revoked?.revokedAt).toBeInstanceOf(Date);
    });
  });
});

// ---------------------------------------------------------------------------
// Durability posture — see AGENTS.md's SQLite store roster.
// ---------------------------------------------------------------------------

/** Reads `PRAGMA synchronous` off the store's OWN handle — it is a
 *  per-connection setting, so a second connection to the same file would
 *  report its own default and prove nothing. 2 = FULL (SQLite's default),
 *  1 = NORMAL. */
function syncPragma(store: unknown): number {
  const rows = (store as { db: { pragma(s: string): unknown } }).db.pragma('synchronous');
  return (rows as Array<{ synchronous: number }>)[0]?.synchronous ?? -1;
}

describe('SqliteApiKeyStore — durability posture', () => {
  it('stays at synchronous = FULL', () => {
    // NOT a candidate for `synchronous = NORMAL` — pinned so a later blanket
    // sweep cannot take it silently.
    //
    // A created key is handed to the user once and never shown again. If the
    // insert rolls back after a power cut, the user holds a secret that
    // authenticates nothing and cannot be recovered. Key creation and
    // revocation are rare, so FULL costs nothing that matters.
    const store = new SqliteApiKeyStore(':memory:');
    // Asserted against the opened database, not the source text.
    expect(syncPragma(store)).toBe(2);
    store.close();
  });
});
