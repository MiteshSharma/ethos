import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { bindResolvesToPersonality } from '@ethosagent/config';
import Database from '@ethosagent/sqlite';
import { parseTeamManifest } from '@ethosagent/team-supervisor';
import type { SessionStore, Storage } from '@ethosagent/types';
import type { CronDeliveryTarget } from '@ethosagent/web-contracts';
import { getApprovedSenders } from '@ethosagent/wiring/security-kernel';
import type { DiscoveredChatStore } from './discovered-chats';
import type { PlatformsService } from './platforms.service';

// Which chats a personality's own bots may be pointed at
// (plan/phases/recipes-gallery.md §1).
//
// A bot binding names a personality, never a chat, so the chatId cannot be
// derived from config alone — it has to come from somewhere the operator has
// already vouched for. This module answers "where may THIS personality's
// scheduled output be delivered", and its answer is the only thing
// `CronService.create` will accept: the set is recomputed here at create time,
// never trusted from the client.
//
// `resolveDeliveryTargets` is pure over an injected snapshot so the refusal
// rules are testable without a config file, a session DB or a gateway.

/** A configured bot, as far as delivery-target resolution cares. */
export interface DeliveryBot {
  platform: string;
  botKey: string;
  /** `@briefer_bot` where the platform knows one; the botKey otherwise. */
  botLabel: string;
  bind: { type: 'personality' | 'team'; name: string };
}

/** The operator's inbound policy for one platform, as `platforms.getChannelFilter` reports it. */
export interface ChannelFilterSnapshot {
  enabled: boolean;
  ownerUserId: string;
  allowlist: string[];
}

/** Every read the resolver needs. All reads; nothing here writes. */
export interface DeliveryTargetWorld {
  listBots(): Promise<DeliveryBot[]>;
  /** Member personality ids of a team, so a `team` bind can resolve. */
  teamMembers(teamName: string): Promise<readonly string[]>;
  channelFilter(platform: string): Promise<ChannelFilterSnapshot>;
  /** Pairing-approved senders for a platform. */
  approvedSenders(platform: string): Promise<string[]>;
  /** chatIds seen in this bot's gateway lane keys. */
  observedChatIds(platform: string, botKey: string): Promise<string[]>;
}

export interface DeliveryTargetResolution {
  /** Bots whose bind speaks for this personality — refusal rule 1's evidence. */
  bots: DeliveryBot[];
  /** Chats those bots may be pointed at — refusal rule 2's evidence. */
  targets: CronDeliveryTarget[];
}

const REASON: Record<CronDeliveryTarget['source'], string> = {
  owner: 'your owner chat',
  allowlist: 'on the allowlist',
  paired: 'paired with this bot',
  observed: 'you have messaged this bot here',
};

export async function resolveDeliveryTargets(
  world: DeliveryTargetWorld,
  personalityId: string,
): Promise<DeliveryTargetResolution> {
  const teamCache = new Map<string, readonly string[]>();
  const members = async (team: string): Promise<readonly string[]> => {
    const hit = teamCache.get(team);
    if (hit) return hit;
    const loaded = await world.teamMembers(team);
    teamCache.set(team, loaded);
    return loaded;
  };

  const bots: DeliveryBot[] = [];
  for (const bot of await world.listBots()) {
    const teamNames = bot.bind.type === 'team' ? await members(bot.bind.name) : [];
    if (bindResolvesToPersonality(bot.bind, personalityId, () => teamNames)) bots.push(bot);
  }

  const targets: CronDeliveryTarget[] = [];
  for (const bot of bots) {
    const filter = await world.channelFilter(bot.platform);
    // Refusal rule 3. An absent `channel_filter.<platform>` collapses to
    // `{enabled: true, ownerUserId: '', allowlist: []}` on the way through the
    // repository, which is indistinguishable from a block that declares
    // nothing — and both mean the same thing: the operator expressed no
    // opinion about who may talk to this bot. Reading that as "the bot may now
    // message anyone" inverts it, so only `observed` chats are offered.
    const expressed = filter.enabled && (filter.ownerUserId !== '' || filter.allowlist.length > 0);

    const seen = new Set<string>();
    const add = (chatId: string, source: CronDeliveryTarget['source']): void => {
      if (!chatId || seen.has(chatId)) return;
      seen.add(chatId);
      targets.push({
        platform: bot.platform,
        botKey: bot.botKey,
        botLabel: bot.botLabel,
        chatId,
        label: REASON[source],
        source,
      });
    };

    if (expressed) {
      add(filter.ownerUserId, 'owner');
      for (const entry of filter.allowlist) add(entry, 'allowlist');
      for (const sender of await world.approvedSenders(bot.platform)) add(sender, 'paired');
    }
    for (const chatId of await world.observedChatIds(bot.platform, bot.botKey)) {
      add(chatId, 'observed');
    }
  }

  return { bots, targets };
}

