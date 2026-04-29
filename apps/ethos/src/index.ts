// Shebang `#!/usr/bin/env node` is added by tsup via banner config at build time.
// Don't put it here — tsx in dev mode doesn't need it and source-level shebangs
// in TypeScript trip on tsup's bundler.
import { formatError, toEthosError } from '@ethosagent/types';
import { runAcp } from './commands/acp';
import { runBatch } from './commands/batch';
import { runChat } from './commands/chat';
import { runClaw } from './commands/claw';
import { runCronCommand } from './commands/cron';
import { runDoctor } from './commands/doctor';
import { runEval } from './commands/eval';
import { runEvolve } from './commands/evolve';
import { runGatewaySetup, runGatewayStart } from './commands/gateway';
import { runKeys } from './commands/keys';
import { runPlugin } from './commands/plugin';
import { runServe } from './commands/serve';
import { runSetup } from './commands/setup';
import { runSkills } from './commands/skills';
import { runUpgrade } from './commands/upgrade';
import { readConfig } from './config';
import { appendErrorLog } from './error-log';
import { getStorage } from './wiring';

// Compile-time injected by tsup via define (or read from env at runtime in dev).
declare const __ETHOS_VERSION__: string;
const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

const USAGE =
  'Usage: ethos [setup | chat | serve | gateway | cron | personality | memory | acp | batch | eval | evolve | plugin | skills | keys | claw | doctor | upgrade] [--version | --help]';

const args = process.argv.slice(2);
const command = args[0] ?? '';

