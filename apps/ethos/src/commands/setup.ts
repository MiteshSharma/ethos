import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { type EthosConfig, ethosDir, readConfig, writeConfig } from '../config';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

function ask(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

export async function runSetup(): Promise<EthosConfig | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const existing = await readConfig();
  if (existing) {
    const ans = await ask(
      rl,
      `${c.yellow}Config already exists at ~/.ethos/config.yaml. Overwrite? (y/N)${c.reset} `,
    );
    if (ans.trim().toLowerCase() !== 'y') {
      console.log(`${c.dim}Keeping existing config.${c.reset}`);
      rl.close();
      return existing;
    }
  }

  console.log(`\n${c.cyan}${c.bold}ethos setup${c.reset}\n`);

  // Provider
  console.log(
    `${c.dim}Supported providers: anthropic, openai-compat (OpenRouter / Ollama / Gemini)${c.reset}`,
  );
  const provider = (await ask(rl, 'Provider (anthropic): ')).trim() || 'anthropic';

  // Model
  const defaultModel = provider === 'anthropic' ? 'claude-opus-4-7' : 'openai/gpt-4o';
  const model = (await ask(rl, `Model (${defaultModel}): `)).trim() || defaultModel;

  // API key — mask input if possible
  const apiKey = (await ask(rl, 'API key: ')).trim();
  if (!apiKey) {
    console.log(
      `${c.yellow}Warning: no API key entered. Edit ~/.ethos/config.yaml to add one.${c.reset}`,
    );
  }

  // Base URL for openai-compat
  let baseUrl: string | undefined;
  if (provider !== 'anthropic') {
    baseUrl =
      (await ask(rl, 'Base URL (https://openrouter.ai/api/v1): ')).trim() ||
      'https://openrouter.ai/api/v1';
  }

  // Personality
  console.log(
    `\n${c.dim}Personalities: researcher · engineer · reviewer · coach · operator${c.reset}`,
  );
  const personality = (await ask(rl, 'Default personality (researcher): ')).trim() || 'researcher';

  rl.close();

  const config: EthosConfig = { provider, model, apiKey, personality, baseUrl };
  await writeConfig(config);

  // Scaffold ~/.ethos/ directory structure
  const dir = ethosDir();
  await mkdir(join(dir, 'personalities'), { recursive: true });

  for (const filename of ['MEMORY.md', 'USER.md']) {
    try {
      await writeFile(join(dir, filename), '', { flag: 'wx', encoding: 'utf-8' });
    } catch {
      // File already exists — leave it untouched
    }
  }

  console.log(`\n${c.green}✓ Config saved to ~/.ethos/config.yaml${c.reset}`);
  console.log(`${c.green}✓ ~/.ethos/ directory ready${c.reset}`);
  console.log(
    `\n${c.dim}Run ${c.reset}${c.bold}ethos${c.reset}${c.dim} to start chatting.${c.reset}\n`,
  );

  return config;
}
