import { spawnSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
};

function pluginsDir(): string {
  return join(homedir(), '.ethos', 'plugins');
}

export async function runPlugin(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'install': {
      const pkg = args[1];
      if (!pkg) {
        console.log('Usage: ethos plugin install <package>');
        process.exit(1);
      }
      const dir = pluginsDir();
      console.log(
        `${c.dim}Installing ${c.reset}${c.bold}${pkg}${c.reset}${c.dim} to ${dir}...${c.reset}\n`,
      );
      const result = spawnSync('npm', ['install', '--prefix', dir, pkg], { stdio: 'inherit' });
      if (result.status !== 0) {
        console.error(`${c.red}Install failed.${c.reset}`);
        process.exit(result.status ?? 1);
      }
      console.log(`\n${c.green}✓ Installed.${c.reset} Restart ethos to load the plugin.`);
      break;
    }

    case 'remove': {
      const pkg = args[1];
      if (!pkg) {
        console.log('Usage: ethos plugin remove <package>');
        process.exit(1);
      }
      const dir = pluginsDir();
      const result = spawnSync('npm', ['uninstall', '--prefix', dir, pkg], { stdio: 'inherit' });
      if (result.status !== 0) {
        console.error(`${c.red}Remove failed.${c.reset}`);
        process.exit(result.status ?? 1);
      }
      console.log(`\n${c.green}✓ Removed.${c.reset}`);
      break;
    }

    case 'list': {
      await listPlugins();
      break;
    }

    default:
      console.log('Usage: ethos plugin [install <pkg> | remove <pkg> | list]');
  }
}

async function listPlugins(): Promise<void> {
  const dir = pluginsDir();
  const nmDir = join(dir, 'node_modules');

  const manual: string[] = [];
  const npm: Array<{ name: string; version: string }> = [];

  // Direct subdirectories (manually dropped in, excluding node_modules)
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name !== 'node_modules') {
        manual.push(e.name);
      }
    }
  } catch {
    // plugins dir doesn't exist yet
  }

  // npm-installed: ethos-plugin-* and @ethos-plugins/* in node_modules
  try {
    const entries = await readdir(nmDir, { withFileTypes: true });
    const candidates = entries.filter(
      (e) =>
        e.isDirectory() &&
        (e.name.startsWith('ethos-plugin-') || e.name.startsWith('@ethos-plugins')),
    );

    for (const e of candidates) {
      const pkgPath = join(nmDir, e.name, 'package.json');
      try {
        const raw = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string };
        npm.push({ name: e.name, version: raw.version ?? '?' });
      } catch {
        npm.push({ name: e.name, version: '?' });
      }
    }

    // Also scan scoped @ethos-plugins/ subdirs
    for (const e of entries.filter((x) => x.isDirectory() && x.name.startsWith('@'))) {
      try {
        const scoped = await readdir(join(nmDir, e.name), { withFileTypes: true });
        for (const s of scoped.filter((x) => x.isDirectory())) {
          const name = `${e.name}/${s.name}`;
          const pkgPath = join(nmDir, name, 'package.json');
          try {
            const raw = JSON.parse(await readFile(pkgPath, 'utf-8')) as { version?: string };
            npm.push({ name, version: raw.version ?? '?' });
          } catch {
            npm.push({ name, version: '?' });
          }
        }
      } catch {
        // skip
      }
    }
  } catch {
    // node_modules doesn't exist yet
  }

  if (manual.length === 0 && npm.length === 0) {
    console.log(`\n${c.dim}No plugins installed.${c.reset}`);
    console.log(`${c.dim}Install one with: ${c.reset}ethos plugin install ethos-plugin-<name>\n`);
    return;
  }

  console.log();
  if (npm.length > 0) {
    console.log(`${c.bold}npm plugins${c.reset}  ${c.dim}(${dir}/node_modules)${c.reset}`);
    for (const p of npm) {
      console.log(`  ${c.cyan}${p.name}${c.reset}  ${c.dim}v${p.version}${c.reset}`);
    }
    console.log();
  }
  if (manual.length > 0) {
    console.log(`${c.bold}manual plugins${c.reset}  ${c.dim}(${dir})${c.reset}`);
    for (const name of manual) {
      console.log(`  ${c.cyan}${name}${c.reset}`);
    }
    console.log();
  }
}
