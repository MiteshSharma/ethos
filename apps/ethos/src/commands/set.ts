import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import { readRawConfig, writeConfig } from '@ethosagent/config';
import { teamsDir } from '@ethosagent/team-supervisor';
import { EthosError } from '@ethosagent/types';
import { getSecretsResolver, getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
};

function resolveTeamExists(name: string): void {
  // Check local ./team.yaml
  try {
    const src = readFileSync('./team.yaml', 'utf-8');
    if (src.match(new RegExp(`^name:\\s*${name}\\s*$`, 'm'))) return;
  } catch {
    // not found
  }
  // Check ~/.ethos/teams/<name>.yaml
  try {
    readFileSync(join(teamsDir(), `${name}.yaml`), 'utf-8');
    return;
  } catch {
    // not found
  }
  throw new EthosError({
    code: 'FILE_NOT_FOUND',
    cause: `No team manifest found for "${name}"`,
    action: `Create ~/.ethos/teams/${name}.yaml or place a team.yaml in the current directory matching that name.`,
  });
}

async function requireConfig(): Promise<EthosConfig> {
  const cfg = await readRawConfig(getStorage());
  if (!cfg) {
    console.error('No config found. Run ethos setup first.');
    process.exit(1);
  }
  return cfg;
}

function printCurrent(config: EthosConfig): void {
  const ctx = config.activeContext;
  if (!ctx) {
    console.log(
      `\n${c.bold}Active context${c.reset}  ${c.dim}personality${c.reset}  ${c.cyan}${config.personality}${c.reset}`,
    );
    console.log(`${c.dim}(default — no explicit context set)${c.reset}\n`);
    return;
  }
  const label = ctx.type === 'team' ? 'team' : 'personality';
  console.log(
    `\n${c.bold}Active context${c.reset}  ${c.dim}${label}${c.reset}  ${c.cyan}${ctx.name}${c.reset}\n`,
  );
}

export async function runSet(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();

  // ethos set → show current
  if (!sub) {
    const config = await requireConfig();
    printCurrent(config);
    return;
  }

  if (sub !== 'personality' && sub !== 'team') {
    console.log('Usage: ethos set [personality <name> | team <name>]');
    return;
  }

  const name = args[1];
  if (!name) {
    console.log(`Usage: ethos set ${sub} <name>`);
    return;
  }

  const config = await requireConfig();

  if (sub === 'team') {
    resolveTeamExists(name);
    await writeConfig(
      getStorage(),
      { ...config, activeContext: { type: 'team', name } },
      await getSecretsResolver(),
    );
    console.log(
      `${c.green}✓${c.reset} Active context set to ${c.bold}team:${name}${c.reset}\n` +
        `${c.dim}Start the team first: ethos team start ${name}${c.reset}`,
    );
  } else {
    await writeConfig(
      getStorage(),
      { ...config, activeContext: { type: 'personality', name } },
      await getSecretsResolver(),
    );
    console.log(
      `${c.green}✓${c.reset} Active context set to ${c.bold}personality:${name}${c.reset}`,
    );
  }
}
