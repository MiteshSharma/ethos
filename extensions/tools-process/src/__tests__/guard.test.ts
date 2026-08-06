import { describe, expect, it } from 'vitest';
import { checkCommand, createProcessGuardHook } from '../guard';

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
      'npm run start',
      'python server.py --port 8080',
      'node ./scripts/worker.js',
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

  describe('SSH key destruction — should be blocked', () => {
    it.each(['rm -rf ~/.ssh', 'rm -rf ~/.ssh/known_hosts', 'rm ~/.ssh/id_rsa'])(
      'blocks: %s',
      (cmd) => {
        const result = checkCommand(cmd);
        expect(result.dangerous).toBe(true);
        if (result.dangerous) expect(result.reason).toMatch(/SSH key/);
      },
    );
  });

  describe('GPG secret deletion — should be blocked', () => {
    it.each(['gpg --delete-secret-keys 1234', 'gpg --delete-secret-key 1234'])(
      'blocks: %s',
      (cmd) => {
        const result = checkCommand(cmd);
        expect(result.dangerous).toBe(true);
        if (result.dangerous) expect(result.reason).toMatch(/GPG/);
      },
    );
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

  describe('privilege escalation — should be blocked', () => {
    it.each([
      ['chmod 4755 /tmp/sneaky', /setuid/],
      ['chmod u+s /tmp/binary', /setuid/],
      ['chmod g+s /tmp/binary', /setuid/],
      ['setcap cap_net_raw+ep /usr/bin/foo', /setcap/],
    ])('blocks: %s', (cmd, expectedReason) => {
      const result = checkCommand(cmd);
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(expectedReason);
    });

    it('does not flag chmod 755 or chmod +x', () => {
      expect(checkCommand('chmod 755 script.sh').dangerous).toBe(false);
      expect(checkCommand('chmod +x script.sh').dangerous).toBe(false);
    });
  });

  describe('system auth / kernel writes — should be blocked', () => {
    it.each([
      ['echo whatever > /etc/sudoers', /system auth file/],
      ['cat /tmp/x > /etc/passwd', /system auth file/],
      ['echo bad > /etc/shadow', /system auth file/],
      ['echo malicious > /boot/grub.cfg', /kernel\/boot/],
      ['echo 1 > /sys/kernel/debug/foo', /kernel\/boot/],
      ['echo "key" > ~/.ssh/authorized_keys', /authorized_keys/],
    ])('blocks: %s', (cmd, expectedReason) => {
      const result = checkCommand(cmd);
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(expectedReason);
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

  describe('find / -delete — should be blocked', () => {
    it('blocks find / -delete', () => {
      const result = checkCommand('find / -name foo -delete');
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(/find-and-delete/);
    });
  });

  // Credential path reads — argv fs-path floor (defense-in-depth on top of
  // ScopedStorage always-deny). Catches lazy literal-path attacks; obfuscation
  // (variable indirection, substitution, eval) is NOT the target.
  describe('credential path reads — should be flagged', () => {
    it.each([
      ['cat ~/.ssh/id_rsa', /\.ssh/],
      ['less ~/.ssh/id_ed25519', /\.ssh/],
      ['head /home/u/.ssh/authorized_keys', /\.ssh/],
      ['cat ~/.aws/credentials', /\.aws/],
      ['cat /home/u/.aws/credentials', /\.aws/],
      ['ls ~/.gnupg/', /\.gnupg/],
      ['cat ~/.netrc', /\.netrc/],
      ['cat /etc/passwd', /\/etc\//],
      ['cat /etc/shadow', /\/etc\//],
      ['less /etc/sudoers', /\/etc\//],
      ['head ~/.bash_history', /history/],
      ['cat ~/.zsh_history', /history/],
      ['cat ~/.psql_history', /history/],
      ['cat ~/.mysql_history', /history/],
    ])('blocks: %s', (cmd, expectedPath) => {
      const result = checkCommand(cmd);
      expect(result.dangerous).toBe(true);
      if (result.dangerous) expect(result.reason).toMatch(expectedPath);
    });

    it.each([
      'cat .ssh-config-template.md', // benign filename containing .ssh
      'cat /tmp/aws-credentials.example.json', // not the literal ~/.aws/credentials
      'echo aws/credentials/template', // no path separator before
      'cat /etc/passwords.json', // not /etc/passwd
      'cat .bash_history.example', // not the literal history file
    ])('does not flag: %s', (cmd) => {
      expect(checkCommand(cmd).dangerous).toBe(false);
    });
  });

  // Edge cases — multi-line, whitespace, chaining. These document what the
  // pattern set catches and what it doesn't. Regex against raw shell is a v1
  // floor, not a boundary: obfuscation (variable indirection, $(...) wrapping
  // that breaks the rm path-suffix regex, base64 indirection, eval) is NOT
  // the target and is documented as out of scope in the guard header.
  describe('edge cases', () => {
    it('blocks dangerous command across multi-line input', () => {
      // \nrm -rf /\n → the rm path-suffix regex matches because the path is
      // followed by whitespace (a newline counts).
      expect(checkCommand('echo start\nrm -rf /\necho end').dangerous).toBe(true);
    });

    it('blocks with leading whitespace', () => {
      expect(checkCommand('   rm -rf /').dangerous).toBe(true);
    });

    it('blocks chained dangerous command via &&', () => {
      // `rm -rf /` followed by EOS matches the regex's `\/\s*$` arm.
      expect(checkCommand('echo hi && rm -rf /').dangerous).toBe(true);
    });

    it('blocks chained dangerous command via ;', () => {
      expect(checkCommand('echo hi; rm -rf /').dangerous).toBe(true);
    });

    it('does NOT catch rm -rf / wrapped in $(...) — documented gap', () => {
      // `$(rm -rf /)` ends the path with `)` which the path-suffix regex
      // does not treat as a terminator. This is an honest gap: the regex
      // floor catches literal forms; obfuscation/wrapping is intentionally
      // out of scope. ScopedStorage + sandbox attestation are the real
      // boundary; this test pins the gap so future regex changes are
      // intentional.
      expect(checkCommand('echo $(rm -rf /)').dangerous).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// createProcessGuardHook
// ---------------------------------------------------------------------------

describe('createProcessGuardHook', () => {
  const hook = createProcessGuardHook();

  it('returns null for non-process_start tools (terminal)', async () => {
    // The hook must be a no-op for tools other than process_start. The
    // terminal tool has its own guard; the process guard must not interfere
    // with it (and vice versa). This is the tool-name gate.
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'terminal',
      args: { command: 'rm -rf /' },
    });
    expect(result).toBeNull();
  });

  it('returns null for non-process_start tools (web_search)', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'web_search',
      args: { query: 'hello' },
    });
    expect(result).toBeNull();
  });

  it('returns null for non-process_start tools (process_list)', async () => {
    // Sibling tools in the same toolset must not trip the guard either.
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_list',
      args: {},
    });
    expect(result).toBeNull();
  });

  it('returns null for safe process_start commands', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_start',
      args: { command: 'python server.py' },
    });
    expect(result).toBeNull();
  });

  it('returns error for dangerous process_start command', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_start',
      args: { command: 'rm -rf /' },
    });
    expect(result).not.toBeNull();
    expect(result?.error).toMatch(/Command blocked/);
    expect(result?.error).toMatch(/recursive force-delete/);
  });

  it('returns error for setuid escalation via process_start', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_start',
      args: { command: 'chmod u+s /tmp/binary' },
    });
    expect(result).not.toBeNull();
    expect(result?.error).toMatch(/setuid/);
  });

  it('returns error for credential read via process_start', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_start',
      args: { command: 'cat ~/.ssh/id_rsa' },
    });
    expect(result).not.toBeNull();
    expect(result?.error).toMatch(/\.ssh/);
  });

  it('returns null when command arg is missing', async () => {
    const result = await hook({
      sessionId: 's1',
      toolCallId: 'tc_1',
      toolName: 'process_start',
      args: {},
    });
    expect(result).toBeNull();
  });
});
