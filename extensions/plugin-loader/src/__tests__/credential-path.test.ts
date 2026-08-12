// ---------------------------------------------------------------------------
// PL-004 — the credential API must not become a filesystem API
// ---------------------------------------------------------------------------
//
// `plugins.getCredential`, `plugins.getCredentialMeta` and the loader's
// `clearCredential` take `pluginId` and a credential name straight off the
// wire (`z.string().min(1)` — nothing upstream narrows either). They become a
// vault ref (`plugins/<pluginId>/<name>`) and a metadata path
// (`<dataDir>/plugins/<pluginId>/credentials/<name>.meta`). `join()` normalises
// `..`, so an unchecked name turns a read into an arbitrary read, a delete into
// an arbitrary delete, and a meta lookup into an arbitrary stat — and an
// unchecked ref segment lands one plugin's read inside another's prefix.
//
// Every assertion below inspects WHAT REACHED THE SINK — the storage AND the
// vault — not whether a call threw. A weaker shape was tried and discarded:
// asserting only that the call rejects passes against the vulnerable
// implementation too, because a traversal to a path that happens not to exist
// also "fails". So each test seeds a real file at the traversal target and
// asserts (a) neither sink was ever handed a path or ref outside this plugin's
// own credentials, and (b) the planted content never came back.
// ---------------------------------------------------------------------------

import { join } from 'node:path';
import {
  DefaultHookRegistry,
  DefaultLLMProviderRegistry,
  DefaultMemoryProviderRegistry,
  DefaultPersonalityRegistry,
  DefaultToolRegistry,
} from '@ethosagent/core';
import type { PluginRegistries } from '@ethosagent/plugin-sdk';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import type { ContextInjector, SecretRef, StorageRemoveOptions } from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { CredentialPathError, PluginLoader } from '../index';

const DATA_DIR = '/data';
const PLUGIN_ID = 'tools-zerodha';
const CRED_DIR = join(DATA_DIR, 'plugins', PLUGIN_ID, 'credentials');
/** The vault prefix this plugin's refs must never leave. */
const REF_PREFIX = `plugins/${PLUGIN_ID}/`;

/** The file a traversal is trying to reach. Outside the credential dir. */
const SECRET_PATH = join(DATA_DIR, 'config.yaml');
const SECRET_CONTENT = 'anthropic_api_key: sk-ant-real-key\n';

function makeRegistries(): PluginRegistries {
  const injectors: ContextInjector[] = [];
  return {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors,
    injectorPluginIds: new Map<ContextInjector, string>(),
    personalities: new DefaultPersonalityRegistry(),
    llmProviders: new DefaultLLMProviderRegistry(),
    memoryProviders: new DefaultMemoryProviderRegistry(),
  };
}

/**
 * Records every path handed to the storage. `existsSync` is what makes this a
 * `CredentialStorage`; the recording is what makes the tests falsifiable.
 */
class RecordingStorage extends InMemoryStorage {
  readonly touched: string[] = [];

  override async read(path: string): Promise<string | null> {
    this.touched.push(path);
    return super.read(path);
  }

  override async exists(path: string): Promise<boolean> {
    this.touched.push(path);
    return super.exists(path);
  }

  override async list(dir: string): Promise<string[]> {
    this.touched.push(dir);
    return super.list(dir);
  }

  override async remove(path: string, opts?: StorageRemoveOptions): Promise<void> {
    this.touched.push(path);
    return super.remove(path, opts);
  }

  /** Paths touched that are not inside this plugin's credential directory. */
  outsideCredentialDir(): string[] {
    return this.touched.filter((p) => p !== CRED_DIR && !p.startsWith(`${CRED_DIR}/`));
  }
}

/** Records every ref handed to the vault — the other sink a bad name reaches. */
class RecordingSecrets extends InMemorySecretsResolver {
  readonly touched: string[] = [];

  override async get(ref: SecretRef): Promise<string | null> {
    this.touched.push(ref);
    return super.get(ref);
  }

