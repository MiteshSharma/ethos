import { isValidSecretName, type SecretsResolver, type Storage } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// Plugin credential refs — the single naming scheme
// ---------------------------------------------------------------------------
//
// G-SEC: `SecretsResolver` is the sole storage and retrieval path for
// credential material. Plugin credentials live at `plugins/<pluginId>/<key>`
// in the vault. Every writer — `PluginApiImpl.setSecret`, the loader's
// `setCredential` RPC, and `ethos plugin credentials --set` — mints its ref
// here, so no surface can invent a second name for the same credential.
//
// The `plugins/` prefix is unused by every other minter: `secretRefForConfigKey`
// (packages/config) owns `providers/`, `telegram/`, `discord/`, `slack/`,
// `email/`, `auxiliary/`, `voice/`, `webhooks/`, `memoryCapture/` and
// `rotation/`; `@ethosagent/tools-mcp` owns `mcp/`; `@ethosagent/a2a` owns
// `a2a/`.

/**
 * Reject plugin ids that are not a single safe path segment.
 *
 * NOT `isValidSecretName` — plugin ids legitimately contain dots
 * (`my.plugin`), which `SECRET_NAME_RE` forbids. What matters here is that the
 * id cannot open a new path segment or climb: those are the shapes that let one
 * plugin's ref land under another plugin's prefix, or outside `plugins/`
 * altogether.
 */
function assertPlainPluginId(pluginId: string): void {
  if (
    pluginId === '' ||
    pluginId === '.' ||
    pluginId === '..' ||
    pluginId.includes('/') ||
    pluginId.includes('\\') ||
    pluginId.includes('\0')
  ) {
    throw new Error(`Invalid plugin id "${pluginId}" — must be a single plain path segment`);
  }
}

/** The vault prefix owning one plugin's credentials: `plugins/<pluginId>/`. */
export function pluginCredentialPrefix(pluginId: string): string {
  assertPlainPluginId(pluginId);
  return `plugins/${pluginId}/`;
}

/**
 * The vault ref for one plugin credential: `plugins/<pluginId>/<key>`.
 *
 * Throws on a key that is not a plain name (`SECRET_NAME_RE`). A `..` or `/`
 * in `key` is exactly the traversal that would let a plugin escape its own
 * prefix and read — or overwrite — another plugin's credentials, so refusal is
 * a thrown error, never a fallback ref.
 */
export function pluginCredentialRef(pluginId: string, key: string): string {
  if (!isValidSecretName(key)) {
    throw new Error(`Invalid credential key "${key}" — must be alphanumeric, underscores, hyphens`);
  }
  return `${pluginCredentialPrefix(pluginId)}${key}`;
}

// ---------------------------------------------------------------------------
// Legacy migration
// ---------------------------------------------------------------------------

export interface LegacyCredentialMigrationOptions {
  /** The vault the credentials move into. */
  secrets: SecretsResolver;
  /** Storage owning the legacy directory. */
  storage: Storage;
  /** The plugin whose credentials are being migrated. */
  pluginId: string;
  /** Legacy directory — `<dataDir>/plugins/<pluginId>/credentials`. */
  legacyDir: string;
}

/**
 * Move any pre-vault plugin credentials from `<legacyDir>/<key>` into the
 * vault, then delete the plaintext file.
 *
 * One-time migration rather than a permanent read-through fallback: a fallback
 * leaves a second retrieval path open forever, which is the exact shape G-SEC
 * forbids. Migration closes it on first touch — the loader runs this before it
 * hands a plugin its api, and `ethos plugin credentials` runs it before it
 * lists or writes, so a plugin that worked before this change works after it
 * with no operator action.
 *
 * When both copies exist the vault wins: the legacy file predates the vault
 * write by construction, so it is stale, and the delete is what keeps a
 * credential from existing in two places.
 *
 * A vault write that succeeds but whose legacy delete fails throws. The
 * alternative — swallowing it — leaves a plaintext credential on disk that
 * nothing will ever look at again, and therefore nothing will ever remove.
 *
 * Returns the keys migrated.
 */
export async function migrateLegacyPluginCredentials(
  opts: LegacyCredentialMigrationOptions,
): Promise<string[]> {
  const { secrets, storage, pluginId, legacyDir } = opts;
  const entries = await storage.list(legacyDir);
  const migrated: string[] = [];

  for (const name of entries) {
    // `.meta` sidecars carry an `updatedAt` timestamp and no credential
    // material; they stay on disk.
    if (name.endsWith('.meta')) continue;
    if (!isValidSecretName(name)) continue;

    const ref = pluginCredentialRef(pluginId, name);
    const path = `${legacyDir}/${name}`;

    if ((await secrets.get(ref)) === null) {
      const value = await storage.read(path);
      if (value === null) continue;
      await secrets.set(ref, value);
      migrated.push(name);
    }

    try {
      await storage.remove(path);
    } catch (err) {
      throw new Error(
        `Plugin "${pluginId}": credential "${name}" is in the vault but the legacy plaintext ` +
          `copy at ${path} could not be removed (${String(err)}). Remove it by hand — until ` +
          `then the credential exists in two places.`,
      );
    }
  }

  return migrated;
}
