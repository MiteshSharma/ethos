import type { BeforeToolCallPayload, PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createDangerPredicate } from '../danger-predicate';

function payload(toolName: string, args: unknown = {}): BeforeToolCallPayload {
  return { sessionId: 's', toolCallId: 'tc', toolName, args };
}

function person(approvalMode?: 'manual' | 'smart' | 'off'): PersonalityConfig {
  return {
    id: 'p',
    name: 'P',
    ...(approvalMode ? { safety: { approvalMode } } : {}),
  };
}

describe('createDangerPredicate — Ch.4b approvalMode', () => {
  describe('hardline (terminal checkCommand)', () => {
    it('manual mode surfaces the hardline reason', async () => {
      const pred = createDangerPredicate({ getPersonality: () => person('manual') });
      const r = await pred(payload('terminal', { command: 'rm -rf /' }));
      expect(r).toMatch(/recursive force-delete/);
    });

    it('off mode does NOT auto-approve hardline (still surfaces the reason)', async () => {
      // The terminalGuardHook hard-blocks regardless of mode; the
      // predicate keeps returning the reason so the approval flow's
      // error message stays meaningful.
      const pred = createDangerPredicate({ getPersonality: () => person('off') });
      const r = await pred(payload('terminal', { command: 'rm -rf /' }));
      expect(r).toMatch(/recursive force-delete/);
    });

    it('smart mode does NOT auto-approve hardline either', async () => {
      const pred = createDangerPredicate({
        getPersonality: () => person('smart'),
        smartApprove: async () => ({ decision: 'approve', reason: 'low residual risk' }),
      });
      const r = await pred(payload('terminal', { command: 'rm -rf /' }));
      expect(r).toMatch(/recursive force-delete/);
    });
  });

  describe('non-hardline (alwaysAsk)', () => {
    it('manual surfaces the always-ask reason', async () => {
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('manual'),
      });
      const r = await pred(payload('email_send', { to: 'a@b' }));
      expect(r).toMatch(/email_send requires explicit approval/);
    });

    it('off auto-approves only when allowAutoApproveDangerousTools is set (cli/cron)', async () => {
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('off'),
        allowAutoApproveDangerousTools: true,
      });
      expect(await pred(payload('email_send', { to: 'a@b' }))).toBeNull();
    });

    it('off WITHOUT the capability flag falls back to manual (returns the reason)', async () => {
      // The personality registry's load-time check rejects off+channel
      // ingress, but the predicate cannot rely on cross-module invariants.
      // Without the explicit capability flag, off is treated as manual.
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('off'),
      });
      expect(await pred(payload('email_send', { to: 'a@b' }))).toMatch(/explicit approval/);
    });

    it('smart consults the callback — approve → auto-approve', async () => {
      let callbackArgs: { tool?: string; reason?: string } = {};
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('smart'),
        smartApprove: async (p, reason) => {
          callbackArgs = { tool: p.toolName, reason };
          return { decision: 'approve', reason: 'low residual risk' };
        },
      });
      expect(await pred(payload('email_send', { to: 'a@b' }))).toBeNull();
      expect(callbackArgs.tool).toBe('email_send');
      expect(callbackArgs.reason).toMatch(/explicit approval/);
    });

    it('smart consults the callback — ask → surface the reason', async () => {
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('smart'),
        smartApprove: async () => ({ decision: 'ask', reason: 'undecided' }),
      });
      expect(await pred(payload('email_send', { to: 'a@b' }))).toMatch(/explicit approval/);
    });

    it('smart without callback degrades to manual', async () => {
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('smart'),
      });
      expect(await pred(payload('email_send', { to: 'a@b' }))).toMatch(/explicit approval/);
    });
  });

  describe('non-dangerous tools', () => {
    it('returns null for benign terminal commands', async () => {
      const pred = createDangerPredicate({ getPersonality: () => person('manual') });
      expect(await pred(payload('terminal', { command: 'echo hi' }))).toBeNull();
    });

    it('returns null when no getPersonality and no danger', async () => {
      const pred = createDangerPredicate();
      expect(await pred(payload('terminal', { command: 'echo hi' }))).toBeNull();
    });
  });

  // Lock in the contract that the production web caller
  // (apps/ethos/src/commands/serve.ts → createDangerPredicate())
  // depends on: no options means hardline still hard-fails, and a
  // personality with off mode does NOT bypass approval. This guards
  // against future changes that would accidentally weaken the
  // option-less default for the web profile.
  describe('web-profile production-caller contract', () => {
    it('hardline still surfaces even with empty options', async () => {
      const pred = createDangerPredicate();
      expect(await pred(payload('terminal', { command: 'rm -rf /' }))).toMatch(
        /recursive force-delete/,
      );
    });

    it('off mode does NOT bypass approval without the capability flag', async () => {
      // The web profile constructs the predicate without
      // allowAutoApproveDangerousTools, so a personality config that
      // says off must STILL surface the danger reason for an
      // alwaysAsk tool. The registry separately rejects off+channel
      // ingress at load time; this is the predicate-local
      // belt-and-suspenders.
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('off'),
      });
      expect(await pred(payload('email_send', { to: 'a@b' }))).toMatch(/explicit approval/);
    });
  });
});