  override async set(ref: SecretRef, value: string): Promise<void> {
    this.touched.push(ref);
    return super.set(ref, value);
  }

  override async delete(ref: SecretRef): Promise<void> {
    this.touched.push(ref);
    return super.delete(ref);
  }

  override async list(prefix?: string): Promise<SecretRef[]> {
    this.touched.push(prefix ?? '<all>');
    return super.list(prefix);
  }

  /** Refs touched that are not inside this plugin's own vault prefix. */
  outsideOwnPrefix(): string[] {
    return this.touched.filter((r) => !r.startsWith(REF_PREFIX));
  }
}

let storage: RecordingStorage;
let secrets: RecordingSecrets;
let loader: PluginLoader;

beforeEach(async () => {
  storage = new RecordingStorage();
  secrets = new RecordingSecrets();
  await storage.mkdir(CRED_DIR);
  // Seeded at the LEGACY path, not in the vault — the first credential call
  // migrates it, so this also covers the pre-vault install.
  await storage.write(join(CRED_DIR, 'api_key'), 'plugin-secret-value');
  await storage.write(join(CRED_DIR, 'api_key.meta'), '{"updatedAt":"2026-08-12T10:00:00.000Z"}');
  await storage.write(SECRET_PATH, SECRET_CONTENT);
  storage.touched.length = 0;

  loader = new PluginLoader(makeRegistries(), { storage, secrets, dataDir: DATA_DIR });
});

// The payloads. Each is a distinct escape route, not a variation on one.
const HOSTILE_NAMES = [
  '../../../../.ethos/config.yaml',
  '../config.yaml',
  '..',
  '.',
  'nested/key',
  '/etc/passwd',
  '..\\..\\config.yaml',
  'key\0.png',
];

const HOSTILE_PLUGIN_IDS = ['../..', '../../..', 'a/../../b', '/etc', '.', './x'];

describe('getCredentialValue — arbitrary read', () => {
  it('reads a legitimate credential, and only from inside the credential dir', async () => {
    const value = await loader.getCredentialValue(PLUGIN_ID, 'api_key');
    expect(value).toBe('plugin-secret-value');
    expect(storage.outsideCredentialDir()).toEqual([]);
    expect(secrets.outsideOwnPrefix()).toEqual([]);
  });

  it.each(HOSTILE_NAMES)('refuses ref %j without ever reading it', async (ref) => {
    await expect(loader.getCredentialValue(PLUGIN_ID, ref)).rejects.toThrow(CredentialPathError);
    // The planted file exists and is readable — a refusal that only happened
    // because the target was missing would pass a weaker assertion than this.
    expect(await storage.read(SECRET_PATH)).toBe(SECRET_CONTENT);
    storage.touched.length = 0;
    expect(storage.outsideCredentialDir()).toEqual([]);
    expect(secrets.touched).toEqual([]);
  });

  it.each(HOSTILE_PLUGIN_IDS)('refuses pluginId %j without ever reading it', async (pluginId) => {
    await expect(loader.getCredentialValue(pluginId, 'api_key')).rejects.toThrow(
      CredentialPathError,
    );
    expect(storage.touched).toEqual([]);
    expect(secrets.touched).toEqual([]);
  });

  it('the preview oracle inherits the refusal', async () => {
    await expect(loader.getCredentialPreview(PLUGIN_ID, '../config.yaml')).rejects.toThrow(
      CredentialPathError,
    );
    expect(storage.touched).toEqual([]);
    expect(secrets.touched).toEqual([]);
  });
});

