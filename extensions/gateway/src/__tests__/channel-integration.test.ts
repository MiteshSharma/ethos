import type { ChannelPlatformConfig } from '@ethosagent/safety-channel';
import { checkMessage, initPairingDb } from '@ethosagent/safety-channel';
import Database from '@ethosagent/sqlite';
import type { InboundMessage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PLATFORMS = ['telegram', 'discord', 'slack', 'whatsapp', 'email'] as const;

function msg(platform: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform,
    chatId: 'chat-1',
    userId: 'user-42',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    raw: null,
    ...overrides,
  };
}

describe('channel-integration: 5 platforms × 4 controls', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initPairingDb(db);
  });

  afterEach(() => {
    db.close();
  });

  // 1a — allowlist: allowlisted sender is allowed on all platforms
  for (const platform of PLATFORMS) {
    it(`[${platform}] 1a allowlist: allowlisted sender → allow`, () => {
      const config: ChannelPlatformConfig = {
        ownerUserId: 'owner-1',
        recipientAllowlist: ['user-42'],
      };
      expect(
        checkMessage(msg(platform, { userId: 'user-42', isDm: true }), config, db).action,
      ).toBe('allow');
    });
  }

  // 1a — allowlist: non-allowlisted sender in DM with allowlist policy → drop
  for (const platform of PLATFORMS) {
    it(`[${platform}] 1a allowlist: non-allowlisted DM + allowlist policy → drop`, () => {
      const config: ChannelPlatformConfig = { ownerUserId: 'owner-1', dmPolicy: 'allowlist' };
      expect(
        checkMessage(msg(platform, { userId: 'stranger', isDm: true }), config, db).action,
      ).toBe('drop');
    });
  }

  // 1b — pairing: non-allowlisted DM gets pairing code on all platforms
  for (const platform of PLATFORMS) {
    it(`[${platform}] 1b pairing: non-allowlisted DM + pairing policy → pairing_reply`, () => {
      const config: ChannelPlatformConfig = { ownerUserId: 'owner-1', dmPolicy: 'pairing' };
      const result = checkMessage(
        msg(platform, { userId: `stranger-${platform}`, isDm: true }),
        config,
        db,
      );
      expect(result.action).toBe('pairing_reply');
      expect(result.reply).toMatch(/\/allow [A-Z0-9]{8}/);
    });
  }

  // 1c — mention gate: allowlisted sender in group without mention → drop
  for (const platform of PLATFORMS) {
    it(`[${platform}] 1c mention gate: allowlisted group message without mention → drop`, () => {
      const config: ChannelPlatformConfig = {
        ownerUserId: 'owner-1',
        recipientAllowlist: ['user-42'],
      };
      expect(
        checkMessage(msg(platform, { isDm: false, isGroupMention: false }), config, db).action,
      ).toBe('drop');
    });
  }

  // 1c — mention gate: allowlisted sender in group with mention → allow
  for (const platform of PLATFORMS) {
    it(`[${platform}] 1c mention gate: allowlisted group message with mention → allow`, () => {
      const config: ChannelPlatformConfig = {
        ownerUserId: 'owner-1',
        recipientAllowlist: ['user-42'],
      };
      expect(
        checkMessage(msg(platform, { isDm: false, isGroupMention: true }), config, db).action,
      ).toBe('allow');
    });
  }

  // 1d — context filter: reply from non-allowlisted sender → stripped
  for (const platform of PLATFORMS) {
    it(`[${platform}] 1d context filter: reply from non-allowlisted sender → stripped`, () => {
      const config: ChannelPlatformConfig = {
        ownerUserId: 'owner-1',
        recipientAllowlist: ['user-42'],
        contextVisibility: 'allowlist',
      };
      const result = checkMessage(
        msg(platform, {
          isDm: true,
          replyToId: 'msg-x',
          replyToUserId: 'attacker',
          text: '> evil\nhello',
        }),
        config,
        db,
      );
      expect(result.action).toBe('allow');
      expect(result.strippedText).toBeDefined();
    });
  }

  // owner bypasses mention gate on all platforms
  for (const platform of PLATFORMS) {
    it(`[${platform}] owner bypasses mention gate in group`, () => {
      const config: ChannelPlatformConfig = {
        ownerUserId: 'owner-1',
        recipientAllowlist: ['user-42'],
      };
      expect(
        checkMessage(
          msg(platform, { userId: 'owner-1', isDm: false, isGroupMention: false }),
          config,
          db,
        ).action,
      ).toBe('allow');
    });
  }
});
