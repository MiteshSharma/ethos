import type { SecretRef, SecretsResolver } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { type KeyCategoryView, type KeyEntryView, KeysService } from '../keys.service';
import { expandEntry, KEY_CATALOG, parseCodexTokens, refsForEntry } from '../keys-catalog';
import { NamedSecretsService } from '../named-secrets.service';

class FakeSecrets implements SecretsResolver {
  readonly store = new Map<SecretRef, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [ref, value] of Object.entries(seed)) this.store.set(ref, value);
  }

  async get(ref: SecretRef): Promise<string | null> {
    return this.store.get(ref) ?? null;
  }
  async set(ref: SecretRef, value: string): Promise<void> {
    this.store.set(ref, value);
  }
  async delete(ref: SecretRef): Promise<void> {
    this.store.delete(ref);
  }
  async list(prefix?: string): Promise<SecretRef[]> {
    const all = [...this.store.keys()];
    return prefix ? all.filter((r) => r.startsWith(prefix)) : all;
  }
}

function makeService(seed: Record<string, string> = {}): {
  service: KeysService;
  secrets: FakeSecrets;
} {
  const secrets = new FakeSecrets(seed);
  const namedSecrets = new NamedSecretsService({ secrets });
  return { service: new KeysService({ secrets, namedSecrets }), secrets };
}

function category(categories: KeyCategoryView[], id: string): KeyEntryView[] {
  return categories.find((c) => c.id === id)?.entries ?? [];
}

function entry(categories: KeyCategoryView[], id: string): KeyEntryView {
  for (const c of categories) {
    const found = c.entries.find((e) => e.id === id);
    if (found) return found;
  }
  throw new Error(`no entry ${id}`);
}

describe('KEY_CATALOG', () => {
  it('has unique ids and claims each ref exactly once', () => {
    const ids = KEY_CATALOG.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    const refs = KEY_CATALOG.flatMap(refsForEntry);
    expect(new Set(refs).size).toBe(refs.length);
  });

  it('holds no LLM-provider or memory entries — those belong to other panes', () => {
    const categories = new Set(KEY_CATALOG.map((e) => e.category));
    expect([...categories].sort()).toEqual([
      'connections',
      'gateway',
      'settings',
      'tools',
      'voice',
    ]);
  });

  it('keeps the one xAI key as a single tools row serving Grok and x_search', () => {
    const xai = KEY_CATALOG.filter((e) => e.refPattern === 'providers/xai/apiKey');
    // One entry, not one per consumer — two rows would be two write paths.
    expect(xai).toHaveLength(1);
    expect(xai[0]?.id).toBe('tools.xai');
    expect(xai[0]?.category).toBe('tools');
    expect(xai[0]?.label).toBe('xAI (Grok + X search)');
    // Not a NamedSecretsService provider (that vault is exa/tavily/brave only),
    // so the row stays directly editable here.
    expect(xai[0]?.reflectsNamedSecret).toBeUndefined();
  });

  it('gives every indexed entry a <n> placeholder, and no other entry one', () => {
    for (const entry of KEY_CATALOG) {
      const hasPlaceholder = refsForEntry(entry).some((ref) => ref.includes('<n>'));
      expect(hasPlaceholder, `${entry.id}`).toBe(entry.indexed === true);
    }
  });
});

