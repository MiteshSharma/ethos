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
      const config = await readConfig();
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
        const cfg = await rc();
        if (!cfg) {
          console.error('Run ethos setup first.');
          process.exit(1);
        }
        await writeConfig({ ...cfg, personality: args[2] });
        console.log(`Personality set to: ${args[2]}`);
      } else {
        console.log('Usage: ethos personality [list | set <id>]');
      }
      break;
    }

    case 'memory': {
      const sub = args[1] ?? 'show';
      const config = await readConfig();

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
        const config = await readConfig();
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
      const config = await readConfig();
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runCronCommand(args[1] ?? 'list', args.slice(2), config);
      break;
    }

    case 'acp': {
      const config = await readConfig();
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runAcp(config);
      break;
    }

    case 'serve': {
      const config = await readConfig();
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runServe(args.slice(1), config);
      break;
    }

    case 'batch': {
      const config = await readConfig();
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runBatch(args.slice(1), config);
      break;
    }

    case 'eval': {
      const config = await readConfig();
      if (!config) {
        console.error('Run ethos setup first.');
        process.exit(1);
      }
      await runEval(args.slice(1), config);
      break;
    }

    case 'evolve': {
      const config = await readConfig();
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
