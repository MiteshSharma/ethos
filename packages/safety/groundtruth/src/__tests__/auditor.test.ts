import type { TurnFinding } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createClaimsAuditor, formatGroundingMessage } from '../auditor';
import type { EvidenceRecord } from '../evidence';
import { LedgerStore } from '../evidence';

function ledgerWith(...records: Array<Partial<EvidenceRecord>>): LedgerStore {
  const ledgers = new LedgerStore();
  records.forEach((r, i) => {
    ledgers.append('s1', {
      toolCallId: `call-${i}`,
      toolName: 'terminal',
      ok: true,
      kind: 'command',
      at: 0,
      ...r,
    });
  });
  return ledgers;
}

async function audit(
  ledgers: LedgerStore,
  text: string,
  toolNames: string[],
  showUnsupported?: boolean,
): Promise<TurnFinding[]> {
  const auditor = createClaimsAuditor({
    ledgers,
    ...(showUnsupported === undefined ? {} : { showUnsupported }),
  });
  return auditor.audit({ sessionId: 's1', text, toolNames });
}

describe('verdicts', () => {
  it('says nothing when the evidence supports the claim', async () => {
    const ledgers = ledgerWith({ toolName: 'run_tests', command: 'pnpm test', exitCode: 0 });
    expect(await audit(ledgers, 'All tests pass.', ['run_tests'])).toEqual([]);
  });

  it('contradicts "tests pass" when the test run failed', async () => {
    const ledgers = ledgerWith({ toolCallId: 'tc-7', toolName: 'run_tests', ok: false });
    const [finding] = await audit(ledgers, 'All tests pass.', ['run_tests']);

    expect(finding?.code).toBe('contradicted');
    expect(finding?.severity).toBe('warn');
    expect(finding?.evidenceRef).toBe('tc-7');
    expect(finding?.message).toBe('"All tests pass." — run_tests failed [ref:tc-7]');
  });

  it('names a non-zero exit code in the evidence line', async () => {
    const ledgers = ledgerWith({
      toolCallId: 'tc-1',
      toolName: 'run_tests',
      command: 'pnpm test',
      exitCode: 1,
    });
    const [finding] = await audit(ledgers, 'The tests pass now.', ['run_tests']);
    expect(finding?.message).toBe('"The tests pass now." — run_tests exited 1 [ref:tc-1]');
  });

  it('contradicts a write claim when the write to THAT file failed', async () => {
    // The failed record carries the path from its `args` (see the collector) —
    // that is what makes it evidence about this claim rather than about some
    // other file.
    const ledgers = ledgerWith({
      toolCallId: 'w-1',
      toolName: 'write_file',
      ok: false,
      kind: 'file_write',
      path: '/repo/src/a.ts',
    });
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['write_file']);
    expect(finding?.code).toBe('contradicted');
    expect(finding?.evidenceRef).toBe('w-1');
  });

  it('contradicts an unqualified write claim from any failed write', async () => {
    // No path in the claim, so the kind is the whole claim and there is
    // nothing for the record to mismatch.
    const ledgers = ledgerWith({
      toolCallId: 'w-9',
      toolName: 'write_file',
      ok: false,
      kind: 'file_write',
      path: '/repo/src/z.ts',
    });
    const [finding] = await audit(ledgers, 'I updated the files.', ['write_file']);
    expect(finding?.code).toBe('contradicted');
    expect(finding?.evidenceRef).toBe('w-9');
  });

  it('supports a write claim only for the path that was written', async () => {
    const ledgers = ledgerWith({
      toolName: 'write_file',
      kind: 'file_write',
      path: '/repo/src/a.ts',
    });
    expect(await audit(ledgers, 'I wrote src/a.ts.', ['write_file'])).toEqual([]);

    const [finding] = await audit(ledgers, 'I wrote src/b.ts.', ['write_file'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('contradicts a process claim whose pid was gone at check', async () => {
    const ledgers = ledgerWith({
      toolCallId: 'p-1',
      toolName: 'process_start',
      kind: 'process',
      pid: 4242,
      aliveAtCheck: false,
    });
    const [finding] = await audit(ledgers, 'I started the dev server.', ['process_start']);
    expect(finding?.code).toBe('contradicted');
    expect(finding?.message).toContain('pid 4242 which was gone at check');
  });

  it('supports a VCS claim only from a git command', async () => {
    const gitLedger = ledgerWith({ command: 'git commit -m wip', exitCode: 0 });
    expect(await audit(gitLedger, 'I committed the change.', ['terminal'])).toEqual([]);

    const buildLedger = ledgerWith({ command: 'pnpm build', exitCode: 0 });
    const [finding] = await audit(buildLedger, 'I committed the change.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
  });
});

describe('unknown is not zero — a run that reported no exit code supports nothing', () => {
  it('does not let a command record with no exit code support a tests claim', async () => {
    // An older execution backend emits no exit chunk, so the tool returns
    // success carrying no `exitCode`. That is UNKNOWN, and reading it as a
    // pass is how "all tests pass" gets backed by a run that never said so.
    const ledgers = ledgerWith({ toolName: 'run_tests', command: 'pnpm test' });
    const [finding] = await audit(ledgers, 'All tests pass.', ['run_tests'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('does not let a command record with no exit code support a command claim', async () => {
    const ledgers = ledgerWith({ command: 'git commit -m wip' });
    const [finding] = await audit(ledgers, 'I committed the change.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('does not let it CONTRADICT either — unknown is not failure', async () => {
    const ledgers = ledgerWith({ toolName: 'run_tests', command: 'pnpm test' });
    const [finding] = await audit(ledgers, 'All tests pass.', ['run_tests'], true);
    expect(finding?.code).not.toBe('contradicted');
  });

  it('still supports the claim on an observed zero', async () => {
    const ledgers = ledgerWith({ toolName: 'run_tests', command: 'pnpm test', exitCode: 0 });
    expect(await audit(ledgers, 'All tests pass.', ['run_tests'], true)).toEqual([]);
  });
});

describe('path identity — a basename is not a file', () => {
  it('does not let a write to a same-basename file in another directory support a claim', async () => {
    const ledgers = ledgerWith({
      toolName: 'write_file',
      kind: 'file_write',
      path: '/repo/tests/a.ts',
    });
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['write_file'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('does not let a FAILED write to a same-basename file contradict a claim', async () => {
    const ledgers = ledgerWith({
      toolCallId: 'w-8',
      toolName: 'write_file',
      ok: false,
      kind: 'file_write',
      path: '/repo/tests/a.ts',
    });
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['write_file'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('matches a path suffix only on a segment boundary', async () => {
    const ledgers = ledgerWith({
      toolName: 'write_file',
      kind: 'file_write',
      path: '/repo/foo/notbar.ts',
    });
    const [finding] = await audit(ledgers, 'I wrote foo/bar.ts.', ['write_file'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('still supports a claim whose directory the record agrees with', async () => {
    const ledgers = ledgerWith({
      toolName: 'write_file',
      kind: 'file_write',
      path: '/repo/src/a.ts',
    });
    expect(await audit(ledgers, 'I wrote src/a.ts.', ['write_file'], true)).toEqual([]);
  });

  it('still matches a bare basename claim, which cannot be more specific', async () => {
    const ledgers = ledgerWith({
      toolName: 'write_file',
      kind: 'file_write',
      path: '/repo/src/a.ts',
    });
    expect(await audit(ledgers, 'I wrote a.ts.', ['write_file'], true)).toEqual([]);
  });
});

describe('command identity — a quoted argument is not the program', () => {
  it('does not let tests named inside a quoted argument make a git failure a test failure', async () => {
    const ledgers = ledgerWith({
      toolCallId: 'c-9',
      toolName: 'terminal',
      ok: false,
      command: 'git commit -m "fix failing tests"',
    });
    const [finding] = await audit(ledgers, 'The tests pass.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('does not let git named inside a quoted argument support a commit claim', async () => {
    const ledgers = ledgerWith({ command: 'echo "no git here"', exitCode: 0 });
    const [finding] = await audit(ledgers, 'I committed the change.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('still reads the family from the command words themselves', async () => {
    const ledgers = ledgerWith({ command: 'cd repo && git push origin HEAD', exitCode: 0 });
    expect(await audit(ledgers, 'I pushed the branch.', ['terminal'], true)).toEqual([]);
  });
});

describe('no false contradictions — a failure must be OF the claimed operation', () => {
  it('does not let a failed test run contradict a VCS claim', async () => {
    const ledgers = ledgerWith({
      toolCallId: 'c-1',
      toolName: 'run_tests',
      ok: false,
      command: 'pnpm test',
    });
    const [finding] = await audit(ledgers, 'I committed the change.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('does not let a failed command with no known command line contradict a VCS claim', async () => {
    const ledgers = ledgerWith({ toolCallId: 'c-2', toolName: 'terminal', ok: false });
    const [finding] = await audit(ledgers, 'I pushed the branch.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('does not let a failed write to one file contradict a claim about another', async () => {
    const ledgers = ledgerWith({
      toolCallId: 'w-2',
      toolName: 'write_file',
      ok: false,
      kind: 'file_write',
      path: '/repo/src/b.ts',
    });
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['write_file'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('does not let a failed write with no known path contradict a claim naming one', async () => {
    const ledgers = ledgerWith({
      toolCallId: 'w-3',
      toolName: 'write_file',
      ok: false,
      kind: 'file_write',
    });
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['write_file'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('still contradicts when the failed command IS the claimed one', async () => {
    const ledgers = ledgerWith({
      toolCallId: 'c-3',
      toolName: 'terminal',
      ok: false,
      command: 'git commit -m wip',
    });
    const [finding] = await audit(ledgers, 'I committed the change.', ['terminal']);
    expect(finding?.code).toBe('contradicted');
    expect(finding?.evidenceRef).toBe('c-3');
  });
});

describe('verdict gating (R7)', () => {
  it('shows no_tools_at_all when the turn ran nothing', async () => {
    const [finding] = await audit(new LedgerStore(), 'I wrote src/a.ts.', []);
    expect(finding?.code).toBe('no_tools_at_all');
    expect(finding?.severity).toBe('warn');
    expect(finding?.message).toBe('"I wrote src/a.ts." — no tools ran this turn');
  });

  it('hides unsupported when a write-capable tool ran', async () => {
    const ledgers = ledgerWith({ toolName: 'terminal', command: 'ls', exitCode: 0 });
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['terminal', 'read_file']);
    expect(finding?.code).toBe('unsupported');
    expect(finding?.severity).toBe('info');
  });

  it('shows unsupported when no write-capable tool ran', async () => {
    const ledgers = new LedgerStore();
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['read_file', 'web_search']);
    expect(finding?.code).toBe('unsupported');
    expect(finding?.severity).toBe('warn');
  });

  it('counts delegate_task as write-capable — children run in other sessions', async () => {
    const [finding] = await audit(new LedgerStore(), 'I wrote src/a.ts.', ['delegate_task']);
    expect(finding?.severity).toBe('info');
  });

  it('counts any MCP tool as write-capable', async () => {
    const [finding] = await audit(new LedgerStore(), 'I wrote src/a.ts.', ['mcp__gh__create_pr']);
    expect(finding?.severity).toBe('info');
  });

  it('showUnsupported exposes the muted verdict', async () => {
    const [finding] = await audit(new LedgerStore(), 'I wrote src/a.ts.', ['terminal'], true);
    expect(finding?.severity).toBe('warn');
  });

  it('is silent on a reply that claims nothing', async () => {
    expect(await audit(new LedgerStore(), 'Here is what the config does.', [])).toEqual([]);
  });
});

describe('a no-op write is not a write (FIX A)', () => {
  it('does not let a patch that changed nothing support a patch claim', async () => {
    // `changed: false` is `patch_file` reporting the patch was ALREADY applied
    // and nothing was written — the strongest statement a writing tool can make
    // that no modification occurred.
    const ledgers = ledgerWith({
      toolName: 'patch_file',
      kind: 'file_write',
      path: '/repo/src/a.ts',
      changed: false,
    });
    const [finding] = await audit(ledgers, 'I patched src/a.ts.', ['patch_file'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('does not let it CONTRADICT either — the tool did not fail', async () => {
    const ledgers = ledgerWith({
      toolName: 'patch_file',
      kind: 'file_write',
      path: '/repo/src/a.ts',
      changed: false,
    });
    const [finding] = await audit(ledgers, 'I patched src/a.ts.', ['patch_file'], true);
    expect(finding?.code).not.toBe('contradicted');
    expect(finding?.message).toContain('patch_file reported no change to /repo/src/a.ts');
  });

  it('still supports the claim when the patch did change the file', async () => {
    const ledgers = ledgerWith({
      toolName: 'patch_file',
      kind: 'file_write',
      path: '/repo/src/a.ts',
      changed: true,
    });
    expect(await audit(ledgers, 'I patched src/a.ts.', ['patch_file'], true)).toEqual([]);
  });

  it('reads an absent `changed` as unknown-but-written, not as false', async () => {
    // `write_file` reports no `changed`: it has no no-op branch.
    const ledgers = ledgerWith({
      toolName: 'write_file',
      kind: 'file_write',
      path: '/repo/src/a.ts',
    });
    expect(await audit(ledgers, 'I wrote src/a.ts.', ['write_file'], true)).toEqual([]);
  });

  it('lets a real write elsewhere in the turn support the claim over a no-op', async () => {
    const ledgers = ledgerWith(
      { toolName: 'patch_file', kind: 'file_write', path: '/repo/src/a.ts', changed: false },
      { toolName: 'write_file', kind: 'file_write', path: '/repo/src/a.ts' },
    );
    expect(await audit(ledgers, 'I patched src/a.ts.', ['patch_file'], true)).toEqual([]);
  });
});

describe('a VCS family is not a VCS operation (FIX B)', () => {
  it('does not let a successful git status support a push claim', async () => {
    const ledgers = ledgerWith({ command: 'git status --short', exitCode: 0 });
    const [finding] = await audit(ledgers, 'I pushed the branch.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
    expect(finding?.message).toContain('no push command recorded this turn');
  });

  it('does not let a successful git diff support a commit claim', async () => {
    const ledgers = ledgerWith({ command: 'git diff --stat', exitCode: 0 });
    const [finding] = await audit(ledgers, 'I committed the change.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('reaches past a successful family member to the failed push itself', async () => {
    // The bug: any successful `git` in the pool answered the claim before the
    // failure was ever examined.
    const ledgers = ledgerWith(
      { toolCallId: 'v-1', command: 'git status --short', exitCode: 0 },
      { toolCallId: 'v-2', command: 'git push origin HEAD', ok: false },
    );
    const [finding] = await audit(ledgers, 'I pushed the branch.', ['terminal']);
    expect(finding?.code).toBe('contradicted');
    expect(finding?.evidenceRef).toBe('v-2');
  });

  it('does not let a failed push contradict a commit claim', async () => {
    const ledgers = ledgerWith({ command: 'git push origin HEAD', ok: false });
    const [finding] = await audit(ledgers, 'I committed the change.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('takes the LAST command of the claimed operation when several ran', async () => {
    const retried = ledgerWith(
      { toolCallId: 'v-3', command: 'git push origin HEAD', ok: false },
      { toolCallId: 'v-4', command: 'git push origin HEAD', exitCode: 0 },
    );
    expect(await audit(retried, 'I pushed the branch.', ['terminal'], true)).toEqual([]);

    const broke = ledgerWith(
      { toolCallId: 'v-5', command: 'git push origin HEAD', exitCode: 0 },
      { toolCallId: 'v-6', command: 'git push origin HEAD', ok: false },
    );
    const [finding] = await audit(broke, 'I pushed the branch.', ['terminal']);
    expect(finding?.code).toBe('contradicted');
    expect(finding?.evidenceRef).toBe('v-6');
  });

  it('matches a branch claim to branch creation, not to a plain checkout', async () => {
    const created = ledgerWith({ command: 'git checkout -b feature/x', exitCode: 0 });
    expect(await audit(created, 'I created a branch.', ['terminal'], true)).toEqual([]);

    const switched = ledgerWith({ command: 'git checkout main', exitCode: 0 });
    const [finding] = await audit(switched, 'I created a branch.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
  });

  it('matches a pull-request claim to gh pr create', async () => {
    const ledgers = ledgerWith({ command: 'gh pr create --fill', exitCode: 0 });
    expect(await audit(ledgers, 'I opened a PR.', ['terminal'], true)).toEqual([]);
  });

  it('says unsupported when the claim names no operation the table can identify', async () => {
    const ledgers = ledgerWith({ command: 'git push origin HEAD', ok: false });
    const [finding] = await audit(ledgers, 'I ran git after the rebase.', ['terminal'], true);
    expect(finding?.code).toBe('unsupported');
    expect(finding?.message).toContain('names no version-control operation');
  });
});

describe('fail, fix, pass — the last test run is the one the claim describes', () => {
  it('does not contradict a tests claim when a later run of the same tests passed', async () => {
    // The commonest sequence in software development. Reading the FIRST
    // failure accused the model of lying about work it had actually done.
    const ledgers = ledgerWith(
      { toolCallId: 't-1', toolName: 'run_tests', ok: false, command: 'pnpm test' },
      { toolCallId: 't-2', toolName: 'write_file', kind: 'file_write', path: '/repo/src/a.ts' },
      { toolCallId: 't-3', toolName: 'run_tests', command: 'pnpm test', exitCode: 0 },
    );
    expect(await audit(ledgers, 'All tests pass.', ['run_tests', 'write_file'], true)).toEqual([]);
  });

  it('still contradicts when the last run of the tests failed', async () => {
    const ledgers = ledgerWith(
      { toolCallId: 't-4', toolName: 'run_tests', command: 'pnpm test', exitCode: 0 },
      { toolCallId: 't-5', toolName: 'run_tests', ok: false, command: 'pnpm test' },
    );
    const [finding] = await audit(ledgers, 'All tests pass.', ['run_tests']);
    expect(finding?.code).toBe('contradicted');
    expect(finding?.evidenceRef).toBe('t-5');
  });

  it('still contradicts a single failure that was never retried', async () => {
    const ledgers = ledgerWith({
      toolCallId: 't-6',
      toolName: 'run_tests',
      ok: false,
      command: 'pnpm test',
    });
    const [finding] = await audit(ledgers, 'All tests pass.', ['run_tests']);
    expect(finding?.code).toBe('contradicted');
    expect(finding?.evidenceRef).toBe('t-6');
  });
});

describe('a refused call is not activity (FIX C)', () => {
  it("shows the unsupported finding when the turn's only write-capable tool was refused", async () => {
    const ledgers = ledgerWith({
      toolCallId: 'r-1',
      toolName: 'terminal',
      ok: false,
      rejected: true,
      command: 'tee src/a.ts',
    });
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['terminal']);
    expect(finding?.code).toBe('unsupported');
    expect(finding?.severity).toBe('warn');
  });

  it('still gates it when that same tool actually ran', async () => {
    const ledgers = ledgerWith({ toolName: 'terminal', command: 'tee src/a.ts', exitCode: 0 });
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['terminal']);
    expect(finding?.code).toBe('unsupported');
    expect(finding?.severity).toBe('info');
  });

  it('still gates it when the tool was refused once and ran once', async () => {
    const ledgers = ledgerWith(
      { toolCallId: 'r-2', toolName: 'terminal', ok: false, rejected: true, command: 'tee a' },
      { toolCallId: 'r-3', toolName: 'terminal', command: 'tee b', exitCode: 0 },
    );
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['terminal']);
    expect(finding?.severity).toBe('info');
  });

  it('contradicts a write claim whose write_file was refused before it ran', async () => {
    const ledgers = ledgerWith({
      toolCallId: 'r-4',
      toolName: 'write_file',
      ok: false,
      rejected: true,
      kind: 'file_write',
      path: 'src/a.ts',
    });
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['write_file']);
    expect(finding?.code).toBe('contradicted');
    expect(finding?.severity).toBe('warn');
    expect(finding?.message).toBe(
      '"I wrote src/a.ts." — write_file was refused before it ran [ref:r-4]',
    );
  });

  it('still reports no_tools_at_all only when nothing was even attempted', async () => {
    // The other half of the same problem: a turn whose only call was blocked
    // DID try, so it must not read as a turn that used no tools at all.
    const ledgers = ledgerWith({
      toolName: 'write_file',
      ok: false,
      rejected: true,
      kind: 'file_write',
      path: 'src/a.ts',
    });
    const [finding] = await audit(ledgers, 'I wrote src/a.ts.', ['write_file']);
    expect(finding?.code).not.toBe('no_tools_at_all');
  });
});

describe('formatGroundingMessage', () => {
  it('emits claim, evidence and ref in the documented order', () => {
    expect(
      formatGroundingMessage({
        claim: 'tests pass',
        evidence: 'run_tests exited 1',
        citesToolCallId: 'tc-1',
      }),
    ).toBe('"tests pass" — run_tests exited 1 [ref:tc-1]');
  });

  it('replaces inner quotes so the closing quote stays unambiguous', () => {
    expect(formatGroundingMessage({ claim: 'I wrote "a.ts"' })).toBe(`"I wrote 'a.ts'"`);
  });

  it('flattens newlines and truncates a long claim', () => {
    const message = formatGroundingMessage({ claim: `${'x'.repeat(200)}\ny` });
    expect(message).toHaveLength(162);
    expect(message).toContain('…');
  });
});
