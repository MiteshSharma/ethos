import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import {
  AmbiguousPrefixError,
  type ApiKeyRecord,
  SqliteApiKeyStore,
} from '@ethosagent/session-sqlite';
import { type ApiKeyScope, ApiKeyScopeSchema } from '@ethosagent/web-contracts';

// `ethos api-key` — manage bearer-token credentials for the OpenAI-compat
// `/v1/*` surface. Keys live alongside session state in `sessions.db` so
// `ethos serve` and this command share the same row set.

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
};

// `chat` is the `/v1/*` scope, and the default because that surface is the
// only reason this command exists. Typed against `ApiKeyScope` so the CLI and
// `ApiKeyScopeSchema` cannot drift: keys minted here and keys minted through
// the web UI's `apiKeys.create` RPC must draw from one vocabulary.
const DEFAULT_SCOPES: ApiKeyScope[] = ['chat'];
const USAGE =
  'Usage: ethos api-key [create --name <label> [--scopes <a,b>] [--json] | list [--json] | revoke <prefix>]';

export async function runApiKey(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const jsonMode = args.includes('--json');
  const store = openStore();
  try {
    switch (sub) {
      case 'create':
        await create(store, args.slice(1), jsonMode);
        break;
      case 'list':
        await list(store, jsonMode);
        break;
      case 'revoke':
        await revoke(store, args.slice(1));
        break;
      default:
        console.log(USAGE);
        process.exit(1);
    }
  } finally {
    store.close();
  }
}

function openStore(): SqliteApiKeyStore {
  return new SqliteApiKeyStore(join(ethosDir(), 'sessions.db'));
}

async function create(store: SqliteApiKeyStore, args: string[], jsonMode: boolean): Promise<void> {
  const name = parseFlagValue(args, '--name');
  if (!name) {
    console.log('Missing --name. Usage: ethos api-key create --name <label> [--scopes <a,b>]');
    process.exit(1);
  }
  const scopesArg = parseFlagValue(args, '--scopes');
  const scopes = scopesArg === undefined ? DEFAULT_SCOPES : parseScopes(scopesArg);

  const { secret, record } = await store.create({ name, scopes });

  if (jsonMode) {
    const payload = {
      name: record.name,
      key: secret,
      prefix: record.prefix,
      scopes: record.scopes,
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  console.log();
  console.log(`${c.green}✓ API key created${c.reset}  ${c.dim}name: ${record.name}${c.reset}`);
  console.log();
  console.log(`  ${c.bold}${secret}${c.reset}`);
  console.log();
  console.log(`  ${c.dim}prefix: ${record.prefix}${c.reset}`);
  console.log(`  ${c.dim}scopes: ${record.scopes.join(', ')}${c.reset}`);
  console.log();
  console.log(`  ${c.yellow}This is the only time the full key is shown. Save it now.${c.reset}`);
  console.log();
}

async function list(store: SqliteApiKeyStore, jsonMode: boolean): Promise<void> {
  const all = await store.list();

  if (jsonMode) {
    const payload = all.map((k) => ({
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      createdAt: k.createdAt.toISOString(),
    }));
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }

  if (all.length === 0) {
    console.log(`\n${c.dim}No API keys yet.${c.reset}`);
    console.log(`${c.dim}Create one with: ${c.reset}ethos api-key create --name <label>\n`);
    return;
  }
  console.log();
  console.log(`${c.bold}API keys${c.reset}  ${c.dim}(${all.length})${c.reset}`);
  for (const k of all) {
    console.log(`  ${c.cyan}${k.prefix}${c.reset}  ${k.name}  ${formatKey(k)}`);
  }
  console.log();
}

async function revoke(store: SqliteApiKeyStore, args: string[]): Promise<void> {
  const prefix = args[0];
  if (!prefix) {
    console.log('Usage: ethos api-key revoke <prefix>');
    process.exit(1);
  }
  try {
    const revoked = await store.revoke(prefix);
    if (!revoked) {
      console.log(`${c.red}No active API key matches prefix "${prefix}".${c.reset}`);
      process.exit(1);
    }
    console.log(
      `${c.green}✓ Revoked${c.reset}  ${revoked.prefix}  ${c.dim}${revoked.name}${c.reset}`,
    );
  } catch (err) {
    if (err instanceof AmbiguousPrefixError) {
      console.log(`${c.red}${err.message}${c.reset}`);
      process.exit(1);
    }
    throw err;
  }
}

function formatKey(k: ApiKeyRecord): string {
  const scopes = `${c.dim}scopes:${c.reset} ${k.scopes.join(',')}`;
  const lastUsed = k.lastUsed ? `last used ${k.lastUsed.toISOString()}` : 'never used';
  const status = k.revokedAt ? `${c.red}revoked${c.reset}` : `${c.dim}active${c.reset}`;
  return `${scopes}  ${c.dim}${lastUsed}${c.reset}  ${status}`;
}

/**
 * Validate `--scopes a,b` against `ApiKeyScopeSchema`. Unknown scopes used to
 * be accepted verbatim — `SqliteApiKeyStore.create` stores whatever it is
 * handed — which minted a key that authenticated everywhere and authorized
 * nothing. Fail loudly instead, and name the valid set.
 */
function parseScopes(raw: string): ApiKeyScope[] {
  const requested = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (requested.length === 0) {
    console.log(`${c.red}--scopes was empty. Pass at least one scope.${c.reset}`);
    console.log(`${c.dim}Valid scopes: ${ApiKeyScopeSchema.options.join(', ')}${c.reset}`);
    process.exit(1);
  }
  const scopes: ApiKeyScope[] = [];
  const unknown: string[] = [];
  for (const candidate of requested) {
    const parsed = ApiKeyScopeSchema.safeParse(candidate);
    if (parsed.success) scopes.push(parsed.data);
    else unknown.push(candidate);
  }
  if (unknown.length > 0) {
    const label = unknown.length === 1 ? 'scope' : 'scopes';
    console.log(`${c.red}Unknown ${label}: ${unknown.join(', ')}${c.reset}`);
    console.log(`${c.dim}Valid scopes: ${ApiKeyScopeSchema.options.join(', ')}${c.reset}`);
    process.exit(1);
  }
  return scopes;
}

function parseFlagValue(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1) return undefined;
  return args[idx + 1];
}
