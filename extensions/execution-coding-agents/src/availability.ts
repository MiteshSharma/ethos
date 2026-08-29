// Raw `node:fs` carve-out (Law 7) — see apps/ethos/src/__tests__/no-raw-fs.test.ts
// and the allowed-exception list in CLAUDE.md. `spawn`-based existence probes
// here answer "is this machine set up to run this agent at all", the same
// deployment-readiness question `execution-pi/src/availability.ts`'s
// `piBinaryAvailable` answers for Pi — not a `~/.ethos/` operation.
import { spawn } from 'node:child_process';

/**
 * Whether `command` resolves and answers `args` (default `--version`) with a
 * clean exit. Generalized off `execution-pi/src/availability.ts`'s
 * `piBinaryAvailable` — D-ACP2 means this package serves more than one agent,
 * so the probe takes the command instead of hardcoding one.
 *
 * The run itself happens inside the container (or, for a real ACP-native CLI
 * invoked via `npx`, wherever the operator's `command`/`args` config points —
 * T4/I3's concern, not this one) — this is only a deployment-readiness
 * signal.
 */
export function agentBinaryAvailable(
  command: string,
  args: readonly string[] = ['--version'],
): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const child = spawn(command, [...args], { stdio: 'ignore' });
      child.on('close', (code) => resolve(code === 0));
      child.on('error', () => resolve(false));
    } catch {
      resolve(false);
    }
  });
}

/**
 * The provenance-checked agent I1 proves against: Zed's own
 * `@agentclientprotocol/claude-agent-acp` wraps Anthropic's official Claude
 * Code SDK, which in turn shells out to the `claude` CLI. Checking `claude
 * --version` is the readiness signal this phase actually verified live on
 * this machine (2.1.239) — matching Pi's own `pi --version` probe shape.
 *
 * No credential-presence check here (contrast Pi's `piCredentialsPresent`,
 * which checks `~/.pi/agent/auth.json`): the Claude Code CLI manages its own
 * session/auth state, and this phase's Open Question 2 ("auth mounting")
 * for a containerized run is explicitly unresolved — deferred to I3/T4, not
 * invented here.
 */
export function claudeCliAvailable(): Promise<boolean> {
  return agentBinaryAvailable('claude', ['--version']);
}
