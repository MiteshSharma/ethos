import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EthosConfig } from '@ethosagent/config';
import type { InboundMessage, PlatformAdapter } from '@ethosagent/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type AdapterModuleLoader, buildAdapters } from '../commands/gateway';

// Phase 2 — multi-adapter instantiation.
//
// The plan calls for one adapter per configured bot/app on every multi-bot
// platform. This test exercises `buildAdapters` with a stub module loader
// so we can run the full construction loop without needing live grammy /
// @slack/bolt / discord.js SDKs.

interface CapturedAdapter extends PlatformAdapter {
  readonly capturedConfig: Record<string, unknown>;
}

function makeStubAdapter(name: string, cfg: Record<string, unknown>): CapturedAdapter {
  const botKey = cfg.botKey as string | undefined;
  return {
    id: botKey ? `${name}:${botKey}` : name,
    displayName: name,
    canSendTyping: false,
    canEditMessage: false,
    canReact: false,
    canSendFiles: false,
    maxMessageLength: 4096,
    capturedConfig: cfg,
    async start() {},
    async stop() {},
    async send() {
      return { ok: true };
    },
    onMessage(_h: (m: InboundMessage) => void) {},
    async health() {
      return { ok: true };
    },
  };
}

/**
 * Stub loader: returns the matching adapter module for every requested
 * platform, with a constructor that records the config it was called
 * with (so the test can assert the per-bot botKey threading).
 */
function makeLoader(): AdapterModuleLoader {
  const STUB_MODULES: Record<string, unknown> = {
    '@ethosagent/platform-telegram': {
      TelegramAdapter: class {
        constructor(cfg: Record<string, unknown>) {
          Object.assign(this, makeStubAdapter('telegram', cfg));
        }
      },
    },
    '@ethosagent/platform-slack': {
      SlackAdapter: class {
        constructor(cfg: Record<string, unknown>) {
          Object.assign(this, makeStubAdapter('slack', cfg));
        }
      },
    },
    '@ethosagent/platform-discord': {
      DiscordAdapter: class {
        constructor(cfg: Record<string, unknown>) {
          Object.assign(this, makeStubAdapter('discord', cfg));
        }
      },
    },
    '@ethosagent/platform-email': {
      EmailAdapter: class {
        constructor(cfg: Record<string, unknown>) {
          Object.assign(this, makeStubAdapter('email', cfg));
        }
      },
    },
  };
  // The loader is generic over the module shape it returns; the stub
  // narrows from `unknown` at call sites via the consumer's casts. The
  // shape returned matches what `buildAdapters` reads from each module.
  return async <T>(modulePath: string): Promise<T | null> => {
    return (STUB_MODULES[modulePath] ?? null) as T | null;
  };
}

const baseConfig: EthosConfig = {
  provider: 'anthropic',
  model: 'claude-opus-4-7',
  apiKey: 'sk',
  personality: 'researcher',
};