describe('KeysService.list', () => {
  const seed = {
    'providers/exa/apiKey': 'exa-0123456789',
    'providers/reddit/client_id': 'reddit-client-id-value',
    'providers/reddit/client_secret': 'reddit-client-secret-value',
    'auxiliary/compression/apiKey': 'sk-aux-0123456789',
    'some/unknown/ref': 'mystery-value-0123',
  };

  it('places each seeded ref in its catalog category', async () => {
    const { service } = makeService(seed);
    const { categories } = await service.list();

    expect(entry(categories, 'tools.exa').category).toBe('tools');
    expect(entry(categories, 'tools.reddit').category).toBe('tools');
    expect(entry(categories, 'settings.auxiliary.compression').category).toBe('settings');
    expect(entry(categories, 'settings.auxiliary.compression').set).toBe(true);
  });

  it('lands the unmatched ref in custom, and nowhere else', async () => {
    const { service } = makeService(seed);
    const { categories } = await service.list();

    const custom = category(categories, 'custom');
    expect(custom.map((e) => e.label)).toEqual(['some/unknown/ref']);
    expect(custom[0]?.fields[0]?.ref).toBe('some/unknown/ref');
    expect(custom[0]?.fields[0]?.preview).toBe('…0123');

    // The partition invariant: every vault ref appears under exactly one entry.
    const seen = categories.flatMap((c) => c.entries).flatMap((e) => e.fields.map((f) => f.ref));
    expect(new Set(seen).size).toBe(seen.length);
    for (const ref of Object.keys(seed)) expect(seen).toContain(ref);
  });

  it('omits the custom category entirely when the vault holds nothing extra', async () => {
    const { service } = makeService({ 'providers/xai/apiKey': 'xai-0123456789' });
    const { categories } = await service.list();
    // Every category with at least one non-indexed entry is present even when
    // unset — an unset credential is a row saying so. Only `custom` is elided.
    expect(categories.map((c) => c.id)).toEqual([
      'tools',
      'voice',
      'gateway',
      'settings',
      'connections',
    ]);
  });

  it('shows unset catalog entries as rows rather than dropping them', async () => {
    const { service } = makeService({});
    const { categories } = await service.list();
    const xai = entry(categories, 'tools.xai');
    expect(xai.set).toBe(false);
    expect(xai.fields[0]?.preview).toBe('<unset>');
  });

  it('marks reflected named secrets read-only and previews them via NamedSecrets', async () => {
    const { service } = makeService(seed);
    const { categories } = await service.list();
    const exa = entry(categories, 'tools.exa');
    expect(exa.canSet).toBe(false);
    expect(exa.canClear).toBe(false);
    expect(exa.probe).toBe('exa');
    expect(exa.fields[0]?.preview).toBe('exa…6789');
  });

  it('reports a multi-field entry as set only when every field is present', async () => {
    const { service } = makeService({ 'providers/reddit/client_id': 'only-the-id-here' });
    const { categories } = await service.list();
    const reddit = entry(categories, 'tools.reddit');
    expect(reddit.shape).toBe('multi');
    expect(reddit.set).toBe(false);
    expect(reddit.fields.map((f) => f.set)).toEqual([true, false]);
  });
});

describe('KeysService.set', () => {
  it('writes a single-shape entry to its ref', async () => {
    const { service, secrets } = makeService({});
    await service.set({ id: 'settings.memoryCapture', values: { apiKey: 'sk-mc-0123456789' } });
    expect(secrets.store.get('memoryCapture/apiKey')).toBe('sk-mc-0123456789');
  });

  it('writes every field of a multi-shape entry', async () => {
    const { service, secrets } = makeService({});
    await service.set({
      id: 'tools.reddit',
      values: { clientId: 'id-value', clientSecret: 'secret-value' },
    });
    expect(secrets.store.get('providers/reddit/client_id')).toBe('id-value');
    expect(secrets.store.get('providers/reddit/client_secret')).toBe('secret-value');
  });

  it('rejects a partial multi-field write without touching the vault', async () => {
    const { service, secrets } = makeService({});
    await expect(
      service.set({ id: 'tools.reddit', values: { clientId: 'id-value' } }),
    ).rejects.toThrow(/Missing value/);
    expect(secrets.store.size).toBe(0);
  });

  it('rejects an unknown field key', async () => {
    const { service } = makeService({});
    await expect(
      service.set({ id: 'settings.memoryCapture', values: { nope: 'x' } }),
    ).rejects.toThrow(/Unknown field/);
  });

  it('rejects a write to a reflected named-secret entry', async () => {
    const { service, secrets } = makeService({ 'providers/exa/apiKey': 'exa-0123456789' });
    await expect(
      service.set({ id: 'tools.exa', values: { apiKey: 'new-key-value' } }),
    ).rejects.toThrow(/named-secrets vault/);
    expect(secrets.store.get('providers/exa/apiKey')).toBe('exa-0123456789');
  });

  it('replaces an existing custom ref but refuses to mint a new one', async () => {
    const { service, secrets } = makeService({ 'some/unknown/ref': 'old-value-here' });
    await service.set({ id: 'custom:some/unknown/ref', values: { value: 'new-value-here' } });
    expect(secrets.store.get('some/unknown/ref')).toBe('new-value-here');

    await expect(
      service.set({ id: 'custom:never/seen/before', values: { value: 'x' } }),
    ).rejects.toThrow(/Unknown key entry/);
    expect(secrets.store.has('never/seen/before')).toBe(false);
  });

  it('rejects a value over the 8 KiB cap', async () => {
    const { service, secrets } = makeService({});
    await expect(
      service.set({ id: 'settings.memoryCapture', values: { apiKey: 'x'.repeat(8 * 1024 + 1) } }),
    ).rejects.toThrow(/too large/);
    expect(secrets.store.size).toBe(0);
  });
});

