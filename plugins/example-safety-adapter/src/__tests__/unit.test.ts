import { afterEach, describe, expect, it } from 'vitest';
import { beforeToolCall, deactivate, getBlockedCommands, isDangerous } from '../index';

afterEach(() => {
  deactivate(); // clears blocked commands list
});

describe('isDangerous', () => {
  it('flags rm -rf /', () => expect(isDangerous('rm -rf /')).toBe(true));
  it('flags shutdown -r now', () => expect(isDangerous('shutdown -r now')).toBe(true));
  it('flags dd to disk device', () =>
    expect(isDangerous('dd if=/dev/zero of=/dev/sda')).toBe(true));
  it('flags mkfs.ext4', () => expect(isDangerous('mkfs.ext4 /dev/sdb1')).toBe(true));
  it('does not flag safe rm', () => expect(isDangerous('rm -rf ./tmp')).toBe(false));
  it('does not flag normal commands', () => expect(isDangerous('ls -la')).toBe(false));
  it('does not flag git commands', () => expect(isDangerous('git commit -am "fix"')).toBe(false));
});

describe('beforeToolCall hook', () => {
  const payload = (command: string) => ({
    sessionId: 'test',
    toolName: 'terminal',
    args: { command },
  });

  it('returns null for safe commands', async () => {
    const result = await beforeToolCall(payload('ls -la'));
    expect(result).toBeNull();
  });

  it('returns error for dangerous commands', async () => {
    const result = await beforeToolCall(payload('rm -rf /'));
    expect(result).not.toBeNull();
    expect(result?.error).toBeDefined();
    expect(result?.error).toContain('safety-adapter');
  });

  it('returns null for non-terminal tools', async () => {
    const result = await beforeToolCall({
      sessionId: 'test',
      toolName: 'read_file',
      args: { path: '/etc/passwd' },
    });
    expect(result).toBeNull();
  });

  it('tracks blocked commands', async () => {
    await beforeToolCall(payload('rm -rf /'));
    await beforeToolCall(payload('shutdown -r now'));
    const blocked = getBlockedCommands();
    expect(blocked).toHaveLength(2);
    expect(blocked[0]).toContain('rm -rf /');
  });

  it('clears blocked commands on deactivate', async () => {
    await beforeToolCall(payload('rm -rf /'));
    deactivate();
    expect(getBlockedCommands()).toHaveLength(0);
  });
});
