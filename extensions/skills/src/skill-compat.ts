import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

// ---------------------------------------------------------------------------
// OpenClaw (and clawdbot/clawdis) skill metadata schema. All three keys are
// accepted as aliases; the first one present wins.
// ---------------------------------------------------------------------------

export interface OpenClawMeta {
  requires?: {
    env?: string[];
    bins?: string[];
    anyBins?: string[];
  };
  always?: boolean;
  os?: string[];
}

export interface ParsedFrontmatter {
  /** Frontmatter with `metadata` and other fields stripped to a generic record. */
  raw: Record<string, unknown>;
  /** Resolved OpenClaw block (under `metadata.{openclaw|clawdbot|clawdis}`), if any. */
  openclaw: OpenClawMeta | null;
  /** Markdown body with the frontmatter block removed. */
  body: string;
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const META_KEYS = ['openclaw', 'clawdbot', 'clawdis'] as const;

const OS_ALIASES: Record<string, string> = {
  macos: 'darwin',
  darwin: 'darwin',
  linux: 'linux',
  win32: 'win32',
  windows: 'win32',
  freebsd: 'freebsd',
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a SKILL.md or skill markdown file. Returns null if no frontmatter.
 * The parser handles the YAML subset OpenClaw skills actually use:
 *   - top-level scalar fields
 *   - inline arrays `[a, b, c]`
 *   - nested maps under `metadata.{openclaw|clawdbot|clawdis}.requires.{env|bins|anyBins}`
 */
export function parseSkillFrontmatter(md: string): ParsedFrontmatter | null {
  const match = md.match(FRONTMATTER_RE);
  if (!match) return null;

  const yaml = match[1];
  const body = md.slice(match[0].length);
  const raw = parseYaml(yaml);

  const metadata = raw.metadata;
  let openclaw: OpenClawMeta | null = null;
  if (isRecord(metadata)) {
    for (const key of META_KEYS) {
      const block = metadata[key];
      if (isRecord(block)) {
        openclaw = normalizeOpenClaw(block);
        break;
      }
    }
  }

  return { raw, openclaw, body };
}

/**
 * Decide whether a skill should be injected based on its OpenClaw metadata
 * and the current process environment.
 */
export function shouldInject(
  meta: OpenClawMeta | null,
  ctx: ShouldInjectContext = {},
): { inject: boolean; reason?: string } {
  if (!meta) return { inject: true };

  const env = ctx.env ?? process.env;
  const platform = ctx.platform ?? process.platform;

  if (meta.os && meta.os.length > 0) {
    const allowed = meta.os.map((o) => OS_ALIASES[o.toLowerCase()] ?? o.toLowerCase());
    if (!allowed.includes(platform)) {
      return { inject: false, reason: `os mismatch (need ${allowed.join('/')}, on ${platform})` };
    }
  }

  const req = meta.requires;
  if (req) {
    if (req.env && req.env.length > 0) {
      const missing = req.env.filter((name) => !env[name]);
      if (missing.length > 0) {
        return { inject: false, reason: `missing env ${missing.join(', ')}` };
      }
    }

    if (req.bins && req.bins.length > 0) {
      const found = req.bins.find((bin) => hasBinary(bin));
      if (!found) {
        return { inject: false, reason: `missing bins ${req.bins.join(', ')}` };
      }
    }

    if (req.anyBins && req.anyBins.length > 0) {
      const found = req.anyBins.find((bin) => hasBinary(bin));
      if (!found) {
        return { inject: false, reason: `missing anyBins ${req.anyBins.join(', ')}` };
      }
    }
  }

  return { inject: true };
}

/**
 * Replace OpenClaw-style template variables in skill content.
 * Currently supported: ${ETHOS_SKILL_DIR}, ${ETHOS_SESSION_ID}.
 */
export function applySubstitutions(content: string, skillDir: string, sessionId: string): string {
  return content
    .replaceAll('${ETHOS_SKILL_DIR}', skillDir)
    .replaceAll('${ETHOS_SESSION_ID}', sessionId);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

export interface ShouldInjectContext {
  env?: NodeJS.ProcessEnv;
  platform?: string;
}

function normalizeOpenClaw(block: Record<string, unknown>): OpenClawMeta {
  const out: OpenClawMeta = {};
  if (typeof block.always === 'boolean') out.always = block.always;
  if (Array.isArray(block.os)) out.os = block.os.filter((v): v is string => typeof v === 'string');

  if (isRecord(block.requires)) {
    const requires: NonNullable<OpenClawMeta['requires']> = {};
    if (Array.isArray(block.requires.env)) {
      requires.env = block.requires.env.filter((v): v is string => typeof v === 'string');
    }
    if (Array.isArray(block.requires.bins)) {
      requires.bins = block.requires.bins.filter((v): v is string => typeof v === 'string');
    }
    if (Array.isArray(block.requires.anyBins)) {
      requires.anyBins = block.requires.anyBins.filter((v): v is string => typeof v === 'string');
    }
    out.requires = requires;
  }

  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// PATH-walking binary check. Avoids spawning `which`/`where` so it stays sync
// and side-effect-free; works on Windows by trying common executable extensions.
function hasBinary(name: string): boolean {
  const path = process.env.PATH ?? '';
  if (!path) return false;
  const dirs = path.split(delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').map((e) => e.toLowerCase())
      : [''];

  for (const dir of dirs) {
    for (const ext of exts) {
      try {
        const candidate = join(dir, name + ext);
        const s = statSync(candidate);
        if (s.isFile()) return true;
      } catch {
        // not present — try next
      }
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Minimal YAML parser — handles the OpenClaw frontmatter subset:
//   key: value
//   key: "quoted value"
//   key: [a, b, c]
//   nested:
//     key: value
//   list:
//     - a
//     - b
// Indentation is by 2 spaces. Comments (lines starting with `#`) are ignored.
// ---------------------------------------------------------------------------

interface Frame {
  indent: number;
  value: Record<string, unknown> | unknown[];
}

function parseYaml(src: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, value: root }];

  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i] ?? '';
    if (!rawLine.trim() || rawLine.trim().startsWith('#')) continue;

    const indent = rawLine.match(/^ */)?.[0].length ?? 0;
    const line = rawLine.slice(indent).replace(/\s+#.*$/, '');

    while (stack.length > 1 && (stack[stack.length - 1]?.indent ?? -1) >= indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1]?.value;
    if (!parent) continue;

    if (line.startsWith('- ')) {
      if (!Array.isArray(parent)) continue;
      parent.push(parseScalar(line.slice(2).trim()));
      continue;
    }

    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const rest = line.slice(colon + 1).trim();

    if (Array.isArray(parent)) continue;

    if (rest === '') {
      // Look ahead to decide whether the child is a list or a map.
      const next = nextNonBlank(lines, i + 1);
      if (next?.text.trimStart().startsWith('- ') && next.indent > indent) {
        const list: unknown[] = [];
        parent[key] = list;
        stack.push({ indent, value: list });
      } else {
        const obj: Record<string, unknown> = {};
        parent[key] = obj;
        stack.push({ indent, value: obj });
      }
      continue;
    }

    parent[key] = parseScalar(rest);
  }

  return root;
}

function nextNonBlank(lines: string[], from: number): { text: string; indent: number } | null {
  for (let i = from; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (!l.trim() || l.trim().startsWith('#')) continue;
    return { text: l, indent: l.match(/^ */)?.[0].length ?? 0 };
  }
  return null;
}

function parseScalar(value: string): unknown {
  // inline array
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((v) => parseScalar(v.trim()));
  }
  // quoted string
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~') return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?\d+\.\d+$/.test(value)) return Number.parseFloat(value);
  return value;
}
