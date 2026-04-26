#!/usr/bin/env node
import { runAcp } from './commands/acp';
import { runBatch } from './commands/batch';
import { runChat } from './commands/chat';
import { runCronCommand } from './commands/cron';
import { runEval } from './commands/eval';
import { runGatewaySetup, runGatewayStart } from './commands/gateway';
import { runKeys } from './commands/keys';
import { runPlugin } from './commands/plugin';
import { runServe } from './commands/serve';
import { runSetup } from './commands/setup';
import { readConfig } from './config';

const args = process.argv.slice(2);
const command = args[0] ?? '';

switch (command) {
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

  case 'plugin': {
    await runPlugin(args.slice(1));
    break;
  }

  case 'keys': {
    await runKeys(args.slice(1));
    break;
  }

  default:
    console.log(`Unknown command: ${command}`);
    console.log(
      'Usage: ethos [setup | chat | serve | gateway | cron | personality | memory | acp | batch | eval | plugin | keys]',
    );
    process.exit(1);
}
