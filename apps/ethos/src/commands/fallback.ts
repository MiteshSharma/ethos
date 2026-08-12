import { createInterface, type Interface } from 'node:readline';
import {
  type EthosConfig,
  type ProviderConfig,
  readRawConfig,
  secretRefFromValue,
  writeConfig,
} from '@ethosagent/config';
import type { SecretsResolver } from '@ethosagent/types';
import { getSecretsResolver, getStorage } from '../wiring';

// `ethos fallback` — interactive editor for the `providers:` chain in
// ~/.ethos/config.yaml. The mechanism (ChainedProvider with cooldown-based
// automatic failover) already exists in @ethosagent/wiring; this command
// is the operator-facing surface for it.
//
// Subcommands:
//   ethos fallback list             — show current chain (numbered, masked api keys)
//   ethos fallback add              — interactive prompts; appends one entry
//   ethos fallback remove <index>   — remove the entry at <index> (1-based)
//   ethos fallback clear            — wipe the entire chain
//
// The primary `provider:` / `apiKey:` / `model:` at top level are the
// first attempt; `providers:` are tried in array order when the primary
// errors. Apikeys are stored as `${secrets:providers/<idx>/<provider>/apiKey}`
// refs through the SecretsResolver — never plaintext in config.yaml.

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

const USAGE = 'Usage: ethos fallback [list | add | remove <index> | clear]';

export async function runFallback(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const storage = getStorage();
  const config = await readRawConfig(storage);

  if (!config) {
    console.error(
      `${c.red}No ethos config found.${c.reset} Run ${c.bold}ethos setup${c.reset} first.`,
    );
    process.exit(1);
  }

  switch (sub) {
    case 'list':
      printList(config);
      return;
    case 'add':
      await addEntry(config);
      return;
    case 'remove': {
      const idx = Number(args[1]);
      if (!Number.isInteger(idx) || idx < 1) {
        console.error(`${c.red}remove requires a 1-based index.${c.reset} ${USAGE}`);
        process.exit(1);
      }
      await removeEntry(config, idx - 1);
      return;
    }
    case 'clear':
      await clearChain(config);
      return;
    case '--help':
    case '-h':
      console.log(USAGE);
      return;
    default:
      console.error(`${c.red}Unknown subcommand: ${sub}${c.reset}\n${USAGE}`);
      process.exit(1);
  }
}

function printList(config: EthosConfig): void {
  console.log(
    `${c.bold}Primary${c.reset} ${c.dim}(from top-level provider/apiKey/model)${c.reset}`,
  );
  console.log(
    `  ${c.cyan}${config.provider}${c.reset} · ${config.model} · ${maskRef(config.apiKey)}`,
  );
  console.log('');

  const chain = config.providers ?? [];
  if (chain.length === 0) {
    console.log(`${c.dim}No fallback providers configured.${c.reset}`);
    console.log(`${c.dim}Add one with:${c.reset} ${c.bold}ethos fallback add${c.reset}`);
    return;
  }

  console.log(
    `${c.bold}Fallback chain${c.reset} ${c.dim}(tried in order on primary error)${c.reset}`,
  );
  for (const [i, p] of chain.entries()) {
    const tag = i === 0 ? c.green : c.dim;
    console.log(
      `  ${tag}${i + 1}.${c.reset} ${c.cyan}${p.provider}${c.reset}` +
        ` · ${p.model ?? '(inherits primary model)'}` +
        ` · ${maskRef(p.apiKey)}` +
        (p.baseUrl ? ` · ${c.dim}${p.baseUrl}${c.reset}` : ''),
    );
  }
}

async function addEntry(config: EthosConfig): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(`${c.bold}Add fallback provider${c.reset} ${c.dim}(Ctrl-C to abort)${c.reset}\n`);

    const provider = (await ask(rl, 'Provider (anthropic / openai-compat / azure): ')).trim();
    if (!provider) {
      console.error(`${c.red}Provider is required.${c.reset}`);
      return;
    }

    const apiKey = (await ask(rl, 'API key: ')).trim();
    if (!apiKey) {
      console.error(`${c.red}API key is required.${c.reset}`);
      return;
    }

    const model = (await ask(rl, 'Model (blank to inherit primary): ')).trim();
    const baseUrl = (await ask(rl, 'Base URL (blank for provider default): ')).trim();
    const apiVersion =
      provider === 'azure'
        ? (await ask(rl, 'Azure API version (e.g. 2024-12-01-preview): ')).trim()
        : '';

    const chain = [...(config.providers ?? [])];
    const idx = chain.length;

    // Store the API key through the resolver; config gets the ref.
    const secrets = await getSecretsResolver();
    const ref = `providers/${idx}/${provider}/apiKey`;
    await secrets.set(ref, apiKey);

    const entry: ProviderConfig = {
      provider,
      apiKey: `\${secrets:${ref}}`,
      ...(model ? { model } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      ...(apiVersion ? { apiVersion } : {}),
    };
    chain.push(entry);

    const next: EthosConfig = { ...config, providers: chain };
    await writeConfig(getStorage(), next, secrets);

    console.log(`\n${c.green}✓ Added fallback ${idx + 1}: ${provider}${c.reset}`);
    console.log(
      `${c.dim}Restart 'ethos gateway' (or any running daemon) to pick up the change.${c.reset}`,
    );
  } finally {
    rl.close();
  }
}

