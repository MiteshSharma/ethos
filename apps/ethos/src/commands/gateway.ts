import { createInterface } from 'node:readline';
import { CronScheduler } from '@ethosagent/cron';
import { Gateway } from '@ethosagent/gateway';
import { DiscordAdapter } from '@ethosagent/platform-discord';
import { EmailAdapter } from '@ethosagent/platform-email';
import { SlackAdapter } from '@ethosagent/platform-slack';
import { TelegramAdapter } from '@ethosagent/platform-telegram';
import type { PlatformAdapter } from '@ethosagent/types';
import { type EthosConfig, readConfig, writeConfig } from '../config';
import { createAgentLoop } from '../wiring';

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
};

// ---------------------------------------------------------------------------
// ethos gateway setup
// ---------------------------------------------------------------------------

export async function runGatewaySetup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  console.log(`\n${c.cyan}${c.bold}ethos gateway setup${c.reset}\n`);
  console.log(
    `${c.dim}Create a Telegram bot at https://t.me/BotFather, then paste the token below.${c.reset}\n`,
  );

  const token = (await ask('Telegram bot token: ')).trim();
  rl.close();

  if (!token) {
    console.log(
      `${c.yellow}No token entered. Run ethos gateway setup again to configure.${c.reset}`,
    );
    return;
  }

  // Validate token by calling getMe
  console.log(`${c.dim}Validating token...${c.reset}`);
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };

    if (!data.ok) {
      console.log(`${c.red}Invalid token — Telegram rejected it.${c.reset}`);
      return;
    }

    const username = data.result?.username ?? '(unknown)';
    console.log(`${c.green}✓ Bot validated: @${username}${c.reset}`);
  } catch {
    console.log(
      `${c.yellow}Warning: could not reach Telegram to validate token. Saving anyway.${c.reset}`,
    );
  }

  const config = await readConfig();
  if (!config) {
    console.log(`${c.red}No ethos config found. Run ethos setup first.${c.reset}`);
    return;
  }

  await writeConfig({ ...config, telegramToken: token });
  console.log(`${c.green}✓ Token saved to ~/.ethos/config.yaml${c.reset}`);
  console.log(
    `\n${c.dim}Run ${c.reset}${c.bold}ethos gateway start${c.reset}${c.dim} to start the bot.${c.reset}\n`,
  );
}

// ---------------------------------------------------------------------------
// ethos gateway start
// ---------------------------------------------------------------------------

export async function runGatewayStart(config: EthosConfig): Promise<void> {
  const hasEmailConfig =
    config.emailImapHost && config.emailUser && config.emailPassword && config.emailSmtpHost;

  const hasAnyPlatform =
    config.telegramToken ||
    config.discordToken ||
    (config.slackBotToken && config.slackAppToken && config.slackSigningSecret) ||
    hasEmailConfig;

  if (!hasAnyPlatform) {
    console.log(`${c.red}No platform configured. Run: ethos gateway setup${c.reset}`);
    process.exit(1);
  }

  console.log(`${c.bold}ethos gateway${c.reset}  ${c.dim}starting...${c.reset}`);

  // Build the shared agent loop
  const loop = await createAgentLoop(config);

  // Build gateway
  const gateway = new Gateway({ loop, defaultPersonality: config.personality });

  // Build and register all configured adapters
  const adapters: PlatformAdapter[] = [];

  if (config.telegramToken) {
    const tg = new TelegramAdapter({ token: config.telegramToken, dropPendingUpdates: true });
    adapters.push(tg);
  }

  if (config.discordToken) {
    const dc = new DiscordAdapter({ token: config.discordToken });
    adapters.push(dc);
  }

  if (config.slackBotToken && config.slackAppToken && config.slackSigningSecret) {
    const sl = new SlackAdapter({
      botToken: config.slackBotToken,
      appToken: config.slackAppToken,
      signingSecret: config.slackSigningSecret,
    });
    adapters.push(sl);
  }

  if (hasEmailConfig) {
    const em = new EmailAdapter({
      imapHost: config.emailImapHost!,
      imapPort: config.emailImapPort ?? 993,
      user: config.emailUser!,
      password: config.emailPassword!,
      smtpHost: config.emailSmtpHost!,
      smtpPort: config.emailSmtpPort ?? 587,
    });
    adapters.push(em);
  }

  // Wire all adapters → gateway
  for (const adapter of adapters) {
    adapter.onMessage((message) => {
      void gateway.handleMessage(message, adapter).catch((err) => {
        console.error(`[gateway:${adapter.id}] Error:`, err);
      });
    });
  }

  // Start cron scheduler — runs inside the gateway process
  const scheduler = new CronScheduler({
    runJob: async (job) => {
      const sessionKey = `cron:${job.id}:${new Date().toISOString()}`;
      let output = '';
      for await (const event of loop.run(job.prompt, {
        sessionKey,
        personalityId: job.personality ?? config.personality,
      })) {
        if (event.type === 'text_delta') output += event.text;
      }
      return { jobId: job.id, ranAt: new Date().toISOString(), output, sessionKey };
    },
  });
  scheduler.start();
  console.log(`${c.dim}Cron scheduler running (checks every 60s)${c.reset}`);

  // Start all adapters
  await Promise.all(adapters.map((a) => a.start()));

  // Health checks
  for (const adapter of adapters) {
    const health = await adapter.health();
    if (health.ok) {
      const ms = health.latencyMs ? ` (${health.latencyMs}ms)` : '';
      console.log(`${c.green}✓ ${adapter.displayName} online${c.reset}${c.dim}${ms}${c.reset}`);
    } else {
      console.log(`${c.yellow}⚠ ${adapter.displayName} health check failed${c.reset}`);
    }
  }

  console.log(`${c.dim}Listening for messages. Press Ctrl+C to stop.${c.reset}\n`);

  // Graceful shutdown on SIGINT / SIGTERM
  const shutdown = async () => {
    console.log(`\n${c.dim}Shutting down...${c.reset}`);
    scheduler.stop();
    await gateway.shutdown();
    await Promise.allSettled(adapters.map((a) => a.stop()));
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // Keep the process alive (adapter polling runs async)
  await new Promise(() => {});
}