try {
  switch (command) {
    case '--version':
    case '-v': {
      console.log(`@ethosagent/cli ${ETHOS_VERSION}`);
      break;
    }

    case '--help':
    case '-h': {
      console.log(USAGE);
      break;
    }

    case 'setup': {
      await runSetup();
      break;
    }

    case 'chat':
    case '': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.log('No config found. Running setup first...\n');
        const fresh = await runSetup();
        if (fresh) await runChat(fresh);
      } else {
        await runChat(config);
      }
      break;
    }

    case 'personality': {
      const sub = args[1] ?? '';
      if (sub === 'list' || sub === '') {
        const { createPersonalityRegistry } = await import('@ethosagent/personalities');
        const reg = await createPersonalityRegistry();
        console.log('\nBuilt-in personalities:\n');
        for (const p of reg.list()) {
          const def = reg.getDefault().id === p.id ? ' (default)' : '';
          console.log(`  ${p.id.padEnd(14)} ${p.description ?? ''}${def}`);
        }
        console.log();
      } else if (sub === 'set' && args[2]) {
        const { writeConfig, readConfig: rc } = await import('./config');
        const cfg = await rc(getStorage());
        if (!cfg) {
          console.error('Run ethos setup first.');
          process.exit(1);
        }
        await writeConfig(getStorage(), { ...cfg, personality: args[2] });
        console.log(`Personality set to: ${args[2]}`);
      } else if (sub === 'mcp') {
        await runPersonalityMcp(args.slice(2));
      } else if (sub === 'plugins') {
        await runPersonalityPlugins(args.slice(2));
      } else {
        console.log(
          'Usage: ethos personality [list | set <id> | mcp <id> [--attach <name> | --detach <name>] | plugins <id> [--attach <plugin-id> | --detach <plugin-id>]]',
        );
      }
      break;
    }

    case 'plugins': {
      await runPluginsStatus();
      break;
    }

    case 'memory': {
      const sub = args[1] ?? 'show';
      const config = await readConfig(getStorage());

      if (config?.memory === 'vector') {
        const { VectorMemoryProvider } = await import('@ethosagent/memory-vector');
        const { ethosDir: getDir } = await import('./config');
        const mem = new VectorMemoryProvider({ dir: getDir() });

        if (sub === 'show' || sub === '') {
          const records = mem.showRecent(20);
          if (records.length === 0) {
            console.log('No memory yet.');
          } else {
            for (const r of records) {
              console.log(`[${r.store}] ${r.createdAt.toISOString().slice(0, 16)}`);
              console.log(r.content);
              console.log();
            }
          }
        } else if (sub === 'add') {
          const text = args.slice(2).join(' ');
          if (!text) {
            console.error('Usage: ethos memory add "<text>"');
            process.exit(1);
          }
          const n = await mem.add(text, 'memory');
          console.log(`Added ${n} chunk${n === 1 ? '' : 's'} to vector memory.`);
        } else if (sub === 'export') {
          const { join: pathJoin } = await import('node:path');
          const outPath = args[2] ?? pathJoin(getDir(), `memory-export-${Date.now()}.md`);
          const n = await mem.exportAll(outPath);
          if (n === 0) {
            console.log('Memory is empty — nothing to export.');
          } else {
            console.log(`Exported ${n} chunk${n === 1 ? '' : 's'} to ${outPath}`);
          }
        } else if (sub === 'clear') {
          const readline = await import('node:readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          await new Promise<void>((resolve) => {
            rl.question('Clear all vector memory? This cannot be undone. [y/N] ', (answer) => {
              rl.close();
              if (answer.toLowerCase() === 'y') {
                mem.clear();
                console.log('Vector memory cleared.');
              } else {
                console.log('Cancelled.');
              }
              resolve();
            });
          });
        } else {
          console.log('Usage: ethos memory [show | add "<text>" | export [path] | clear]');
        }
        mem.close();
      } else {
        const { MarkdownFileMemoryProvider } = await import('@ethosagent/memory-markdown');
        const mem = new MarkdownFileMemoryProvider();

        if (sub === 'show' || sub === '') {
          const result = await mem.prefetch({ sessionId: '', sessionKey: 'cli', platform: 'cli' });
          if (result) {
            console.log(result.content);
          } else {
            console.log('No memory yet.');
          }
        } else if (sub === 'add') {
          const text = args.slice(2).join(' ');
          if (!text) {
            console.error('Usage: ethos memory add "<text>"');
            process.exit(1);
          }
          await mem.sync({ sessionId: '', sessionKey: 'cli', platform: 'cli' }, [
            { store: 'memory', action: 'add', content: text },
          ]);
          console.log('Added to memory.');
        } else if (sub === 'clear') {
          await mem.sync({ sessionId: '', sessionKey: 'cli', platform: 'cli' }, [
            { store: 'memory', action: 'replace', content: '' },
          ]);
          console.log('Memory cleared.');
        } else {
          console.log('Usage: ethos memory [show | add "<text>" | clear]');
        }
      }
      break;
    }

    case 'gateway': {
      const sub = args[1] ?? '';
      if (sub === 'setup') {
        await runGatewaySetup();
      } else if (sub === 'start') {
        const config = await readConfig(getStorage());
        if (!config) {
          console.error('Run ethos setup first.');
          process.exit(1);
        }
        await runGatewayStart(config);
      } else {
        console.log('Usage: ethos gateway [setup | start]');
      }
      break;
    }

    case 'cron': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runCronCommand(args[1] ?? 'list', args.slice(2), config);
      break;
    }

    case 'acp': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runAcp(config);
      break;
    }

    case 'serve': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runServe(args.slice(1), config);
      break;
    }

    case 'batch': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runBatch(args.slice(1), config);
      break;
    }

    case 'eval': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runEval(args.slice(1), config);
      break;
    }

    case 'evolve': {
      const config = await readConfig(getStorage());
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runEvolve(args.slice(1), config);
      break;
    }

    case 'plugin': {
      await runPlugin(args.slice(1));
      break;
    }

    case 'skills': {
      await runSkills(args.slice(1));
      break;
    }

    case 'keys': {
      await runKeys(args.slice(1));
      break;
    }

    case 'claw': {
      await runClaw(args.slice(1));
      break;
    }

    case 'doctor': {
      await runDoctor(args.slice(1));
      break;
    }

    case 'upgrade': {
      await runUpgrade();
      break;
    }

    default:
      console.log(`Unknown command: ${command}`);
      console.log(USAGE);
      process.exit(1);
  }
} catch (err) {
  // Phase 30.9 — render every surface-level failure through the EthosError
  // envelope so users see code/cause/action even when a command throws raw.
  const e = toEthosError(err);
  process.stderr.write(`\n${formatError(e, { color: process.stderr.isTTY })}\n`);
  // Phase 30.10 — append to ~/.ethos/logs/errors.jsonl for local diagnostics.
  appendErrorLog(e, { command });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ethos personality mcp <id> [--attach <name> | --detach <name>]
// ---------------------------------------------------------------------------

async function runPersonalityMcp(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    console.log('Usage: ethos personality mcp <id> [--attach <name> | --detach <name>]');
    return;
  }
  const flags = parseCliFlags(argv.slice(1));
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { loadMcpConfig } = await import('@ethosagent/tools-mcp');
  const { ethosDir } = await import('./config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(ethosDir());

  const personality = reg.get(id);
  if (!personality) {
    console.error(`Unknown personality: ${id}`);
    process.exit(1);
  }

  const allServers = await loadMcpConfig(storage);
  const attached = new Set(personality.mcp_servers ?? []);

  if (flags.attach) {
    attached.add(flags.attach);
    await reg.update(id, { mcp_servers: [...attached] });
    console.log(`✓ Attached MCP server "${flags.attach}" to ${id}`);
    return;
  }
  if (flags.detach) {
    attached.delete(flags.detach);
    await reg.update(id, { mcp_servers: [...attached] });
    console.log(`✓ Detached MCP server "${flags.detach}" from ${id}`);
    return;
  }

  console.log(`\nMCP servers for ${id}:\n`);
  if (allServers.length === 0) {
    console.log('  No MCP servers configured in ~/.ethos/mcp.json');
  } else {
    for (const s of allServers) {
      const mark = attached.has(s.name) ? '✓' : ' ';
      console.log(`  [${mark}] ${s.name}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// ethos personality plugins <id> [--attach <plugin-id> | --detach <plugin-id>]
// ---------------------------------------------------------------------------

async function runPersonalityPlugins(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    console.log(
      'Usage: ethos personality plugins <id> [--attach <plugin-id> | --detach <plugin-id>]',
    );
    return;
  }
  const flags = parseCliFlags(argv.slice(1));
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { scanInstalledPlugins } = await import('@ethosagent/plugin-loader');
  const { ethosDir } = await import('./config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(ethosDir());

  const personality = reg.get(id);
  if (!personality) {
    console.error(`Unknown personality: ${id}`);
    process.exit(1);
  }

  const allPlugins = await scanInstalledPlugins({ userDir: ethosDir(), storage });
  const attached = new Set(personality.plugins ?? []);

  if (flags.attach) {
    attached.add(flags.attach);
    await reg.update(id, { plugins: [...attached] });
    console.log(`✓ Attached plugin "${flags.attach}" to ${id}`);
    return;
  }
  if (flags.detach) {
    attached.delete(flags.detach);
    await reg.update(id, { plugins: [...attached] });
    console.log(`✓ Detached plugin "${flags.detach}" from ${id}`);
    return;
  }

  console.log(`\nPlugins for ${id}:\n`);
  if (allPlugins.length === 0) {
    console.log('  No plugins installed. Run: ethos plugin install <path>');
  } else {
    for (const p of allPlugins) {
      const mark = attached.has(p.id) ? '✓' : ' ';
      console.log(`  [${mark}] ${p.id.padEnd(24)} ${p.description ?? ''}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// ethos plugins status — global plugin × personality matrix
// ---------------------------------------------------------------------------

async function runPluginsStatus(): Promise<void> {
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { scanInstalledPlugins } = await import('@ethosagent/plugin-loader');
  const { ethosDir } = await import('./config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(ethosDir());

  const allPlugins = await scanInstalledPlugins({ userDir: ethosDir(), storage });
  const allPersonalities = reg.list();

  if (allPlugins.length === 0) {
    console.log('\nNo plugins installed. Run: ethos plugin install <path>\n');
    return;
  }

  console.log('\nPlugin attachment status:\n');
  const colWidth = 20;
  const header = 'Plugin'.padEnd(colWidth) + allPersonalities.map((p) => p.id.padEnd(12)).join('');
  console.log(`  ${header}`);
  console.log(`  ${'-'.repeat(header.length)}`);

  for (const plugin of allPlugins) {
    let row = plugin.id.padEnd(colWidth);
    for (const personality of allPersonalities) {
      const attached = (personality.plugins ?? []).includes(plugin.id);
      row += (attached ? '✓' : '·').padEnd(12);
    }
    console.log(`  ${row}`);
  }
  console.log();

  const unattached = allPlugins.filter((p) =>
    allPersonalities.every((pers) => !(pers.plugins ?? []).includes(p.id)),
  );
  if (unattached.length > 0) {
    console.log(
      `  ⚠  ${unattached.length} plugin(s) installed but not attached to any personality — they're inert until attached.`,
    );
    console.log();
  }
}

function parseCliFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}
