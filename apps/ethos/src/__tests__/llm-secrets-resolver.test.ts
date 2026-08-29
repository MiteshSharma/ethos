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

// No importOriginal() here — that would load the real @ethosagent/wiring
// package (the heaviest transitive graph in the repo: every LLM provider,
// every tool extension, plugin loading) just to override one export, making
// this test's module load slow and flaky under CPU contention. `../wiring`
// (the module under test) only touches EthosObservability/FunnelTracker/
// createAgentLoop lazily inside functions this test never calls, so bare
// stubs are enough.
vi.mock('@ethosagent/wiring', () => ({
  EthosObservability: class {},
  FunnelTracker: class {},
  createAgentLoop: vi.fn(),
  createLLM: packageCreateLLM,
}));

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
  // `../wiring` is the real, unmocked module under test — its own top-level
  // imports (agent-mesh, observability-sqlite, team-supervisor, …) still do
  // real transform work on first load, so under heavy sibling CPU contention
  // this can occasionally outrun the default 15s budget even with the light
  // @ethosagent/wiring stub above.
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
  }, 30_000);
});
