import type { CliSubcommandContext } from '@ethosagent/types';

export interface CliSubcommandEntry {
  name: string;
  description: string;
  handler?: (ctx: CliSubcommandContext) => Promise<number>;
  pluginId?: string;
}

export const builtInCliNames = new Set([
  'setup',
  'chat',
  'sessions',
  'personality',
  'plugins',
  'memory',
  'gateway',
  'listen',
  'cron',
  'acp',
  'serve',
  'run-all',
  'batch',
  'eval',
  'evolve',
  'plugin',
  'skills',
  'commands',
  'keys',
  'secrets',
  'api-key',
  'claw',
  'doctor',
  'status',
  'dashboard',
  'fallback',
  'slack',
  'upgrade',
  'set',
  'team',
  'mesh',
  'process',
  'logs',
  'mcp',
  'backup',
  'import',
  'trace',
  'audit',
  'security',
  'errors',
  'perf',
  'tail',
  'retention',
  'data',
  'support',
  'archive',
  'systemd-unit',
  'usage',
  'nightly',
  'digest',
  'request-dump',
]);

export class CliSubcommandRegistry {
  private readonly commands = new Map<string, CliSubcommandEntry>();

  register(cmd: CliSubcommandEntry): void {
    if (builtInCliNames.has(cmd.name)) return;
    this.commands.set(cmd.name, cmd);
  }

  unregister(name: string): void {
    this.commands.delete(name);
  }

  get(name: string): CliSubcommandEntry | undefined {
    return this.commands.get(name);
  }

  getAll(): CliSubcommandEntry[] {
    return [...this.commands.values()];
  }
}