describe('KeysService.clear', () => {
  it('deletes the single ref of a single-shape entry', async () => {
    const { service, secrets } = makeService({ 'memoryCapture/apiKey': 'sk-mc-0123456789' });
    await service.clear({ id: 'settings.memoryCapture' });
    expect(secrets.store.has('memoryCapture/apiKey')).toBe(false);
  });

  it('deletes every ref of a multi-shape entry', async () => {
    const { service, secrets } = makeService({
      'providers/reddit/client_id': 'id-value',
      'providers/reddit/client_secret': 'secret-value',
    });
    await service.clear({ id: 'tools.reddit' });
    expect(secrets.store.size).toBe(0);
  });

  it('deletes a custom ref', async () => {
    const { service, secrets } = makeService({ 'some/unknown/ref': 'mystery-value' });
    await service.clear({ id: 'custom:some/unknown/ref' });
    expect(secrets.store.size).toBe(0);
  });

  it('refuses to clear a reflected named-secret entry', async () => {
    const { service, secrets } = makeService({ 'providers/exa/apiKey': 'exa-0123456789' });
    await expect(service.clear({ id: 'tools.exa' })).rejects.toThrow(/named-secrets vault/);
    expect(secrets.store.get('providers/exa/apiKey')).toBe('exa-0123456789');
  });

  it('is idempotent on an already-empty catalog entry', async () => {
    const { service } = makeService({});
    await expect(service.clear({ id: 'settings.memoryCapture' })).resolves.toEqual({ ok: true });
  });
});