describe('buildAdapters — multi-bot adapter loop (Phase 2)', () => {
  it('creates one telegram adapter per telegram.bots entry, threading the right botKey', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [
            {
              id: 'researcher-bot',
              token: '1:t1',
              bind: { type: 'personality', name: 'researcher' },
            },
            {
              id: 'coder-bot',
              token: '2:t2',
              bind: { type: 'personality', name: 'coder' },
            },
          ],
        },
      },
      makeLoader(),
    );

    expect(adapters).toHaveLength(2);
    const captured = adapters.map((a) => (a as CapturedAdapter).capturedConfig);
    expect(captured[0]).toMatchObject({ token: '1:t1', botKey: 'researcher-bot' });
    expect(captured[1]).toMatchObject({ token: '2:t2', botKey: 'coder-bot' });
    expect(adapters[0].id).toBe('telegram:researcher-bot');
    expect(adapters[1].id).toBe('telegram:coder-bot');
  });

  it('creates one slack adapter per slack.apps entry, threading the right botKey', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        slack: {
          apps: [
            {
              id: 'prod-slack',
              botToken: 'xoxb-1',
              appToken: 'xapp-1',
              signingSecret: 's1',
              bind: { type: 'personality', name: 'researcher' },
            },
          ],
        },
      },
      makeLoader(),
    );

    expect(adapters).toHaveLength(1);
    expect((adapters[0] as CapturedAdapter).capturedConfig).toMatchObject({
      botToken: 'xoxb-1',
      appToken: 'xapp-1',
      signingSecret: 's1',
      botKey: 'prod-slack',
    });
    expect(adapters[0].id).toBe('slack:prod-slack');
  });

  it('boots cleanly with two telegram bots + one slack app (Phase 2 acceptance scenario)', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [
            { id: 'tg-a', token: '1:a', bind: { type: 'personality', name: 'researcher' } },
            { id: 'tg-b', token: '2:b', bind: { type: 'team', name: 'eng' } },
          ],
        },
        slack: {
          apps: [
            {
              id: 'sl-c',
              botToken: 'xoxb',
              appToken: 'xapp',
              signingSecret: 's',
              bind: { type: 'personality', name: 'coder' },
            },
          ],
        },
      },
      makeLoader(),
    );

    expect(adapters).toHaveLength(3);
    const ids = adapters.map((a) => a.id).sort();
    expect(ids).toEqual(['slack:sl-c', 'telegram:tg-a', 'telegram:tg-b']);
  });

  it('falls back to a derived hash when telegram.bots[i].id is omitted', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [
            {
              token: '123:ABC',
              bind: { type: 'personality', name: 'researcher' },
              // no explicit id — deriveBotKey produces sha256(token).slice(0, 24)
            },
          ],
        },
      },
      makeLoader(),
    );

    const captured = (adapters[0] as CapturedAdapter).capturedConfig;
    expect(captured.botKey).toMatch(/^[0-9a-f]{24}$/);
    expect(captured.botKey).not.toBe('123:ABC'); // not the raw token
  });

  it('returns an empty list when no platform is configured', async () => {
    const adapters = await buildAdapters(baseConfig, makeLoader());
    expect(adapters).toEqual([]);
  });

  it('handles a legacy single-bot Telegram config (telegramToken scalar) via the shim', async () => {
    // Operators upgrading from pre-multi-bot ethos have `telegramToken`
    // set without an explicit `telegram.bots[]` list. The boot path
    // already normalizes via `loadConfigStrict`, but `buildAdapters`
    // applies the shim defensively so calling it directly with a
    // legacy config still produces an adapter.
    const adapters = await buildAdapters(
      { ...baseConfig, telegramToken: '123:legacy-token' },
      makeLoader(),
    );

    expect(adapters).toHaveLength(1);
    expect(adapters[0].id.startsWith('telegram:')).toBe(true);
    const cfg = (adapters[0] as CapturedAdapter).capturedConfig;
    expect(cfg.token).toBe('123:legacy-token');
    // Derived botKey from sha256(token) — 24 hex chars.
    expect(cfg.botKey).toMatch(/^[0-9a-f]{24}$/);
  });

  it('handles a legacy single-app Slack config (botToken/appToken/signingSecret scalars) via the shim', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        slackBotToken: 'xoxb-legacy',
        slackAppToken: 'xapp-legacy',
        slackSigningSecret: 'sig-legacy',
      },
      makeLoader(),
    );

    expect(adapters).toHaveLength(1);
    expect(adapters[0].id.startsWith('slack:')).toBe(true);
    const cfg = (adapters[0] as CapturedAdapter).capturedConfig;
    expect(cfg.botToken).toBe('xoxb-legacy');
    expect(cfg.appToken).toBe('xapp-legacy');
    expect(cfg.signingSecret).toBe('sig-legacy');
    expect(cfg.botKey).toMatch(/^[0-9a-f]{24}$/);
  });

  it('threads a computed botKey into legacy discord + email adapters alongside multi-bot telegram', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [{ id: 'tg-a', token: '1:a', bind: { type: 'personality', name: 'researcher' } }],
        },
        discordToken: 'discord-tok',
        emailImapHost: 'imap.example.com',
        emailUser: 'me@example.com',
        emailPassword: 'pw',
        emailSmtpHost: 'smtp.example.com',
      },
      makeLoader(),
    );

    expect(adapters).toHaveLength(3);
    const byPlatform = new Map(
      adapters.map((a) => [(a as CapturedAdapter).displayName, a as CapturedAdapter]),
    );
    // P5.2 — botKey is now computed once in wiring and passed to every adapter,
    // including the legacy Discord/Email scalars (they no longer self-derive).
    expect(byPlatform.get('discord')?.capturedConfig.botKey).toMatch(/^[0-9a-f]{24}$/);
    expect(byPlatform.get('email')?.capturedConfig.botKey).toMatch(/^[0-9a-f]{24}$/);
    expect(byPlatform.get('telegram')?.id).toBe('telegram:tg-a');
  });

  it('skips a platform whose adapter module fails to load (graceful degradation)', async () => {
    const failingLoader: AdapterModuleLoader = async (modulePath) => {
      if (modulePath === '@ethosagent/platform-telegram') return null; // SDK missing
      return null;
    };
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        telegram: {
          bots: [{ id: 'tg-a', token: '1:a', bind: { type: 'personality', name: 'researcher' } }],
        },
      },
      failingLoader,
    );
    expect(adapters).toEqual([]);
  });
});