describe('clearCredential — arbitrary delete', () => {
  it('deletes a legitimate credential and its meta, and nothing else', async () => {
    await loader.clearCredential(PLUGIN_ID, 'api_key');
    expect(await secrets.get(`${REF_PREFIX}api_key`)).toBeNull();
    expect(await storage.exists(join(CRED_DIR, 'api_key'))).toBe(false);
    expect(await storage.exists(join(CRED_DIR, 'api_key.meta'))).toBe(false);
    expect(storage.outsideCredentialDir()).toEqual([]);
    expect(secrets.outsideOwnPrefix()).toEqual([]);
  });

  it.each(HOSTILE_NAMES)('refuses key %j and leaves the target file intact', async (key) => {
    await expect(loader.clearCredential(PLUGIN_ID, key)).rejects.toThrow(CredentialPathError);
    expect(storage.touched).toEqual([]);
    expect(secrets.touched).toEqual([]);
    // `remove` swallows its own errors, so "it did not throw" proves nothing
    // about deletion — check the file is still there.
    expect(await storage.read(SECRET_PATH)).toBe(SECRET_CONTENT);
  });

  it.each(HOSTILE_PLUGIN_IDS)('refuses pluginId %j and deletes nothing', async (pluginId) => {
    await expect(loader.clearCredential(pluginId, 'api_key')).rejects.toThrow(CredentialPathError);
    expect(storage.touched).toEqual([]);
    expect(secrets.touched).toEqual([]);
    expect(await storage.exists(join(CRED_DIR, 'api_key'))).toBe(true);
  });
});

describe('getCredentialMeta — arbitrary stat', () => {
  it('reads legitimate metadata, and only from inside the credential dir', async () => {
    const meta = await loader.getCredentialMeta(PLUGIN_ID, 'api_key');
    expect(meta).toEqual({ updatedAt: '2026-08-12T10:00:00.000Z' });
    expect(storage.outsideCredentialDir()).toEqual([]);
  });

  it.each(HOSTILE_NAMES)('refuses key %j without ever statting it', async (key) => {
    await expect(loader.getCredentialMeta(PLUGIN_ID, key)).rejects.toThrow(CredentialPathError);
    expect(storage.touched).toEqual([]);
  });

  it.each(HOSTILE_PLUGIN_IDS)('refuses pluginId %j without ever statting it', async (pluginId) => {
    await expect(loader.getCredentialMeta(pluginId, 'api_key')).rejects.toThrow(
      CredentialPathError,
    );
    expect(storage.touched).toEqual([]);
  });
});

describe('the refusal is loud, not a silent miss', () => {
  it('a traversal ref is distinguishable from an unset credential', async () => {
    // An unset-but-valid credential returns null. A traversal throws. If the
    // guard returned null instead, an operator reading the logs could not tell
    // an attack from a typo.
    expect(await loader.getCredentialValue(PLUGIN_ID, 'never_set')).toBeNull();
    await expect(loader.getCredentialValue(PLUGIN_ID, '../config.yaml')).rejects.toThrow(
      /Invalid credential name/,
    );
  });
});

describe('setCredential — arbitrary write', () => {
  it('refuses a traversal key before reaching the plugin api', async () => {
    // Refused on the key, not on "plugin is not loaded" — the check must come
    // first, or an attacker only needs a loaded plugin to get the write.
    await expect(loader.setCredential(PLUGIN_ID, '../../config.yaml', 'x')).rejects.toThrow(
      CredentialPathError,
    );
    expect(await storage.read(SECRET_PATH)).toBe(SECRET_CONTENT);
  });
});

describe('listCredentialKeys', () => {
  it('lists this plugin keys for a valid plugin id', async () => {
    const keys = await loader.listCredentialKeys(PLUGIN_ID);
    expect(keys.map((k) => k.key)).toEqual(['api_key']);
    expect(storage.outsideCredentialDir()).toEqual([]);
    expect(secrets.outsideOwnPrefix()).toEqual([]);
  });

  it.each(HOSTILE_PLUGIN_IDS)('refuses pluginId %j without listing it', async (pluginId) => {
    await expect(loader.listCredentialKeys(pluginId)).rejects.toThrow(CredentialPathError);
    expect(storage.touched).toEqual([]);
    expect(secrets.touched).toEqual([]);
  });
});
