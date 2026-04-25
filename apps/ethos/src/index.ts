#!/usr/bin/env node
import { runAcp } from './commands/acp';
import { runBatch } from './commands/batch';
import { runChat } from './commands/chat';
import { runCronCommand } from './commands/cron';
import { runEval } from './commands/eval';
import { runGatewaySetup, runGatewayStart } from './commands/gateway';
import { runKeys } from './commands/keys';
import { runPlugin } from './commands/plugin';
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
    const { MarkdownFileMemoryProvider } = await import('@ethosagent/memory-markdown');
    const mem = new MarkdownFileMemoryProvider();

    if (sub === 'show' || sub === '') {
      const result = await mem.prefetch({ sessionId: '', sessionKey: 'cli', platform: 'cli' });
      if (result) {
        console.log(result.content);
      } else {
        console.log('No memory yet.');
      }
    } else if (sub === 'clear') {
      await mem.sync({ sessionId: '', sessionKey: 'cli', platform: 'cli' }, [
        { store: 'memory', action: 'replace', content: '' },
      ]);
      console.log('Memory cleared.');
    } else {
      console.log('Usage: ethos memory [show | clear]');
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
      'Usage: ethos [setup | chat | gateway | cron | personality | memory | acp | batch | eval | plugin | keys]',
    );
    process.exit(1);
}
