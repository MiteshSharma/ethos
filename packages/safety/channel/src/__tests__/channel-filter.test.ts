import Database from '@ethosagent/sqlite';
import type { InboundMessage } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ChannelPlatformConfig } from '../channel-filter';
import { checkMessage, isSenderAllowed } from '../channel-filter';
import { initPairingDb } from '../pairing-store';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function msg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    platform: 'telegram',
    chatId: 'chat-1',
    userId: 'user-42',
    text: 'hello',
    isDm: true,
    isGroupMention: false,
    raw: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkMessage', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    initPairingDb(db);
  });

  afterEach(() => {
    db.close();
  });

  it('allowlisted sender in DM → allow', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(msg({ userId: 'user-42', isDm: true }), config, db);
    expect(result.action).toBe('allow');
  });

  it('non-allowlisted DM + pairing policy → pairing_reply with code', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      dmPolicy: 'pairing',
    };
    const result = checkMessage(msg({ userId: 'stranger', isDm: true }), config, db);
    expect(result.action).toBe('pairing_reply');
    expect(result.reply).toMatch(/\/allow [A-Z0-9]{8}/);
  });

  it('non-allowlisted DM + allowlist policy → drop', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      dmPolicy: 'allowlist',
    };
    const result = checkMessage(msg({ userId: 'stranger', isDm: true }), config, db);
    expect(result.action).toBe('drop');
  });

  it('non-allowlisted group message → drop silently', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: [],
    };
    const result = checkMessage(
      msg({ userId: 'stranger', isDm: false, isGroupMention: true }),
      config,
      db,
    );
    expect(result.action).toBe('drop');
  });

  it('allowlisted group message + no mention → drop (mention gating)', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(
      msg({ userId: 'user-42', isDm: false, isGroupMention: false }),
      config,
      db,
    );
    expect(result.action).toBe('drop');
  });

  it('allowlisted group message + mention → allow', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(
      msg({ userId: 'user-42', isDm: false, isGroupMention: true }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
  });

  it('contextVisibility allowlist + reply message → strippedText set', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
      contextVisibility: 'allowlist',
    };
    const result = checkMessage(
      msg({
        userId: 'user-42',
        isDm: true,
        replyToId: 'msg-100',
        replyToUserId: 'attacker-99',
        text: '> quoted\nmy reply',
      }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
    expect(result.strippedText).toBeDefined();
    expect(result.strippedText).toContain('[quoted content from non-allowlisted sender removed]');
  });

  it('contextVisibility allowlist + reply with no replyToUserId → not stripped (unknown sender)', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
      contextVisibility: 'allowlist',
    };
    const result = checkMessage(
      msg({ userId: 'user-42', isDm: true, replyToId: 'msg-100', text: '> quoted\nmy reply' }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
    expect(result.strippedText).toBeUndefined();
  });

  it('contextVisibility allowlist + reply from allowlisted sender → not stripped', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42', 'trusted-user'],
      contextVisibility: 'allowlist',
    };
    const result = checkMessage(
      msg({
        userId: 'user-42',
        isDm: true,
        replyToId: 'msg-200',
        replyToUserId: 'trusted-user',
        text: '> trusted content\nmy reply',
      }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
    expect(result.strippedText).toBeUndefined();
  });

  // CHS-002 — step 7 owns every context-carrying field, not just `text`.
  // `priorContext` is a block of third-party history the adapter attached; the
  // filter never inspected it before, so a sender it drops at step 4 could
  // still reach the model through it.

  const historyConfig: ChannelPlatformConfig = {
    ownerUserId: 'owner-1',
    recipientAllowlist: ['user-42'],
    contextVisibility: 'allowlist',
  };

  const historyMsg = (overrides: Partial<InboundMessage> = {}): InboundMessage =>
    msg({
      userId: 'user-42',
      isDm: true,
      priorContext: 'user-42: morning\nattacker-99: SECRET',
      priorContextEntries: [
        { userId: 'user-42', text: 'user-42: morning' },
        { userId: 'attacker-99', text: 'attacker-99: SECRET' },
      ],
      ...overrides,
    });

  it('contextVisibility allowlist + mixed priorContext → non-allowlisted lines removed', () => {
    const result = checkMessage(historyMsg(), historyConfig, db);
    expect(result.action).toBe('allow');
    expect(result.strippedPriorContext).toBeDefined();
    expect(result.strippedPriorContext).not.toContain('SECRET');
    expect(result.strippedPriorContext).toContain('user-42: morning');
  });

  it('contextVisibility allowlist + no allowlisted author → empty (drop the block)', () => {
    const result = checkMessage(
      historyMsg({
        priorContext: 'attacker-99: SECRET',
        priorContextEntries: [{ userId: 'attacker-99', text: 'attacker-99: SECRET' }],
      }),
      historyConfig,
      db,
    );
    expect(result.strippedPriorContext).toBe('');
  });

  it('contextVisibility allowlist + every author allowlisted → left alone', () => {
    const result = checkMessage(
      historyMsg({
        priorContext: 'user-42: morning',
        priorContextEntries: [{ userId: 'user-42', text: 'user-42: morning' }],
      }),
      historyConfig,
      db,
    );
    expect(result.strippedPriorContext).toBeUndefined();
  });

  it('contextVisibility allowlist + unattributed priorContext → dropped (fail closed)', () => {
    const result = checkMessage(historyMsg({ priorContextEntries: undefined }), historyConfig, db);
    expect(result.strippedPriorContext).toBe('');
  });

  it('contextVisibility allowlist + priorContext with an empty entry list → dropped', () => {
    const result = checkMessage(historyMsg({ priorContextEntries: [] }), historyConfig, db);
    expect(result.strippedPriorContext).toBe('');
  });

  it('contextVisibility allowlist + entry with no userId → dropped (unattributable)', () => {
    const result = checkMessage(
      historyMsg({
        priorContext: 'unknown: SECRET',
        priorContextEntries: [{ text: 'unknown: SECRET' }],
      }),
      historyConfig,
      db,
    );
    expect(result.strippedPriorContext).toBe('');
  });

  it('contextVisibility all (default) + priorContext → never rewritten', () => {
    const result = checkMessage(
      historyMsg(),
      { ownerUserId: 'owner-1', recipientAllowlist: ['user-42'] },
      db,
    );
    expect(result.action).toBe('allow');
    expect(result.strippedPriorContext).toBeUndefined();
    expect(result.strippedText).toBeUndefined();
  });

  it('contextVisibility allowlist strips quoted text and history in the same result', () => {
    const result = checkMessage(
      historyMsg({
        replyToId: 'msg-100',
        replyToUserId: 'attacker-99',
        text: '> quoted\nmy reply',
      }),
      historyConfig,
      db,
    );
    expect(result.strippedText).toContain('[quoted content from non-allowlisted sender removed]');
    expect(result.strippedPriorContext).not.toContain('SECRET');
  });

  it('allowlisted bot history survives only when its bot_id is on the allowlist (SP-B1)', () => {
    const botHistory = historyMsg({
      priorContext: 'deploybot: build 42 shipped',
      priorContextEntries: [{ userId: 'B_DEPLOY', text: 'deploybot: build 42 shipped' }],
    });
    expect(
      checkMessage(botHistory, { ...historyConfig, recipientAllowlist: ['user-42'] }, db)
        .strippedPriorContext,
    ).toBe('');
    expect(
      checkMessage(
        botHistory,
        { ...historyConfig, recipientAllowlist: ['user-42', 'B_DEPLOY'] },
        db,
      ).strippedPriorContext,
    ).toBeUndefined();
  });

  it('owner in group without mention bypasses mention gate', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(
      msg({ userId: 'owner-1', isDm: false, isGroupMention: false }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
  });

  it('email glob *@domain.com matches user@domain.com', () => {
    const result = checkMessage(
      msg({ userId: 'alice@myteam.com', isDm: true, platform: 'email' }),
      { recipientAllowlist: ['*@myteam.com'], dmPolicy: 'allowlist' },
      db,
    );
    expect(result.action).toBe('allow');
  });

  it('email glob *@domain.com does not match user@other.com', () => {
    const result = checkMessage(
      msg({ userId: 'alice@other.com', isDm: true, platform: 'email' }),
      { recipientAllowlist: ['*@myteam.com'], dmPolicy: 'allowlist' },
      db,
    );
    expect(result.action).toBe('drop');
  });

  it('no platform config → allow (backward compat)', () => {
    const result = checkMessage(msg(), undefined, db);
    expect(result.action).toBe('allow');
  });

  it('owner userId is always allowed', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-special',
      recipientAllowlist: [],
      dmPolicy: 'allowlist',
    };
    const result = checkMessage(msg({ userId: 'owner-special', isDm: true }), config, db);
    expect(result.action).toBe('allow');
  });

  it('non-allowlisted DM + reject policy → drop', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      dmPolicy: 'reject',
    };
    const result = checkMessage(msg({ userId: 'stranger', isDm: true }), config, db);
    expect(result.action).toBe('drop');
  });

  it('non-allowlisted DM + silent-drop policy → drop', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      dmPolicy: 'silent-drop',
    };
    const result = checkMessage(msg({ userId: 'stranger', isDm: true }), config, db);
    expect(result.action).toBe('drop');
  });

  it('enabled: false → non-allowlisted sender in group → allow (filter bypassed)', () => {
    const config: ChannelPlatformConfig = {
      enabled: false,
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(
      msg({ userId: 'stranger', isDm: false, isGroupMention: false }),
      config,
      db,
    );
    expect(result.action).toBe('allow');
  });

  it('enabled: false → non-allowlisted sender in DM → allow (filter bypassed)', () => {
    const config: ChannelPlatformConfig = {
      enabled: false,
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(msg({ userId: 'stranger', isDm: true }), config, db);
    expect(result.action).toBe('allow');
  });

  it('enabled: true → behaves identically to omitting the key (regression guard)', () => {
    const config: ChannelPlatformConfig = {
      enabled: true,
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(
      msg({ userId: 'stranger', isDm: false, isGroupMention: true }),
      config,
      db,
    );
    expect(result.action).toBe('drop');
  });

  it('enabled omitted → behaves as today (regression guard)', () => {
    const config: ChannelPlatformConfig = {
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    const result = checkMessage(
      msg({ userId: 'stranger', isDm: false, isGroupMention: true }),
      config,
      db,
    );
    expect(result.action).toBe('drop');
  });
});

describe('isSenderAllowed', () => {
  it('enabled: false → non-allowlisted sender → true (filter bypassed)', () => {
    const config: ChannelPlatformConfig = {
      enabled: false,
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    expect(isSenderAllowed(msg({ userId: 'stranger' }), config)).toBe(true);
  });

  it('enabled: true → non-allowlisted sender → false', () => {
    const config: ChannelPlatformConfig = {
      enabled: true,
      ownerUserId: 'owner-1',
      recipientAllowlist: ['user-42'],
    };
    expect(isSenderAllowed(msg({ userId: 'stranger' }), config)).toBe(false);
  });
});