// ---------------------------------------------------------------------------
// The concrete world — what the running server actually reads
// ---------------------------------------------------------------------------

export interface LiveDeliveryTargetWorldOptions {
  platforms: PlatformsService;
  sessions: SessionStore;
  storage: Storage;
  /** `~/.ethos` — teams live under `<dataDir>/teams`, pairing at `<dataDir>/pairing.db`. */
  dataDir: string;
  /**
   * Chats the server itself watched message a bot, during a recipe's inline
   * channel setup. Unioned into `observedChatIds` because that is what they
   * are — see `discovered-chats.ts` for why they cannot come from anywhere
   * else on a machine whose gateway has never run.
   */
  discovered?: DiscoveredChatStore;
}

/** Team names come from config, but they are still path segments. */
const SAFE_TEAM_NAME = /^[A-Za-z0-9_-]+$/;

export function createLiveDeliveryTargetWorld(
  opts: LiveDeliveryTargetWorldOptions,
): DeliveryTargetWorld {
  return {
    async listBots(): Promise<DeliveryBot[]> {
      const out: DeliveryBot[] = [];
      const telegram = await opts.platforms.listTelegramBots();
      for (const bot of telegram.bots) {
        out.push({
          platform: 'telegram',
          botKey: bot.botKey,
          botLabel: bot.username ? `@${bot.username}` : bot.botKey,
          bind: bot.bind,
        });
      }
      const slack = await opts.platforms.listSlackApps();
      for (const app of slack.bots) {
        out.push({
          platform: 'slack',
          botKey: app.botKey,
          botLabel: app.botKey,
          bind: app.bind,
        });
      }
      const whatsapp = await opts.platforms.listWhatsApp();
      for (const entry of whatsapp.bots) {
        // A bind-less legacy WhatsApp entry speaks for nothing in particular;
        // offering its chats under some personality would be a guess.
        if (!entry.bind) continue;
        out.push({
          platform: 'whatsapp',
          botKey: entry.botKey,
          botLabel: entry.phoneNumber ?? entry.botKey,
          bind: entry.bind,
        });
      }
      return out;
    },

    async teamMembers(teamName: string): Promise<readonly string[]> {
      if (!SAFE_TEAM_NAME.test(teamName)) return [];
      const src = await opts.storage.read(join(opts.dataDir, 'teams', `${teamName}.yaml`));
      if (!src) return [];
      try {
        return parseTeamManifest(src).members.map((m) => m.personality);
      } catch {
        // Malformed manifest — resolve to no members rather than to everyone.
        return [];
      }
    },

    async channelFilter(platform: string): Promise<ChannelFilterSnapshot> {
      const { filter } = await opts.platforms.getChannelFilter(platform);
      return filter;
    },

    async approvedSenders(platform: string): Promise<string[]> {
      // CLAUDE.md Storage-abstraction exception, same rationale as
      // `apps/ethos/src/commands/pairing-commands.ts`: @ethosagent/sqlite opens
      // raw paths and manages WAL/SHM natively, so the pairing DB cannot be
      // read through the Storage interface. No DB yet (the gateway has never
      // run) means no approved senders, not an error.
      const path = join(opts.dataDir, 'pairing.db');
      if (!existsSync(path)) return [];
      const db = new Database(path, { readonly: true });
      try {
        return getApprovedSenders(db, platform);
      } catch {
        // Schema not initialised yet — the gateway creates the tables.
        return [];
      } finally {
        db.close();
      }
    },

    async observedChatIds(platform: string, botKey: string): Promise<string[]> {
      // Gateway lane keys are `${platform}:${botKey}:${chatId}[:${threadId}]`
      // with every segment URL-encoded (`buildLaneKey`), so the prefix filter
      // is exact and the third segment decodes back to the real chat id.
      const prefix = `${encodeURIComponent(platform)}:${encodeURIComponent(botKey)}:`;
      const sessions = await opts.sessions.listSessions({ keyPrefix: prefix });
      const ids = new Set<string>();
      for (const session of sessions) {
        const segment = session.key.split(':')[2];
        if (!segment) continue;
        try {
          ids.add(decodeURIComponent(segment));
        } catch {
          ids.add(segment);
        }
      }
      // A chat this server watched message this bot, before the gateway had
      // ever run and therefore before any lane key could exist.
      for (const chatId of (await opts.discovered?.list(platform, botKey)) ?? []) {
        ids.add(chatId);
      }
      return [...ids];
    },
  };
}
