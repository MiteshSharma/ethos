import { describe, expect, it } from 'vitest';
import { checkCommand, createTerminalGuardHook } from '../guard';

// ---------------------------------------------------------------------------
// checkCommand
// ---------------------------------------------------------------------------

describe('checkCommand', () => {
  describe('safe commands — should NOT be blocked', () => {
    it.each([
      'rm -rf dist',
      'rm -rf node_modules',
      'rm -rf ./build',
      'rm -rf /tmp/my-temp-dir',
      'rm -f somefile.txt',
      'git push origin main',
      'pnpm install',
      'docker build -t myapp .',
      'SELECT * FROM users',
      'ALTER TABLE users ADD COLUMN email TEXT',
      'ls -la /',
    ])('allows: %s', (cmd) => {
      expect(checkCommand(cmd)).toEqual({ dangerous: false });
    });
  });

  describe('rm -rf on root or home — should be blocked', () => {
    it.each([
      'rm -rf /',
      'rm -rf / ',
      'rm -rf /*',
      'rm -rf ~/   ',
      'rm -rf ~/',
      'rm -rf ~/*',
      'rm -fr /',
      'rm -fr ~',
      'sudo rm -rf /',
    ])('blocks: %s', (cmd) => {
      const result = checkCommand(cmd);
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/recursive force-delete/);
    });
  });

  describe('dd to block device — should be blocked', () => {
    it('blocks dd writing to /dev/sda', () => {
      const result = checkCommand('dd if=/dev/zero of=/dev/sda bs=4M');
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/block device/);
    });

    it('blocks dd writing to /dev/nvme0n1', () => {
      const result = checkCommand('dd if=/dev/urandom of=/dev/nvme0n1');
      expect(result.dangerous).toBe(true);
    });

    it('allows dd reading from a block device', () => {
      expect(checkCommand('dd if=/dev/sda of=backup.img')).toEqual({ dangerous: false });
    });
  });

  describe('mkfs — should be blocked', () => {
    it('blocks mkfs.ext4', () => {
      const result = checkCommand('mkfs.ext4 /dev/sdb1');
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/filesystem format/);
    });

    it('blocks plain mkfs', () => {
      expect(checkCommand('mkfs /dev/sdb').dangerous).toBe(true);
    });
  });

  describe('redirect to block device — should be blocked', () => {
    it('blocks redirect to /dev/sda', () => {
      const result = checkCommand('cat /dev/urandom > /dev/sda');
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/block device/);
    });
  });

  describe('fork bomb — should be blocked', () => {
    it('blocks :(){:|:&};:', () => {
      const result = checkCommand(':(){:|:&};:');
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/fork bomb/);
    });
  });

  describe('destructive SQL DDL — should be blocked', () => {
    it.each([
      'DROP TABLE users',
      'DROP DATABASE mydb',
      'DROP SCHEMA public',
      'drop table users',
      'TRUNCATE TABLE orders',
      'truncate table sessions',
    ])('blocks: %s', (cmd) => {
      const result = checkCommand(cmd);
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/SQL/);
    });
  });
});

// ---------------------------------------------------------------------------
// createTerminalGuardHook
// ---------------------------------------------------------------------------

describe('createTerminalGuardHook', () => {
  const hook = createTerminalGuardHook();

  it('returns null for non-terminal tools', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'web_search',
      args: { query: 'hello' },
    });
    expect(result).toBeNull();
  });

  it('returns null for safe terminal commands', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'ls -la' },
    });
    expect(result).toBeNull();
  });

  it('returns error for dangerous terminal command', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
    });
    expect(result).not.toBeNull();
    expect(result?.error).toMatch(/Command blocked/);
    expect(result?.error).toMatch(/recursive force-delete/);
  });

  it('returns null when command arg is missing', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: {},
    });
    expect(result).toBeNull();
  });
});
