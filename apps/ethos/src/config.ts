import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Key rotation pool
// ---------------------------------------------------------------------------

export interface KeyProfile {
  apiKey: string;
  priority: number;
  label?: string;
}

export async function readKeys(): Promise<KeyProfile[]> {
  try {
    const src = await readFile(join(ethosDir(), 'keys.json'), 'utf-8');
    return JSON.parse(src) as KeyProfile[];
  } catch {
    return [];
  }
}

export async function writeKeys(keys: KeyProfile[]): Promise<void> {
  await mkdir(ethosDir(), { recursive: true });
  await writeFile(join(ethosDir(), 'keys.json'), `${JSON.stringify(keys, null, 2)}\n`, 'utf-8');
}

export interface EthosConfig {
  provider: string;
  model: string;
  apiKey: string;
  personality: string;
  baseUrl?: string;
  // Per-personality model overrides: maps personality ID → model ID string
  modelRouting?: Record<string, string>;
  // Platform tokens
  telegramToken?: string;
  discordToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  slackSigningSecret?: string;
  // Email platform
  emailImapHost?: string;
  emailImapPort?: number;
  emailUser?: string;
  emailPassword?: string;
  emailSmtpHost?: string;
  emailSmtpPort?: number;
}

export function ethosDir(): string {
  return join(homedir(), '.ethos');
}

export async function readConfig(): Promise<EthosConfig | null> {
  try {
    const src = await readFile(join(ethosDir(), 'config.yaml'), 'utf-8');
    return parseConfigYaml(src);
  } catch {
    return null;
  }
}

export async function writeConfig(config: EthosConfig): Promise<void> {
  await mkdir(ethosDir(), { recursive: true });
  const lines = [
    `provider: ${config.provider}`,
    `model: ${config.model}`,
    `apiKey: ${config.apiKey}`,
    `personality: ${config.personality}`,
  ];
  if (config.baseUrl) lines.push(`baseUrl: ${config.baseUrl}`);
  if (config.modelRouting) {
    for (const [id, model] of Object.entries(config.modelRouting)) {
      lines.push(`modelRouting.${id}: ${model}`);
    }
  }
  if (config.telegramToken) lines.push(`telegramToken: ${config.telegramToken}`);
  if (config.discordToken) lines.push(`discordToken: ${config.discordToken}`);
  if (config.slackBotToken) lines.push(`slackBotToken: ${config.slackBotToken}`);
  if (config.slackAppToken) lines.push(`slackAppToken: ${config.slackAppToken}`);
  if (config.slackSigningSecret) lines.push(`slackSigningSecret: ${config.slackSigningSecret}`);
  await writeFile(join(ethosDir(), 'config.yaml'), `${lines.join('\n')}\n`, 'utf-8');
}

function parseConfigYaml(src: string): EthosConfig {
  const kv: Record<string, string> = {};
  const modelRouting: Record<string, string> = {};
  for (const line of src.split('\n')) {
    // modelRouting.<personality>: <model>
    const mr = line.match(/^modelRouting\.(\S+):\s*(.+)$/);
    if (mr) {
      modelRouting[mr[1].trim()] = mr[2].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    const m = line.match(/^(\w+):\s*(.+)$/);
    if (m) kv[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return {
    provider: kv.provider ?? 'anthropic',
    model: kv.model ?? 'claude-opus-4-7',
    apiKey: kv.apiKey ?? '',
    personality: kv.personality ?? 'researcher',
    baseUrl: kv.baseUrl,
    modelRouting: Object.keys(modelRouting).length > 0 ? modelRouting : undefined,
    telegramToken: kv.telegramToken,
    discordToken: kv.discordToken,
    slackBotToken: kv.slackBotToken,
    slackAppToken: kv.slackAppToken,
    slackSigningSecret: kv.slackSigningSecret,
    emailImapHost: kv.emailImapHost,
    emailImapPort: kv.emailImapPort ? Number(kv.emailImapPort) : undefined,
    emailUser: kv.emailUser,
    emailPassword: kv.emailPassword,
    emailSmtpHost: kv.emailSmtpHost,
    emailSmtpPort: kv.emailSmtpPort ? Number(kv.emailSmtpPort) : undefined,
  };
}