// SP-A — Slack boot wiring (plan/phases/slack-parity-multimodal.md, Part A).
//
// `SlackAdapterConfig` has accepted `defaultChannelMode`, `receiptReaction`,
// `webUiBaseUrl`, `session`, `sessionUnfurl`, `kanban`, `kanbanUnfurl` and
// `personalityUnfurl` since the adapter was written, but the construction site
// passed none of them — unfurls, App Home session rows and the workspace
// default channel mode silently degraded. This block is the regression guard
// for exactly that failure mode: "built, but nobody passed it".
describe('buildAdapters — Slack surface wiring (SP-A)', () => {
  let stateDir: string;
  let priorStateDir: string | undefined;

  beforeAll(async () => {
    // Point `ethosDir()` at a scratch dir: the session reader opens
    // `sessions.db` and the kanban reader probes `teams/<name>/board.db`, and
    // neither belongs in the developer's real `~/.ethos`.
    priorStateDir = process.env.ETHOS_STATE_DIR;
    stateDir = await mkdtemp(join(tmpdir(), 'ethos-slack-wiring-'));
    process.env.ETHOS_STATE_DIR = stateDir;
  });

  afterAll(async () => {
    if (priorStateDir === undefined) delete process.env.ETHOS_STATE_DIR;
    else process.env.ETHOS_STATE_DIR = priorStateDir;
    await rm(stateDir, { recursive: true, force: true });
  });

  const slackApp = (bind: { type: 'personality' | 'team'; name: string }) => ({
    id: `sl-${bind.name}`,
    botToken: 'xoxb',
    appToken: 'xapp',
    signingSecret: 's',
    bind,
  });

  it('passes the per-app surface knobs and the public web URL to the adapter', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        // Not a Slack-specific key: the same public URL the OAuth redirect
        // uses (`ETHOS_PUBLIC_URL` / `webBaseUrl`).
        webBaseUrl: 'https://ethos.example.com',
        slack: {
          apps: [
            {
              ...slackApp({ type: 'personality', name: 'researcher' }),
              defaultChannelMode: 'thread_follow',
              receiptReaction: 'hourglass_flowing_sand',
            },
          ],
        },
      },
      makeLoader(),
    );

    expect((adapters[0] as CapturedAdapter).capturedConfig).toMatchObject({
      defaultChannelMode: 'thread_follow',
      receiptReaction: 'hourglass_flowing_sand',
      // Without this the adapter's `registerLinkEvents` returns early and no
      // `link_shared` handler is ever registered.
      webUiBaseUrl: 'https://ethos.example.com',
    });
  });

  // SP-B1 — the bot allowlist has to survive the trip from config to adapter;
  // an unwired key is a gate that silently never opens.
  it('passes allowedBotIds through to the adapter', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        slack: {
          apps: [
            {
              ...slackApp({ type: 'personality', name: 'researcher' }),
              allowedBotIds: ['B_DEPLOY'],
            },
          ],
        },
      },
      makeLoader(),
    );

    expect((adapters[0] as CapturedAdapter).capturedConfig).toMatchObject({
      allowedBotIds: ['B_DEPLOY'],
    });
  });

  it('omits the knobs the operator did not set, leaving adapter defaults in charge', async () => {
    const adapters = await buildAdapters(
      { ...baseConfig, slack: { apps: [slackApp({ type: 'personality', name: 'researcher' })] } },
      makeLoader(),
    );

    const cfg = (adapters[0] as CapturedAdapter).capturedConfig;
    expect(cfg).not.toHaveProperty('defaultChannelMode');
    expect(cfg).not.toHaveProperty('receiptReaction');
    expect(cfg).not.toHaveProperty('webUiBaseUrl');
    expect(cfg).not.toHaveProperty('allowedBotIds');
  });

  it('wires session + personality-unfurl readers on every Slack bot', async () => {
    const adapters = await buildAdapters(
      { ...baseConfig, slack: { apps: [slackApp({ type: 'personality', name: 'researcher' })] } },
      makeLoader(),
    );

    const cfg = (adapters[0] as CapturedAdapter).capturedConfig as {
      session: { recentSessions: () => Promise<unknown[]> };
      sessionUnfurl: { lookupSession: (id: string) => Promise<unknown> };
      personalityUnfurl: { lookupPersonality: (id: string) => Promise<unknown> };
    };
    // Live objects, not just truthy fields — call each one against the empty
    // scratch state dir.
    expect(await cfg.session.recentSessions()).toEqual([]);
    expect(await cfg.sessionUnfurl.lookupSession('no-such-session')).toBeNull();
    expect(await cfg.personalityUnfurl.lookupPersonality('no-such-personality')).toBeNull();
  });

  it('wires kanban readers for team-bound bots only', async () => {
    const adapters = await buildAdapters(
      {
        ...baseConfig,
        slack: {
          apps: [
            slackApp({ type: 'team', name: 'eng' }),
            slackApp({ type: 'personality', name: 'researcher' }),
          ],
        },
      },
      makeLoader(),
    );

    const team = (adapters[0] as CapturedAdapter).capturedConfig as {
      kanban: { listOpenTickets: () => Promise<unknown[]> };
      kanbanUnfurl: { lookupTicket: (id: string) => Promise<unknown> };
    };
    // No board on disk for this team yet — degrade to empty rather than
    // creating one as a side effect of booting.
    expect(await team.kanban.listOpenTickets()).toEqual([]);
    expect(await team.kanbanUnfurl.lookupTicket('T-1')).toBeNull();

    const personality = (adapters[1] as CapturedAdapter).capturedConfig;
    expect(personality).not.toHaveProperty('kanban');
    expect(personality).not.toHaveProperty('kanbanUnfurl');
  });
});
