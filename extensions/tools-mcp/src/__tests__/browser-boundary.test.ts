import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// This package is Node-only — stdio transports spawn child processes. The
// preset catalog it owns reaches the browser over the `mcp.catalog` oRPC
// method, never by import. If `apps/web` ever imports it directly the SPA
// build breaks, so the boundary is asserted here rather than discovered
// at bundle time.

const ROOT = resolve(join(import.meta.dirname, '..', '..', '..', '..'));
const WEB_SRC = join(ROOT, 'apps/web/src');

/**
 * Matches the package only where it is an actual module specifier: after
 * `from`, after a static or dynamic `import`, or inside `require(...)`, and
 * always quote-delimited. Subpaths (`@ethosagent/tools-mcp/foo`) count.
 *
 * Deliberately NOT a raw text search — prose naming the package (this rule is
 * documented in `apps/web` comments) is not an import, and failing on it just
 * pushes people into writing worse comments. A regex is proportionate here; a
 * TypeScript AST parse would be a dependency for one assertion.
 */
const IMPORT_SPECIFIER =
  /(?:\bfrom\b|\bimport\b|\brequire\b)\s*\(?\s*(['"])@ethosagent\/tools-mcp(?:\/[^'"]*)?\1/;

function importsToolsMcp(source: string): boolean {
  return IMPORT_SPECIFIER.test(source);
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return filesUnder(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

describe('@ethosagent/tools-mcp stays out of the browser bundle', () => {
  it('is not imported anywhere under apps/web/src', () => {
    expect(existsSync(WEB_SRC)).toBe(true);
    const offenders = filesUnder(WEB_SRC)
      .filter((file) => importsToolsMcp(readFileSync(file, 'utf-8')))
      .map((file) => relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('is not a declared dependency of apps/web', () => {
    // The source scan above only sees specifiers written in `apps/web/src`.
    // This is the check that catches the indirect paths — the package arriving
    // through a re-export from another workspace package, or a bundler
    // resolving it because it is on the dependency graph at all.
    const pkg = readFileSync(join(ROOT, 'apps/web/package.json'), 'utf-8');
    expect(pkg).not.toContain('@ethosagent/tools-mcp');
  });

  it('flags real import forms, including subpaths', () => {
    expect(importsToolsMcp(`import { MCP_REMOTE_PRESETS } from '@ethosagent/tools-mcp';`)).toBe(
      true,
    );
    expect(importsToolsMcp(`import type { McpPreset } from "@ethosagent/tools-mcp";`)).toBe(true);
    expect(importsToolsMcp(`import '@ethosagent/tools-mcp';`)).toBe(true);
    expect(importsToolsMcp(`const m = await import('@ethosagent/tools-mcp/presets');`)).toBe(true);
    expect(importsToolsMcp(`const m = require('@ethosagent/tools-mcp');`)).toBe(true);
    expect(importsToolsMcp(`export { MCP_REMOTE_PRESETS } from '@ethosagent/tools-mcp';`)).toBe(
      true,
    );
  });

  it('ignores a comment that merely names the package', () => {
    expect(
      importsToolsMcp(
        `// The catalog is served over \`rpc.mcp.catalog\`, never imported: the\n` +
          `// preset data lives in \`@ethosagent/tools-mcp\`, a Node-only package.\n`,
      ),
    ).toBe(false);
  });
});
