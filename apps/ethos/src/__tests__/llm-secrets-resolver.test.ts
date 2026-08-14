import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The CLI's `createLLM` must hand the package a REAL SecretsResolver.
//
// `createAgentLoop` in the same file always did; `createLLM` did not, so every
// provider built outside a loop — `ethos serve`'s auto-title LLM, doctor,
// nightly, evolve, the gateway's approval reviewer — saw the wiring package's
// null-object fallback. Stored credentials with no plaintext config key (codex
// OAuth tokens) then read as absent: "No Codex credentials found."
// ---------------------------------------------------------------------------

type PackageCreateLLM = typeof import('@ethosagent/wiring')['createLLM'];

const packageCreateLLM = vi.fn<PackageCreateLLM>();

vi.mock('@ethosagent/wiring', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@ethosagent/wiring')>();
  return { ...orig, createLLM: packageCreateLLM };
});

const TOKENS_REF = 'providers/codex/tokens';
const TOKENS_VALUE = '{"accessToken":"at-test","refreshToken":"rt-test"}';

let stateDir: string;
let savedStateDir: string | undefined;

beforeAll(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'ethos-secrets-wiring-'));
  mkdirSync(join(stateDir, 'secrets', 'providers', 'codex'), { recursive: true });
  writeFileSync(join(stateDir, 'secrets', TOKENS_REF), `${TOKENS_VALUE}\n`, { mode: 0o600 });
  savedStateDir = process.env.ETHOS_STATE_DIR;
  process.env.ETHOS_STATE_DIR = stateDir;
});

afterAll(() => {
  if (savedStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
  else process.env.ETHOS_STATE_DIR = savedStateDir;
});

describe('CLI createLLM — secrets resolver threading', () => {
  it('passes a resolver that reads the on-disk secret store', async () => {
    packageCreateLLM.mockRejectedValue(new Error('__stubbed-provider-construction__'));
    const { createLLM } = await import('../wiring');

    await expect(
      createLLM({
        provider: 'codex',
        model: 'gpt-5-codex',
        apiKey: '',
        personality: 'operator',
      }),
    ).rejects.toThrow('__stubbed-provider-construction__');

    const passedConfig = packageCreateLLM.mock.calls[0]?.[0];
    const resolver = passedConfig?.secretsResolver;
    expect(resolver).toBeDefined();
    // Not just "some resolver" — one that actually returns the stored value
    // the crash reported as missing.
    expect(await resolver?.get(TOKENS_REF)).toBe(TOKENS_VALUE);
  });
});
