// The secrets manifest is built from the VAULT, not from keys.json.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSecretsResolver, FsStorage, InMemorySecretsResolver } from '@ethosagent/storage-fs';
import type { SecretsResolver } from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSecretsManifest,
  injectSecrets,
  type PreparedSecrets,
  prepareSecretEntries,
  prepareSecrets,
} from '../secrets-manifest';

let dir: string;
let vault: FileSecretsResolver;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ethos-secrets-manifest-'));
  vault = new FileSecretsResolver({ dir: join(dir, 'secrets'), storage: new FsStorage() });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('buildSecretsManifest', () => {
  it('enumerates the real secrets/ vault, not keys.json', async () => {
    // keys.json is only the LLM key-rotation pool; a machine whose credentials
    // all live in the vault used to get an empty manifest and no warning.
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'keys.json'), '{"ROTATION_POOL_ONLY":"sk-x"}');
    await vault.set('ANTHROPIC_API_KEY', 'sk-live');
    await vault.set('TELEGRAM_BOT_TOKEN', '123:abc');

    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
      now: new Date('2026-09-04T10:00:00Z'),
    });

    expect(manifest).toContain('backed_up_at: 2026-09-04T10:00:00.000Z');
    expect(manifest).toContain('  - key: ANTHROPIC_API_KEY');
    expect(manifest).toContain(`    fill_with: ethos secrets set 'ANTHROPIC_API_KEY' <value>`);
    expect(manifest).toContain('  - key: TELEGRAM_BOT_TOKEN');
    expect(manifest).not.toContain('ROTATION_POOL_ONLY');
  });

  it('never writes a value', async () => {
    await vault.set('ANTHROPIC_API_KEY', 'sk-super-secret-value');
    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
    });
    expect(manifest).not.toContain('sk-super-secret-value');
  });

  it('groups personality-scoped refs under their personality', async () => {
    await vault.set('personalities/alice/GITHUB_TOKEN', 'ghs_x');
    await vault.set('personalities/alice/LINEAR_KEY', 'lin_x');
    await vault.set('personalities/bob/NOTION_KEY', 'nt_x');

    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
    });
    expect(manifest).toContain('  alice:\n    secrets:\n      - key: GITHUB_TOKEN');
    expect(manifest).toContain(
      `        fill_with: ethos secrets set 'personalities/alice/GITHUB_TOKEN' <value>`,
    );
    expect(manifest).toContain('  bob:');
    expect(manifest).toContain('      - key: NOTION_KEY');
  });

  it('records which personality/server had MCP tokens stripped', async () => {
    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map([['alice', new Set(['github', 'linear'])]]),
    });
    expect(manifest).toContain('    mcp_auth:');
    expect(manifest).toContain('      - server: github');
    expect(manifest).toContain(`        fill_with: ethos mcp auth 'github'`);
    expect(manifest).toContain('      - server: linear');
  });

  it('keeps refs it cannot group, verbatim, rather than dropping them', async () => {
    await vault.set('plugins/weather/API_KEY', 'wk_x');
    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
    });
    expect(manifest).toContain('other:');
    expect(manifest).toContain('  - key: plugins/weather/API_KEY');
  });

  // Every `fill_with:` line is a line an operator PASTES. The ref in it is a
  // filename in the vault, and nothing on the read path (`SecretsResolver.list`)
  // re-checks what is on disk — so an unquoted ref with a space breaks the
  // command, and one with `$(…)` or `;` runs something else entirely.
  describe('shell-quotes the paste lines', () => {
    /**
     * Decode ONE POSIX single-quoted argument back to its literal text, refusing
     * anything a shell would not read as a single word: a character outside the
     * quotes, an unterminated quote, or junk between two quoted runs. A ref that
     * survives this round trip cannot have broken out of the quoting.
     */
    const decodeSingleQuoted = (arg: string): string => {
      let text = '';
      let i = 0;
      while (i < arg.length) {
        if (arg[i] !== "'") throw new Error(`unquoted text at ${i}: ${arg}`);
        const close = arg.indexOf("'", i + 1);
        if (close < 0) throw new Error(`unterminated quote: ${arg}`);
        text += arg.slice(i + 1, close);
        i = close + 1;
        if (i < arg.length) {
          if (arg.slice(i, i + 2) !== "\\'") throw new Error(`junk between quotes: ${arg}`);
          text += "'";
          i += 2;
        }
      }
      return text;
    };

    const argsAfter = (manifest: string, prefix: string): string[] =>
      manifest
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.startsWith(prefix))
        .map((line) => line.slice(prefix.length));

    const setArgs = (manifest: string): string[] =>
      argsAfter(manifest, 'fill_with: ethos secrets set ').map((rest) =>
        rest.slice(0, rest.lastIndexOf(' <value>')),
      );

    const authArgs = (manifest: string): string[] =>
      argsAfter(manifest, 'fill_with: ethos mcp auth ');

    it('quotes a global ref so no metacharacter reaches the shell', async () => {
      const refs = ['HAS SPACE', 'HAS;semicolon', 'HAS$(id)SUB', "HAS'quote", 'HAS`backtick`'];
      const vault = new InMemorySecretsResolver();
      for (const ref of refs) await vault.set(ref, 'sk-must-never-print');

      const manifest = await buildSecretsManifest({
        secrets: vault,
        strippedMcpTokens: new Map(),
      });

      expect(manifest).toContain(`    fill_with: ethos secrets set 'HAS SPACE' <value>`);
      expect(manifest).toContain(`    fill_with: ethos secrets set 'HAS;semicolon' <value>`);
      expect(manifest).toContain(`    fill_with: ethos secrets set 'HAS$(id)SUB' <value>`);
      expect(manifest).toContain(`    fill_with: ethos secrets set 'HAS'\\''quote' <value>`);
      // Nothing lives outside the quotes, and what is inside is the ref itself.
      expect(setArgs(manifest).map(decodeSingleQuoted).sort()).toEqual([...refs].sort());
      expect(manifest).not.toContain('sk-must-never-print');
    });

    it('quotes a personality-scoped ref, embedded single quote included', async () => {
      const vault = new InMemorySecretsResolver();
      await vault.set("personalities/alice/HAS'quote", 'sk-must-never-print');
      await vault.set('personalities/alice/HAS $(id);X', 'sk-must-never-print');

      const manifest = await buildSecretsManifest({
        secrets: vault,
        strippedMcpTokens: new Map(),
      });

      expect(manifest).toContain(
        `        fill_with: ethos secrets set 'personalities/alice/HAS'\\''quote' <value>`,
      );
      expect(manifest).toContain(
        `        fill_with: ethos secrets set 'personalities/alice/HAS $(id);X' <value>`,
      );
      expect(setArgs(manifest).map(decodeSingleQuoted).sort()).toEqual([
        'personalities/alice/HAS $(id);X',
        "personalities/alice/HAS'quote",
      ]);
      expect(manifest).not.toContain('sk-must-never-print');
    });

    it('quotes an ungrouped `other:` ref', async () => {
      const vault = new InMemorySecretsResolver();
      await vault.set('teams/atlas/A B;$(id)', 'sk-must-never-print');

      const manifest = await buildSecretsManifest({
        secrets: vault,
        strippedMcpTokens: new Map(),
      });

      expect(manifest).toContain('other:');
      expect(manifest).toContain(
        `    fill_with: ethos secrets set 'teams/atlas/A B;$(id)' <value>`,
      );
      expect(setArgs(manifest).map(decodeSingleQuoted)).toEqual(['teams/atlas/A B;$(id)']);
      expect(manifest).not.toContain('sk-must-never-print');
    });

    // Server names come from the MCP token DIRECTORY names — same story as a
    // vault filename: whatever is on disk, never re-checked.
    it('quotes an mcp auth server name', async () => {
      const servers = ['git hub', 'a;rm -rf ~', '$(id)', "o'brien"];
      const manifest = await buildSecretsManifest({
        secrets: new InMemorySecretsResolver(),
        strippedMcpTokens: new Map([['alice', new Set(servers)]]),
      });

      expect(manifest).toContain(`        fill_with: ethos mcp auth 'git hub'`);
      expect(manifest).toContain(`        fill_with: ethos mcp auth 'a;rm -rf ~'`);
      expect(manifest).toContain(`        fill_with: ethos mcp auth '$(id)'`);
      expect(manifest).toContain(`        fill_with: ethos mcp auth 'o'\\''brien'`);
      expect(authArgs(manifest).map(decodeSingleQuoted).sort()).toEqual([...servers].sort());
    });

    // The `- key:` / `- server:` fields are DATA the importer parses back and
    // matches against the refs `injectSecrets` reports. Quoting those would
    // change the ref. Only the command line is quoted.
    it('leaves the `- key:` and `- server:` fields themselves unquoted', async () => {
      const vault = new InMemorySecretsResolver();
      await vault.set('HAS SPACE', 'sk-must-never-print');
      await vault.set('personalities/alice/HAS SPACE', 'sk-must-never-print');

      const manifest = await buildSecretsManifest({
        secrets: vault,
        strippedMcpTokens: new Map([['alice', new Set(['git hub'])]]),
      });

      expect(manifest).toContain('  - key: HAS SPACE');
      expect(manifest).toContain('      - key: HAS SPACE');
      expect(manifest).toContain('      - server: git hub');
    });
  });

  it('is stable across two backups of an unchanged vault', async () => {
    await vault.set('B_KEY', 'b');
    await vault.set('A_KEY', 'a');
    const now = new Date('2026-09-04T10:00:00Z');
    const first = await buildSecretsManifest({ secrets: vault, strippedMcpTokens: new Map(), now });
    const second = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
      now,
    });
    expect(first).toBe(second);
    expect(first.indexOf('A_KEY')).toBeLessThan(first.indexOf('B_KEY'));
  });
});

