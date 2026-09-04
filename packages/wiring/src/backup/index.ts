// Archive format for `ethos backup` — streaming ustar + the manifest that
// makes an archive verifiable — and the engine built on it: what belongs in a
// backup (scopes), how a live database is copied consistently (snapshot), and
// the create / restore pair the CLI, the scheduled task and the web RPC all
// call.

export { type BackupResult, type CreateBackupOptions, createBackup } from './create';
export {
  type BackupManifest,
  MANIFEST_PATH,
  MANIFEST_VERSION,
  parseManifest,
  verifyArchive,
  writeManifest,
} from './manifest';
export {
  type RestoreInUseCheck,
  type RestoreOptions,
  type RestoreReport,
  type RestoreWarning,
  type RestoreWarningKind,
  restoreBackup,
} from './restore';
export {
  ALL_SCOPES,
  type BackupEntry,
  classifyPath,
  DATABASE_SCOPES,
  DEFAULT_SCOPES,
  type EnumerationResult,
  enumerateBackupEntries,
  isDatabasePath,
  MCP_TOKEN_FILENAMES,
  type PathClassification,
  parseScopes,
  type ScopeName,
  WAL_STORES,
  type WalStoreRecord,
} from './scopes';
export {
  buildSecretsManifest,
  type InjectSecretsResult,
  injectSecrets,
  type PreparedSecrets,
  type PrepareSecretsResult,
  prepareSecretEntries,
  prepareSecrets,
  SECRETS_MANIFEST_PATH,
  type SecretEntryInput,
  type SecretsManifestInit,
} from './secrets-manifest';
export { type SnapshotMode, snapshotSqlite } from './snapshot';
export {
  assertSafeEntryPath,
  createTarGzWriter,
  parseTarBuffer,
  readTarGz,
  readTarStream,
  type TarEntryHeader,
  type TarEntryVisitor,
  type TarFileRecord,
  TarWriter,
} from './tar';
