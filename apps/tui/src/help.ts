// /help body for the TUI. Built-in commands first, then any externally
// injected commands (plugins, via TUIOptions.slashCommands) with a [plugin]
// tag. Pure — extracted from App.tsx so the merge is unit-testable.

export interface ExternalSlashCommand {
  name: string;
  description: string;
  usage: string;
}

export function buildHelpText(
  state: { readonlyMode: boolean; verbose: boolean },
  external: ExternalSlashCommand[] = [],
): string {
  const lines = [
    '/new                          fresh session',
    '/personality [list|<id>]      start a new session bound to <id>',
    '/model                        open model picker',
    '/sessions                     open session picker',
    '/memory                       show ~/.ethos/MEMORY.md',
    '/usage                        token + cost stats',
    '/budget                       show session spend vs cap',
    '/budget reset                 reset budget counter',
    `/readonly                     toggle readonly mode (now: ${state.readonlyMode ? 'on' : 'off'})`,
    `/verbose                      toggle timing (now: ${state.verbose ? 'on' : 'off'})`,
    '/details [hidden|collapsed|expanded] [section]',
    '/skin [list|<name>]           switch UI theme',
    '/tools                        list all available tools',
    '/skills                       list available skills',
    '/exit                         quit',
  ];
  for (const cmd of external) {
    lines.push(`/${cmd.name.padEnd(29)}${cmd.description} [plugin]`);
  }
  return lines.join('\n');
}