async function removeEntry(config: EthosConfig, idx: number): Promise<void> {
  const chain = [...(config.providers ?? [])];
  if (idx < 0 || idx >= chain.length) {
    console.error(`${c.red}Index out of range. The chain has ${chain.length} entries.${c.reset}`);
    process.exit(1);
  }

  const removed = chain[idx];
  if (!removed) {
    console.error(`${c.red}Internal: missing entry at index ${idx}.${c.reset}`);
    process.exit(1);
  }

  chain.splice(idx, 1);

  // Config first, vault second. The reverse order leaves config referencing
  // material that is already gone whenever the write fails; this way the worst
  // case is vault litter.
  const secrets = await getSecretsResolver();
  const next: EthosConfig = { ...config, providers: chain.length > 0 ? chain : undefined };
  await writeConfig(getStorage(), next, secrets);

  console.log(`${c.green}✓ Removed fallback ${idx + 1} (${removed.provider})${c.reset}`);

  // Cleanup of the underlying secret. The ref index doesn't shift even though
  // the array did — we intentionally don't renumber: the original ref strings
  // in the surviving entries would mis-resolve otherwise. That also means a
  // later `add` can mint the ref a survivor already holds, so drop it only
  // when no survivor still points at it.
  const ref = secretRefFromValue(removed.apiKey);
  if (ref && !chain.some((e) => secretRefFromValue(e.apiKey) === ref)) {
    await deleteSecretMaterial(secrets, ref);
  }
}

async function clearChain(config: EthosConfig): Promise<void> {
  const chain = config.providers ?? [];
  if (chain.length === 0) {
    console.log(`${c.dim}Chain is already empty.${c.reset}`);
    return;
  }

  // Config first, vault second — same order as `remove`.
  const secrets = await getSecretsResolver();
  const next: EthosConfig = { ...config, providers: undefined };
  await writeConfig(getStorage(), next, secrets);

  console.log(
    `${c.green}✓ Cleared ${chain.length} fallback provider${chain.length === 1 ? '' : 's'}${c.reset}`,
  );

  // Delete all underlying secrets we wrote. Deduped: two entries can hold the
  // same ref, and no entry survives the clear to keep any of them alive.
  const refs = new Set<string>();
  for (const entry of chain) {
    const ref = secretRefFromValue(entry.apiKey);
    if (ref) refs.add(ref);
  }
  for (const ref of refs) {
    await deleteSecretMaterial(secrets, ref);
  }
}

/**
 * Drop one vault entry whose config reference is already gone.
 *
 * Non-fatal — config.yaml is the source of truth and is already written, so the
 * removal stands. Surfaced rather than swallowed (ARCHITECTURE.md §V S7)
 * because what is left behind is credential material, and the operator gets the
 * exact command to clean it up.
 */
async function deleteSecretMaterial(secrets: SecretsResolver, ref: string): Promise<void> {
  try {
    await secrets.delete(ref);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(
      `${c.red}⚠ Stored key material was not deleted:${c.reset} ${msg}\n` +
        `${c.dim}  Remove it with: ethos secrets remove ${ref}${c.reset}`,
    );
  }
}

function ask(rl: Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function maskRef(value: string | undefined): string {
  if (!value) return `${c.dim}(unset)${c.reset}`;
  if (value.startsWith('${secrets:')) {
    return `${c.dim}${value}${c.reset}`;
  }
  // Raw value — show only the last 4 chars.
  if (value.length <= 8) return `${c.yellow}****${c.reset} (plaintext)`;
  return `${c.yellow}****${value.slice(-4)}${c.reset}${c.dim} (plaintext — migrate to secrets resolver)${c.reset}`;
}
