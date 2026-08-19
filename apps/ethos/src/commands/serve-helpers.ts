import type { EthosConfig } from '@ethosagent/config';

// Pure helpers for `runServe`. Extracted so we can unit-test arg parsing
// without booting an HTTP server, and so the boot path stays focused on
// orchestration.

/** Default `--web-port` when no flag, env var, or config key is set. */
export const WEB_PORT_DEFAULT = 3000;

/**
 * Find the value of a `--name=value` or `--name value` flag. Returns the
 * first match across the alias list. `undefined` when none of the names
 * appear; `''` when the flag is set without a value.
 */
export function parseFlagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    for (const name of names) {
      if (arg === name) return args[i + 1] ?? '';
      if (arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
    }
  }
  return undefined;
}

/** True when any of the alias names appears as a bare flag or `--name=...`. */
export function hasFlag(args: string[], names: string[]): boolean {
  for (const arg of args) {
    if (names.includes(arg)) return true;
    for (const name of names) {
      if (arg.startsWith(`${name}=`)) return true;
    }
  }
  return false;
}

/** Coerce a flag string to a positive integer, falling back when missing/invalid. */
export function parsePort(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** Precedence: CLI flag > env var > config.yaml > default (`127.0.0.1`). */
export function resolveWebHost(
  args: string[],
  env: NodeJS.ProcessEnv,
  config: EthosConfig | null,
): string {
  return (
    parseFlagValue(args, ['--web-host']) ?? env.ETHOS_WEB_HOST ?? config?.web?.host ?? '127.0.0.1'
  );
}

/** Precedence: CLI flag > env var > config.yaml > `WEB_PORT_DEFAULT`. */
export function resolveWebPort(
  args: string[],
  env: NodeJS.ProcessEnv,
  config: EthosConfig | null,
): number {
  const fallback = parsePort(env.ETHOS_WEB_PORT, config?.web?.port ?? WEB_PORT_DEFAULT);
  return parsePort(parseFlagValue(args, ['--web-port']), fallback);
}

/**
 * Precedence: env var > config.yaml > default (unset — no CORS). No CLI flag,
 * matching Hermes (`API_SERVER_CORS_ORIGINS` is env-only).
 */
export function resolveCorsOrigins(
  env: NodeJS.ProcessEnv,
  config: EthosConfig | null,
): string | undefined {
  return env.ETHOS_API_CORS_ORIGINS ?? config?.web?.corsOrigins;
}