// ---------------------------------------------------------------------------
// Indexed expansion (Phase 4)
//
// The whole point: the roster segment is read from the vault, never counted up
// to. Config writes `telegram.bots.<i>.token`, but `secretRefForConfigKey`
// rewrites `<i>` to the bot's stable `deriveBotKey` when one exists and to the
// array index only as a fallback — so the segment is opaque, and the indices
// present are routinely NON-CONTIGUOUS (delete the middle bot of three and
// `0` and `2` remain). Anything that assumed a dense array would either invent
// a phantom bot 1 or stop at the first gap and hide bot 2's live token.
// ---------------------------------------------------------------------------
describe('indexed catalog entries', () => {
  const telegram = KEY_CATALOG.find((e) => e.id === 'gateway.telegram.bot');

  it('expands non-contiguous indices, surfacing both and inventing no gap', async () => {
    const { service } = makeService({
      'telegram/bots/0/token': 'bot-zero-token-value',
      'telegram/bots/2/token': 'bot-two-token-value',
    });
    const { categories } = await service.list();

    const bots = category(categories, 'gateway').filter((e) =>
      e.id.startsWith('gateway.telegram.bot.'),
    );
    expect(bots.map((e) => e.id)).toEqual(['gateway.telegram.bot.0', 'gateway.telegram.bot.2']);
    expect(bots.map((e) => e.fields[0]?.ref)).toEqual([
      'telegram/bots/0/token',
      'telegram/bots/2/token',
    ]);
    // No row for the index that is not there.
    expect(bots.some((e) => e.id === 'gateway.telegram.bot.1')).toBe(false);
    // And neither real ref fell through to `custom`.
    expect(category(categories, 'custom')).toEqual([]);
  });

  it('expands an opaque botKey segment the same way it expands a number', async () => {
    const { service } = makeService({
      'telegram/bots/a1b2c3d4/token': 'keyed-bot-token-value',
      'telegram/bots/a1b2c3d4/webhookSecretToken': 'keyed-bot-webhook-value',
    });
    const { categories } = await service.list();
    const bot = entry(categories, 'gateway.telegram.bot.a1b2c3d4');
    expect(bot.shape).toBe('multi');
    expect(bot.set).toBe(true);
    expect(bot.fields.map((f) => f.ref)).toEqual([
      'telegram/bots/a1b2c3d4/token',
      'telegram/bots/a1b2c3d4/webhookSecretToken',
    ]);
  });

  it('yields no rows at all when the roster is empty', () => {
    expect(telegram).toBeDefined();
    if (!telegram) return;
    expect(expandEntry(telegram, [])).toEqual([]);
  });

  it('captures exactly one segment, so a deeper ref is not read as an index', () => {
    expect(telegram).toBeDefined();
    if (!telegram) return;
    expect(expandEntry(telegram, ['telegram/bots/0/nested/token'])).toEqual([]);
  });

  it('keeps the single-bot ref out of the per-bot rows', async () => {
    const { service } = makeService({
      'telegram/token': 'single-bot-token-value',
      'telegram/bots/0/token': 'roster-bot-token-value',
    });
    const { categories } = await service.list();
    expect(entry(categories, 'gateway.telegram').fields[0]?.ref).toBe('telegram/token');
    expect(entry(categories, 'gateway.telegram.bot.0').fields[0]?.ref).toBe(
      'telegram/bots/0/token',
    );
  });

  it('writes and clears through an expanded id', async () => {
    const { service, secrets } = makeService({ 'webhooks/deploy/secret': 'old-hook-secret' });
    await service.set({ id: 'gateway.webhook.deploy', values: { secret: 'new-hook-secret' } });
    expect(secrets.store.get('webhooks/deploy/secret')).toBe('new-hook-secret');
    await service.clear({ id: 'gateway.webhook.deploy' });
    expect(secrets.store.has('webhooks/deploy/secret')).toBe(false);
  });

  it('rejects an index the vault does not hold', async () => {
    const { service } = makeService({});
    await expect(
      service.set({ id: 'gateway.webhook.ghost', values: { secret: 'x' } }),
    ).rejects.toThrow(/Unknown key entry/);
  });

  it('expands the voice rosters by provider name', async () => {
    const { service } = makeService({
      'voice/tts/providers/elevenlabs/apiKey': 'tts-key-0123456789',
      'voice/stt/providers/deepgram/apiKey': 'stt-key-0123456789',
    });
    const { categories } = await service.list();
    expect(entry(categories, 'voice.tts.elevenlabs').fields[0]?.ref).toBe(
      'voice/tts/providers/elevenlabs/apiKey',
    );
    expect(entry(categories, 'voice.stt.deepgram').fields[0]?.ref).toBe(
      'voice/stt/providers/deepgram/apiKey',
    );
    expect(category(categories, 'custom')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Connections — the codex blob (Phase 5)
//
// `providers/codex/tokens` holds `JSON.stringify(CodexCredentials)`, and three
// of that document's six fields are bearer credentials. The assertions below
// are made on the SERIALIZED view, not on `parse`'s return value, so a field
// added to `CodexCredentials` later cannot leak through some layer between the
// two without failing here.
// ---------------------------------------------------------------------------
describe('connections.codex', () => {
  const CREDENTIALS = {
    accessToken: 'eyJhbGciOiJIUzI1NiJ9.access-token-secret',
    refreshToken: 'refresh-token-secret-value',
    idToken: 'eyJhbGciOiJIUzI1NiJ9.id-token-secret',
    accountId: 'acct_9f3c21',
    expiresAt: '2030-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  async function codexView() {
    const { service } = makeService({ 'providers/codex/tokens': JSON.stringify(CREDENTIALS) });
    const { categories } = await service.list();
    return entry(categories, 'connections.codex');
  }

  it('surfaces only accountId and expiresAt', async () => {
    const view = await codexView();
    expect(view.shape).toBe('blob');
    expect(view.set).toBe(true);
    expect(view.details).toEqual({
      accountId: 'acct_9f3c21',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
    expect(view.fields).toEqual([]);
  });

  it('never serializes a bearer token anywhere in the view', async () => {
    const serialized = JSON.stringify(await codexView());
    for (const leak of [
      CREDENTIALS.accessToken,
      CREDENTIALS.refreshToken,
      CREDENTIALS.idToken,
      'accessToken',
      'refreshToken',
      'idToken',
      'updatedAt',
    ]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it('leaks nothing from the whole categories payload either', async () => {
    const { service } = makeService({ 'providers/codex/tokens': JSON.stringify(CREDENTIALS) });
    const serialized = JSON.stringify(await service.list());
    expect(serialized).not.toContain(CREDENTIALS.accessToken);
    expect(serialized).not.toContain(CREDENTIALS.refreshToken);
    expect(serialized).not.toContain(CREDENTIALS.idToken);
    expect(serialized).toContain('acct_9f3c21');
  });

  it('drops any field the allowlist does not name, including a new one', () => {
    const parsed = parseCodexTokens(
      JSON.stringify({ ...CREDENTIALS, futureSecret: 'not-in-the-allowlist' }),
    );
    expect(parsed).toEqual({
      accountId: 'acct_9f3c21',
      expiresAt: '2030-01-01T00:00:00.000Z',
    });
  });

  it('returns null for a document it cannot read, and shows no details', async () => {
    expect(parseCodexTokens('not json at all')).toBeNull();
    expect(parseCodexTokens('null')).toBeNull();
    expect(parseCodexTokens('{"accessToken":"only-the-secret"}')).toBeNull();

    const { service } = makeService({ 'providers/codex/tokens': 'not json at all' });
    const { categories } = await service.list();
    const view = entry(categories, 'connections.codex');
    expect(view.set).toBe(true);
    expect(view.details).toBeUndefined();
  });

  it('is not settable, but is clearable — that is the Disconnect action', async () => {
    const { service, secrets } = makeService({
      'providers/codex/tokens': JSON.stringify(CREDENTIALS),
    });
    const { categories } = await service.list();
    const view = entry(categories, 'connections.codex');
    expect(view.canSet).toBe(false);
    expect(view.canClear).toBe(true);

    await expect(
      service.set({ id: 'connections.codex', values: { accessToken: 'x' } }),
    ).rejects.toThrow(/not editable as a value/);

    await service.clear({ id: 'connections.codex' });
    expect(secrets.store.has('providers/codex/tokens')).toBe(false);
  });
});
