import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilePersonalityRegistry } from '@ethosagent/personalities';
import { FsStorage } from '@ethosagent/storage-fs';
import type { BeforeToolCallPayload, PersonalityConfig } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDangerPredicate, SMART_MODE_CONSEQUENTIAL_TOOLS } from '../danger-predicate';

function payload(toolName: string, args: unknown = {}): BeforeToolCallPayload {
  return { sessionId: 's', toolCallId: 'tc', toolName, args };
}

function person(
  approvalMode?: 'manual' | 'smart' | 'off',
  denyRules?: string[],
): PersonalityConfig {
  return {
    id: 'p',
    name: 'P',
    ...(approvalMode || denyRules
      ? {
          safety: {
            ...(approvalMode ? { approvalMode } : {}),
            ...(denyRules ? { denyRules } : {}),
          },
        }
      : {}),
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

  // The law: deny rules are the floor. Modes can only make things stricter,
  // never looser — so a rule binds even under the loosest possible config.
  describe('deny rules (safety.denyRules)', () => {
    it('denies under approvalMode off WITH allowAutoApproveDangerousTools', async () => {
      const pred = createDangerPredicate({
        getPersonality: () => person('off', ['git push --force']),
        allowAutoApproveDangerousTools: true,
      });
      const r = await pred(payload('terminal', { command: 'git push --force origin main' }));
      expect(r).toMatch(/denied by personality deny rule: git push --force/);
    });

    it('denies even when smart mode would auto-approve (rule beats reviewer)', async () => {
      let reviewed = false;
      const pred = createDangerPredicate({
        alwaysAsk: ['terminal'],
        getPersonality: () => person('smart', ['git push --force']),
        smartApprove: async () => {
          reviewed = true;
          return { decision: 'approve', reason: 'looks fine' };
        },
      });
      expect(await pred(payload('terminal', { command: 'git push --force' }))).toMatch(/deny rule/);
      expect(reviewed).toBe(false);
    });

    it('matches on the tool name too, not only on args', async () => {
      const pred = createDangerPredicate({
        getPersonality: () => person('off', ['email_send']),
        allowAutoApproveDangerousTools: true,
      });
      expect(await pred(payload('email_send', { to: 'a@b' }))).toMatch(/deny rule/);
    });

    it('leaves unmatched calls alone', async () => {
      const pred = createDangerPredicate({
        getPersonality: () => person('manual', ['git push --force']),
      });
      expect(await pred(payload('terminal', { command: 'git push' }))).toBeNull();
    });

    it('ignores an empty rule list and empty rule strings', async () => {
      const pred = createDangerPredicate({ getPersonality: () => person('manual', ['']) });
      expect(await pred(payload('terminal', { command: 'echo hi' }))).toBeNull();
    });
  });

  // The built-in flag list is what makes `smart` reachable at all: no
  // production caller passes `alwaysAsk`, so without it `dangerReason` was
  // always null under smart and the reviewer never ran.
  describe('SMART_MODE_CONSEQUENTIAL_TOOLS', () => {
    /** Calls that must never be flagged — one reviewer round-trip per lookup. */
    const READ_ONLY = ['read_file', 'search_files', 'web_search', 'list_available_tools'];

    it('never lists a read-only tool', () => {
      for (const tool of READ_ONLY) expect(SMART_MODE_CONSEQUENTIAL_TOOLS).not.toContain(tool);
    });

    it.each([
      ...SMART_MODE_CONSEQUENTIAL_TOOLS,
    ])('smart routes %s to the reviewer', async (tool) => {
      let reviewed: string | undefined;
      const pred = createDangerPredicate({
        getPersonality: () => person('smart'),
        smartApprove: async (p) => {
          reviewed = p.toolName;
          return { decision: 'approve', reason: 'routine' };
        },
      });
      expect(await pred(payload(tool, { command: 'echo hi', path: 'notes.md' }))).toBeNull();
      expect(reviewed).toBe(tool);
    });

    it.each([
      ...SMART_MODE_CONSEQUENTIAL_TOOLS,
    ])('manual leaves %s unflagged — the default path is unchanged', async (tool) => {
      const pred = createDangerPredicate({ getPersonality: () => person('manual') });
      expect(await pred(payload(tool, { command: 'echo hi', path: 'notes.md' }))).toBeNull();
    });

    it.each([...SMART_MODE_CONSEQUENTIAL_TOOLS])('off leaves %s unflagged', async (tool) => {
      const pred = createDangerPredicate({ getPersonality: () => person('off') });
      expect(await pred(payload(tool, { command: 'echo hi', path: 'notes.md' }))).toBeNull();
    });

    it('no personality resolved (legacy default) leaves the list unflagged', async () => {
      const pred = createDangerPredicate();
      for (const tool of SMART_MODE_CONSEQUENTIAL_TOOLS) {
        expect(await pred(payload(tool, { command: 'echo hi' }))).toBeNull();
      }
    });

    it.each(READ_ONLY)('smart does NOT route %s to the reviewer', async (tool) => {
      let reviewed = false;
      const pred = createDangerPredicate({
        getPersonality: () => person('smart'),
        smartApprove: async () => {
          reviewed = true;
          return { decision: 'ask', reason: 'unreachable' };
        },
      });
      expect(await pred(payload(tool, { path: 'notes.md' }))).toBeNull();
      expect(reviewed).toBe(false);
    });

    it('hardline still bypasses the reviewer even though terminal is on the list', async () => {
      let reviewed = false;
      const pred = createDangerPredicate({
        getPersonality: () => person('smart'),
        smartApprove: async () => {
          reviewed = true;
          return { decision: 'approve', reason: 'unreachable' };
        },
      });
      expect(await pred(payload('terminal', { command: 'rm -rf /' }))).toMatch(
        /recursive force-delete/,
      );
      expect(reviewed).toBe(false);
    });

    it('unions with an explicit alwaysAsk under smart rather than replacing it', async () => {
      const reviewed: string[] = [];
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('smart'),
        smartApprove: async (p) => {
          reviewed.push(p.toolName);
          return { decision: 'approve', reason: 'routine' };
        },
      });
      expect(await pred(payload('email_send', { to: 'a@b' }))).toBeNull();
      expect(await pred(payload('write_file', { path: 'notes.md' }))).toBeNull();
      expect(reviewed).toEqual(['email_send', 'write_file']);
    });

    it('an explicit alwaysAsk still takes effect under manual and off', async () => {
      for (const mode of ['manual', 'off'] as const) {
        const pred = createDangerPredicate({
          alwaysAsk: ['email_send'],
          getPersonality: () => person(mode),
        });
        expect(await pred(payload('email_send', { to: 'a@b' }))).toMatch(/explicit approval/);
      }
    });
  });

  describe('smart verdicts', () => {
    it('a reviewer deny surfaces the reviewer’s specific reason', async () => {
      const pred = createDangerPredicate({
        alwaysAsk: ['email_send'],
        getPersonality: () => person('smart'),
        smartApprove: async () => ({ decision: 'deny', reason: 'mails 400 external addresses' }),
      });
      const r = await pred(payload('email_send', { to: 'a@b' }));
      expect(r).toMatch(/denied by reviewer: mails 400 external addresses/);
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

// The loop every test above leaves open: they hand the predicate a
// hand-built PersonalityConfig, so they pass whether or not the personality
// loader can actually read `safety.denyRules` out of config.yaml. It could
// not — the field was parsed nowhere and dropped silently, making the whole
// feature unreachable from user config. This test drives the real path:
// config.yaml on disk → FilePersonalityRegistry → predicate.
describe('deny rules declared in config.yaml (disk → registry → predicate)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = join(tmpdir(), `ethos-deny-rules-e2e-${Date.now()}`);
    await mkdir(join(dir, 'guarded'), { recursive: true });
    await writeFile(
      join(dir, 'guarded', 'config.yaml'),
      [
        'name: Guarded',
        'safety:',
        '  approvalMode: off',
        '  denyRules:',
        '    - git push --force',
        '',
      ].join('\n'),
    );
    await writeFile(join(dir, 'guarded', 'SOUL.md'), '# Guarded');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('denies a matching call under the loosest possible mode', async () => {
    const registry = new FilePersonalityRegistry(new FsStorage());
    await registry.loadFromDirectory(dir);
    const config = registry.get('guarded');
    expect(config?.safety?.approvalMode).toBe('off');

    const pred = createDangerPredicate({
      getPersonality: () => config,
      allowAutoApproveDangerousTools: true,
    });

    expect(await pred(payload('terminal', { command: 'git push --force origin main' }))).toBe(
      'denied by personality deny rule: git push --force',
    );
    expect(await pred(payload('terminal', { command: 'git push origin main' }))).toBeNull();
  });
});
