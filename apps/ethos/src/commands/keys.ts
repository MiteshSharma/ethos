import { readKeys, writeKeys } from '../config';
import { getStorage } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

function maskKey(key: string): string {
  if (key.length <= 16) return '***';
  return `${key.slice(0, 12)}...${key.slice(-4)}`;
}

export async function runKeys(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const storage = getStorage();

  switch (sub) {
    case 'list': {
      const keys = await readKeys(storage);
      if (keys.length === 0) {
        console.log(`\n${c.dim}No rotation keys configured.${c.reset}`);
        console.log(`${c.dim}Add one with: ${c.reset}ethos keys add <api-key>\n`);
        return;
      }
      console.log();
      console.log(`${c.bold}Key rotation pool${c.reset}  ${c.dim}(~/.ethos/keys.json)${c.reset}`);
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i];
        const label = k?.label ? `  ${c.dim}${k.label}${c.reset}` : '';
        const priority = `  ${c.dim}priority ${k?.priority ?? 0}${c.reset}`;
        console.log(
          `  ${c.cyan}[${i + 1}]${c.reset}  ${maskKey(k?.apiKey ?? '')}${label}${priority}`,
        );
      }
      console.log();
      break;
    }

    case 'add': {
      const apiKey = args[1];
      if (!apiKey) {
        console.log('Usage: ethos keys add <api-key> [--label <name>] [--priority <n>]');
        process.exit(1);
      }
      const labelIdx = args.indexOf('--label');
      const label = labelIdx >= 0 ? args[labelIdx + 1] : undefined;
      const prioIdx = args.indexOf('--priority');
      const priority = prioIdx >= 0 ? Number(args[prioIdx + 1]) : 50;

      const keys = await readKeys(storage);
      keys.push({ apiKey, priority, ...(label ? { label } : {}) });
      await writeKeys(storage, keys);
      console.log(
        `${c.green}✓ Key added${c.reset}  ${maskKey(apiKey)}  ${c.dim}priority ${priority}${c.reset}`,
      );
      break;
    }

    case 'remove': {
      const idx = Number(args[1]);
      if (!args[1] || Number.isNaN(idx) || idx < 1) {
        console.log('Usage: ethos keys remove <index>  (use ethos keys list to see indices)');
        process.exit(1);
      }
      const keys = await readKeys(storage);
      if (idx > keys.length) {
        console.log(`${c.red}No key at index ${idx}.${c.reset}`);
        process.exit(1);
      }
      const removed = keys.splice(idx - 1, 1)[0];
      await writeKeys(storage, keys);
      console.log(`${c.green}✓ Removed${c.reset}  ${maskKey(removed?.apiKey ?? '')}`);
      break;
    }

    default:
      console.log('Usage: ethos keys [list | add <key> | remove <index>]');
  }
}