/** Prepare, asserting success — the fixture for every write-path test below. */
function prepareOk(raw: string): PreparedSecrets {
  const result = prepareSecrets(raw);
  if (!result.ok) throw new Error(`expected a preparable manifest, got: ${result.error}`);
  return result.prepared;
}

describe('prepareSecrets', () => {
  it('validates every composed ref without touching the vault', async () => {
    const secrets = new InMemorySecretsResolver();
    const result = prepareSecrets(
      'global:\n  GOOD_KEY: sk-good\n  BAD\\KEY: sk-must-never-print\n',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedRef).toBe('BAD\\KEY');
    expect(result.error).toContain('backslashes');
    expect(result.error).not.toContain('sk-must-never-print');
    // The valid entry AHEAD of the bad one is not in the vault either: this
    // step writes nothing at all, so there is no half-applied manifest.
    expect(await secrets.get('GOOD_KEY')).toBeNull();
  });

  it('refuses a personality id that would escape its namespace', () => {
    const result = prepareSecrets('personalities:\n  ..:\n    K: v\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.failedRef).toBe('personalities/../K');
    expect(result.error).toContain('".."');
  });

  it('reports an empty manifest as nothing to write, not as an error', () => {
    // A section the parser does not read, and a section with no value in it:
    // both prepare cleanly and both would inject nothing, which is what the
    // caller checks before it does anything destructive.
    expect(prepareOk('other:\n  plugins/x/KEY: v\n')).toEqual([]);
    expect(prepareOk('global:\n  # nothing here\n')).toEqual([]);
    expect(prepareOk('')).toEqual([]);
  });
});

describe('injectSecrets', () => {
  it('writes global and personality-scoped values into the vault', async () => {
    const secrets = new InMemorySecretsResolver();
    const result = await injectSecrets(
      prepareOk(
        [
          '# filled in by the operator',
          'global:',
          '  ANTHROPIC_API_KEY: sk-new',
          'personalities:',
          '  alice:',
          '    GITHUB_TOKEN: "ghs_new"',
          '',
        ].join('\n'),
      ),
      secrets,
    );

    expect(result.writtenRefs).toEqual(['ANTHROPIC_API_KEY', 'personalities/alice/GITHUB_TOKEN']);
    expect(result.error).toBeUndefined();
    expect(await secrets.get('ANTHROPIC_API_KEY')).toBe('sk-new');
    expect(await secrets.get('personalities/alice/GITHUB_TOKEN')).toBe('ghs_new');
  });

  it('skips a blank value so a half-filled template cannot blank a good secret', async () => {
    const secrets = new InMemorySecretsResolver();
    await secrets.set('ANTHROPIC_API_KEY', 'sk-existing');
    const result = await injectSecrets(prepareOk('global:\n  ANTHROPIC_API_KEY:\n'), secrets);
    expect(result.writtenRefs).toEqual([]);
    expect(result.error).toBeUndefined();
    expect(await secrets.get('ANTHROPIC_API_KEY')).toBe('sk-existing');
  });

  it('ignores sections it does not understand', async () => {
    const secrets = new InMemorySecretsResolver();
    const result = await injectSecrets(prepareOk('other:\n  plugins/x/KEY: v\n'), secrets);
    expect(result.writtenRefs).toEqual([]);
    expect(result.error).toBeUndefined();
  });

  it('reports a write that fails AFTER earlier ones as partial, not as nothing', async () => {
    // Not every refusal is a ref preparation can pre-check — a real vault can
    // fail on the filesystem mid-run. What landed must still be named.
    const inner = new InMemorySecretsResolver();
    const secrets: SecretsResolver = {
      get: (ref) => inner.get(ref),
      delete: (ref) => inner.delete(ref),
      list: (prefix) => inner.list(prefix),
      set: async (ref, value) => {
        if (ref === 'personalities/alice/BOOM') throw new Error(`EACCES: cannot write ${ref}`);
        await inner.set(ref, value);
      },
    };

    const result = await injectSecrets(
      prepareOk(
        [
          'global:',
          '  FIRST_KEY: sk-landed',
          'personalities:',
          '  alice:',
          '    BOOM: sk-must-never-print',
          '    NEVER_REACHED: sk-also-never',
          '',
        ].join('\n'),
      ),
      secrets,
    );

    expect(result.writtenRefs).toEqual(['FIRST_KEY']);
    expect(result.failedRef).toBe('personalities/alice/BOOM');
    expect(result.error).toContain('EACCES');
    expect(JSON.stringify(result)).not.toContain('sk-');
    // The half that DID land is really in the vault — the point of the report.
    expect(await inner.get('FIRST_KEY')).toBe('sk-landed');
    expect(await inner.get('personalities/alice/NEVER_REACHED')).toBeNull();
  });

  it('redacts the value out of a resolver error that puts it in the message', async () => {
    // `SecretsResolver` is an interface with third-party implementations (the
    // AWS Secrets Manager path is one). Nothing stops a foreign `set()` from
    // quoting the rejected value back in its exception — and this `error` is
    // printed by the CLI and serialised into `--json`. The promise that no
    // value reaches output has to be ENFORCED here, not asked for.
    const secrets: SecretsResolver = {
      get: async () => null,
      delete: async () => {},
      list: async () => [],
      set: async (ref, value) => {
        throw new Error(`EACCES: refused to store "${value}" at ${ref} (value "${value}" again)`);
      },
    };

    const result = await injectSecrets(
      prepareOk('global:\n  API_KEY: sk-leaked-by-resolver\n'),
      secrets,
    );

    expect(result.writtenRefs).toEqual([]);
    expect(result.failedRef).toBe('API_KEY');
    expect(result.error).not.toContain('sk-leaked-by-resolver');
    expect(JSON.stringify(result)).not.toContain('sk-');
    // Both occurrences, not just the first.
    expect(result.error).toBe(
      'EACCES: refused to store "[value redacted]" at API_KEY (value "[value redacted]" again)',
    );
    // The errno survives: EACCES and ENOSPC are different problems with
    // different fixes, and the operator is the one who has to tell them apart.
    expect(result.error).toContain('EACCES');
    expect(result.error).toContain('API_KEY');
  });

  it('redacts a thrown non-Error too', async () => {
    const secrets: SecretsResolver = {
      get: async () => null,
      delete: async () => {},
      list: async () => [],
      set: async (_ref, value) => {
        // Not every resolver throws an Error; `String(err)` is the other branch
        // and it carries a value just as happily.
        throw { toString: () => `vault rejected ${value}` };
      },
    };

    const result = await injectSecrets(
      prepareOk('global:\n  API_KEY: sk-thrown-string\n'),
      secrets,
    );
    expect(result.error).toBe('vault rejected [value redacted]');
    expect(JSON.stringify(result)).not.toContain('sk-');
  });
});

describe('PreparedSecrets is unforgeable', () => {
  it('cannot be hand-built and handed to injectSecrets', () => {
    // The whole point of `prepareSecrets` is that every ref reaching the vault
    // was validated. A caller able to assemble this array directly would skip
    // that — `personalities/../ESCAPE` is exactly the ref the preparer refuses.
    const forged = [{ ref: 'personalities/../ESCAPE', key: 'ESCAPE', value: 'sk-forged' }];

    // Declared and deliberately NEVER invoked: what is under test is that these
    // do not COMPILE. The brand makes both a type error (TS2345 / TS2352,
    // "Property '[preparedSecretsBrand]' is missing"), and `@ts-expect-error`
    // fails `pnpm typecheck` the moment either one starts being accepted —
    // which is what turns the invariant from a comment into a guarantee.
    const passPlainArray = (secrets: SecretsResolver) =>
      // @ts-expect-error a plain array is not a PreparedSecrets
      injectSecrets(forged, secrets);
    const passCastArray = (secrets: SecretsResolver) =>
      // @ts-expect-error not even a direct cast — the two types do not overlap
      injectSecrets(forged as PreparedSecrets, secrets);

    expect(typeof passPlainArray).toBe('function');
    expect(typeof passCastArray).toBe('function');

    // And the one sanctioned route refuses that ref outright.
    expect(prepareSecrets('personalities:\n  ..:\n    ESCAPE: sk-forged\n').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A newline is not a shell problem — it is a FORMAT problem
// ---------------------------------------------------------------------------
//
// Single-quoting an argument stops a metacharacter breaking out within a line
// and does nothing whatever about a newline, which does not break out of the
// shell at all: it breaks out of this manifest. A ref carrying one writes NEW
// lines — a second `fill_with:` the operator is told to paste, a second
// `- key:` the importer parses back as data — and `SecretsResolver.list()`
// really can return one, because Unix permits a newline in a filename and
// `FileSecretsResolver` does not reject one in a ref.
describe('buildSecretsManifest refuses a name that would split the manifest', () => {
  /**
   * Everything that is NOT a comment. The refusal notice names the refused
   * string (escaped, on one line) on purpose, so a bare `toContain` would see
   * it; what must not exist is a forged line the PARSERS would read.
   */
  const dataLines = (manifest: string): string =>
    manifest
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#'))
      .join('\n');

  /** Every line the manifest actually claims is an entry. */
  const keyLines = (manifest: string): string[] =>
    manifest
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- key:') || l.startsWith('- server:'));

  /** No raw control character survives anywhere — `\n` is the only one left. */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: finding them is the point
  const RAW_CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f]/;

  it('leaves out a global ref whose newline would forge a second entry', async () => {
    const vault = new InMemorySecretsResolver();
    await vault.set('CLEAN_KEY', 'sk-must-never-print');
    await vault.set('EVIL\n  - key: PWNED', 'sk-must-never-print');

    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
    });

    // The forged entry is nowhere: not as a key line, not anywhere at all.
    expect(dataLines(manifest)).not.toContain('PWNED');
    expect(keyLines(manifest)).toEqual(['- key: CLEAN_KEY']);
    expect(manifest).not.toMatch(RAW_CONTROL);
    // Refused loudly, with the offending name escaped onto ONE line.
    expect(manifest).toContain('# ⚠ 1 name(s) LEFT OUT of this manifest');
    expect(manifest).toContain('#     "EVIL\\u000a  - key: PWNED"');
    expect(manifest).not.toContain('sk-must-never-print');
  });

  it('leaves out a personality-scoped ref with a carriage return', async () => {
    const vault = new InMemorySecretsResolver();
    await vault.set('personalities/alice/GOOD', 'sk-must-never-print');
    await vault.set('personalities/alice/BAD\r  - key: PWNED', 'sk-must-never-print');

    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
    });

    expect(dataLines(manifest)).not.toContain('PWNED');
    expect(keyLines(manifest)).toEqual(['- key: GOOD']);
    expect(manifest).not.toMatch(RAW_CONTROL);
    expect(manifest).toContain('#     "personalities/alice/BAD\\u000d  - key: PWNED"');
  });

  it('leaves out an ungrouped `other:` ref that carries a newline', async () => {
    const vault = new InMemorySecretsResolver();
    await vault.set('teams/atlas/EVIL\n  - key: PWNED', 'sk-must-never-print');

    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
    });

    expect(dataLines(manifest)).not.toContain('PWNED');
    expect(manifest).not.toContain('other:');
    expect(keyLines(manifest)).toEqual([]);
    expect(manifest).not.toMatch(RAW_CONTROL);
  });

  // MCP server names are DIRECTORY names — the same story as a vault filename.
  it('leaves out an mcp server directory name that carries a newline', async () => {
    const manifest = await buildSecretsManifest({
      secrets: new InMemorySecretsResolver(),
      strippedMcpTokens: new Map([['alice', new Set(['github', 'evil\n      - server: PWNED'])]]),
    });

    expect(dataLines(manifest)).not.toContain('PWNED');
    expect(keyLines(manifest)).toEqual(['- server: github']);
    expect(manifest).not.toMatch(RAW_CONTROL);
    expect(manifest).toContain('#     "evil\\u000a      - server: PWNED"');
  });

  // A hostile id would split the `  <id>:` header AND every ref composed under
  // it, so the whole group goes rather than the servers one at a time.
  it('leaves out a whole personality group whose id carries a newline', async () => {
    const manifest = await buildSecretsManifest({
      secrets: new InMemorySecretsResolver(),
      strippedMcpTokens: new Map([['alice\n  evil:', new Set(['github'])]]),
    });

    expect(keyLines(manifest)).toEqual([]);
    expect(manifest).not.toContain('- server: github');
    expect(manifest).not.toMatch(RAW_CONTROL);
    expect(manifest).toContain('#     "personalities/alice\\u000a  evil:"');
  });

  // Both readers of this file skip `#`, so the notice is read by the operator
  // and by nothing that parses.
  it('writes the notice as comment lines the parsers ignore', async () => {
    const vault = new InMemorySecretsResolver();
    await vault.set('EVIL\nglobal:\n  PWNED: sk-forged', 'sk-must-never-print');

    const manifest = await buildSecretsManifest({
      secrets: vault,
      strippedMcpTokens: new Map(),
    });

    for (const line of manifest.split('\n')) {
      if (line.includes('EVIL')) expect(line.trimStart().startsWith('#')).toBe(true);
    }
    // Nothing injectable came out of a manifest built from a hostile vault.
    const prepared = prepareSecrets(manifest);
    expect(prepared.ok).toBe(true);
    if (prepared.ok) expect(prepared.prepared).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The second entry point: structured pairs, no text in between
// ---------------------------------------------------------------------------
describe('prepareSecretEntries', () => {
  it('writes a key containing a colon to the ref it names, not to a prefix of it', () => {
    // The bug this replaces: the caller serialised `TOK:EN: "v"` so that
    // `prepareSecrets` could split it at the FIRST colon, landing the value
    // under `TOK` with `EN: "v"` as its contents — and reporting success.
    const result = prepareSecretEntries([
      { key: 'TOK:EN', value: 'sk-must-never-print' },
      { personality: 'alice', key: 'A:B:C', value: 'sk-must-never-print' },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.prepared.map((w) => w.ref)).toEqual(['TOK:EN', 'personalities/alice/A:B:C']);
    expect(result.prepared.map((w) => w.key)).toEqual(['TOK:EN', 'A:B:C']);
    expect(JSON.stringify(result.prepared.map((w) => w.ref))).not.toContain('sk-');
  });

  it('refuses a key carrying a newline rather than writing a newline-named ref', () => {
    const result = prepareSecretEntries([{ key: 'A\nB', value: 'sk-must-never-print' }]);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('control characters');
    // The message goes to a terminal: the raw ref is escaped, not interpolated.
    expect(result.error).not.toContain('\n');
    expect(result.error).toContain('\\u000a');
    expect(result.error).not.toContain('sk-must-never-print');
  });

  it('refuses a carriage return in a key the same way', () => {
    const result = prepareSecretEntries([
      { personality: 'alice', key: 'A\rB', value: 'sk-must-never-print' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failedRef).toBe('personalities/alice/A\rB');
  });

  it('holds a structured entry to every rule a manifest-text entry is held to', () => {
    // Same refusal, same message, whichever door it came in by.
    const viaText = prepareSecrets('personalities:\n  ..:\n    ESCAPE: v\n');
    const viaEntries = prepareSecretEntries([{ personality: '..', key: 'ESCAPE', value: 'v' }]);
    expect(viaText.ok).toBe(false);
    expect(viaEntries.ok).toBe(false);
    if (viaText.ok || viaEntries.ok) return;
    expect(viaEntries.error).toBe(viaText.error);
    expect(viaEntries.failedRef).toBe(viaText.failedRef);
  });

  it('is the same branded value injectSecrets accepts', async () => {
    const target = new InMemorySecretsResolver();
    const result = prepareSecretEntries([
      { key: 'TOK:EN', value: '  padded value  ' },
      { personality: 'alice', key: 'GITHUB_TOKEN', value: 'sk-landed' },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const written = await injectSecrets(result.prepared, target);
    expect(written.error).toBeUndefined();
    expect(written.writtenRefs).toEqual(['TOK:EN', 'personalities/alice/GITHUB_TOKEN']);
    // Whitespace survives because nothing re-read the value out of a format.
    expect(await target.get('TOK:EN')).toBe('  padded value  ');
    expect(JSON.stringify(written)).not.toContain('sk-');
  });
});
