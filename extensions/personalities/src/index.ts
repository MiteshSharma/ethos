import { basename, dirname, join } from 'node:path';
import {
  assertSafeId,
  type DreamingConfig,
  EthosError,
  isValidSecretName,
  type LearningLogEntry,
  type LivingSoul,
  type ModelTierConfig,
  type PersonalityConfig,
  type PersonalityObservabilityConfig,
  type PersonalityRegistry,
  type PersonalitySafetyConfig,
  type Storage,
} from '@ethosagent/types';
import {
  applyExpressionUpdate,
  parseLivingSoul,
  revertExpression as revertExpressionBody,
} from './living-soul';

export {
  buildDidDocument,
  canonicalize,
  deriveDidKey,
  type Ed25519KeyPair,
  fingerprint,
  generateEd25519,
  publicKeyMultibase,
  rawPublicKeyFromPem,
  signCard,
  verifyCard,
} from './a2a-crypto';
export {
  type A2aIdentityProviderOptions,
  type A2aPersonalitySource,
  PersonalityA2aIdentityProvider,
} from './a2a-identity';
export {
  type CharacterSheetBoundary,
  type CharacterSheetExecution,
  type CharacterSheetModelFit,
  type CharacterSheetScriptSurface,
  firstParagraph,
  renderCharacterSheet,
} from './character-sheet';

export const SYSTEM_PERSONALITY_IDS: ReadonlySet<string> = new Set([
  'personality-architect',
  'team-architect',
  'debug',
]);

// ---------------------------------------------------------------------------
// YAML parsers — no external dependency, handles the subset we need
// ---------------------------------------------------------------------------

const NESTED_BLOCKS = ['safety'] as const;
type NestedBlockName = (typeof NESTED_BLOCKS)[number];

function parseNestedBlock(
  lines: string[],
  startIdx: number,
): { obj: Record<string, unknown>; endIdx: number } {
  const obj: Record<string, unknown> = {};
  const indent = lines[startIdx]?.match(/^(\s+)/)?.[1]?.length ?? 2;
  let i = startIdx;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || line.match(/^\s*#/)) {
      i++;
      continue;
    }
    const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (lineIndent < indent) break;
    if (lineIndent === indent) {
      const m = line.match(/^\s+([\w]+):\s*(.*)$/);
      if (m) {
        const key = m[1];
        const val = m[2].trim();
        if (val === '' || val === '{}') {
          const next = lines[i + 1];
          const nextIndent = next?.match(/^(\s+)/)?.[1]?.length ?? 0;
          if (next && nextIndent > indent) {
            // A deeper-indented block follows. It is either a list (lines that
            // start with `- `) or a nested object. Lists on following lines are
            // not handled by the recursive object parser, so detect them here.
            if (next.trim().startsWith('- ')) {
              const items: string[] = [];
              let j = i + 1;
              while (j < lines.length) {
                const al = lines[j] ?? '';
                const alTrimmed = al.trim();
                if (alTrimmed === '' || alTrimmed.startsWith('#')) {
                  j++;
                  continue;
                }
                if (!alTrimmed.startsWith('- ')) break;
                items.push(
                  alTrimmed
                    .slice(2)
                    .trim()
                    .replace(/^["']|["']$/g, ''),
                );
                j++;
              }
              obj[key] = items;
              i = j;
              continue;
            }
            const { obj: child, endIdx } = parseNestedBlock(lines, i + 1);
            obj[key] = child;
            i = endIdx;
            continue;
          }
          obj[key] = {};
        } else if (val.startsWith('- ')) {
          const items: string[] = [val.slice(2)];
          let j = i + 1;
          while (j < lines.length) {
            const al = lines[j] ?? '';
            const alTrimmed = al.trim();
            if (!alTrimmed.startsWith('- ')) break;
            items.push(alTrimmed.slice(2).trim());
            j++;
          }
          obj[key] = items;
          i = j;
          continue;
        } else {
          obj[key] = val.replace(/^["']|["']$/g, '');
        }
      }
    }
    i++;
  }
  return { obj, endIdx: i };
}

/**
 * Extract the verbatim text of the `safety:` block from a config.yaml source.
 *
 * Captures from the `safety:` line through all subsequent indented child lines,
 * stopping at the first zero-indent non-blank, non-comment line (a new top-level
 * key) or EOF. Trailing blank lines inside the captured range are trimmed so we
 * do not emit stray blank lines. Returns '' if no safety block is found, and the
 * block WITHOUT a trailing newline (the caller adds spacing). This mirrors what
 * parseConfigYaml/parseNestedBlock consume, so it round-trips losslessly —
 * including sub-keys the read path does not parse (network, injectionDefense, …).
 */
function extractRawSafetyBlock(src: string): string {
  const lines = src.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (/^safety:\s*$/.test(line) || /^safety:\s*\{\}\s*$/.test(line)) {
      start = i;
      break;
    }
  }
  if (start === -1) return '';
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s*#/.test(line)) continue;
    const indent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (indent === 0) {
      end = i;
      break;
    }
  }
  const block = lines.slice(start, end);
  while (block.length > 1 && (block[block.length - 1] ?? '').trim() === '') block.pop();
  return block.join('\n');
}

interface ParsedConfigYaml {
  flat: Record<string, string>;
  nested: Partial<Record<NestedBlockName, Record<string, unknown>>>;
}

function parseConfigYaml(src: string): ParsedConfigYaml {
  const flat: Record<string, string> = {};
  const nested: Partial<Record<NestedBlockName, Record<string, unknown>>> = {};
  const srcLines = src.split('\n');

  // First pass: flat key-value pairs (and detect nested block starts)
  const nestedBlockStartLines = new Set<number>();
  for (let i = 0; i < srcLines.length; i++) {
    const line = srcLines[i] ?? '';

    // Check for top-level nested block declarations
    let foundNested = false;
    for (const block of NESTED_BLOCKS) {
      if (
        line.match(new RegExp(`^${block}:\\s*$`)) ||
        line.match(new RegExp(`^${block}:\\s*\\{\\}`))
      ) {
        const { obj } = parseNestedBlock(srcLines, i + 1);
        nested[block] = obj;
        // Mark lines consumed by the nested block (approximate: mark this start line)
        nestedBlockStartLines.add(i);
        foundNested = true;
        break;
      }
    }
    if (foundNested) continue;

    // Reject non-allowlisted nested blocks
    const nestedKey = line.match(/^(\w+):\s*$/)?.[1];
    if (nestedKey && !NESTED_BLOCKS.includes(nestedKey as NestedBlockName) && !line.match(/^#/)) {
      for (let j = i + 1; j < srcLines.length; j++) {
        const next = srcLines[j] ?? '';
        if (next.trim() === '') continue;
        if (next.match(/^\s+\w+:/)) {
          throw new Error(
            `Top-level key "${nestedKey}" cannot be a nested object in personality config. ` +
              `Only ${NESTED_BLOCKS.join(', ')} may be nested.`,
          );
        }
        break;
      }
    }

    // Allow dotted keys (e.g. `fs_reach.read`) so nested config can land
    // in the flat parser without escaping.
    const m = line.match(/^([\w.]+):\s*(.+)$/);
    if (m) flat[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
  }

  return { flat, nested };
}

function parseToolsetYaml(src: string): string[] {
  return src
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2).trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// tools.yaml — per-personality tool config (source of truth). A sibling
// artifact to config.yaml / toolset.yaml / mcp.yaml, NOT a field on the frozen
// PersonalityConfig schema. Only `web_search` is modeled in v1. A binding
// carries a secret NAME only — never a value (§V S9) — so the directory stays
// shareable and committable.
// ---------------------------------------------------------------------------

export interface PersonalityToolsConfig {
  web_search?: { provider?: 'exa' | 'tavily' | 'brave'; secret?: string };
}

function parseInlineToolMap(s: string): Record<string, string> {
  const inner = s.replace(/^\{/, '').replace(/\}$/, '').trim();
  const out: Record<string, string> = {};
  if (!inner) return out;
  for (const pair of inner.split(',')) {
    const idx = pair.indexOf(':');
    if (idx === -1) continue;
    const k = pair.slice(0, idx).trim();
    const v = pair
      .slice(idx + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (k) out[k] = v;
  }
  return out;
}

/**
 * Parse a personality-directory `tools.yaml`. Supports the documented inline
 * flow-map form and the equivalent block form:
 *
 *   web_search: { provider: exa, secret: exa-main }
 *   # or
 *   web_search:
 *     provider: exa
 *     secret: exa-main
 */
export function parseToolsYaml(src: string): PersonalityToolsConfig {
  const out: PersonalityToolsConfig = {};
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const m = line.match(/^web_search:\s*(.*)$/);
    if (!m) continue;
    const rest = (m[1] ?? '').trim();
    let entry: Record<string, string> = {};
    if (rest.startsWith('{')) {
      entry = parseInlineToolMap(rest);
    } else if (rest === '') {
      let j = i + 1;
      while (j < lines.length) {
        const bl = lines[j] ?? '';
        if (bl.trim() === '' || bl.trim().startsWith('#')) {
          j++;
          continue;
        }
        const indent = bl.match(/^(\s*)/)?.[1]?.length ?? 0;
        if (indent === 0) break;
        const bm = bl.match(/^\s+(\w+):\s*(.+)$/);
        if (bm) entry[bm[1]] = bm[2].trim().replace(/^["']|["']$/g, '');
        j++;
      }
      i = j - 1;
    }
    // `tools.yaml` is personality-owned and therefore UNTRUSTED input
    // (marketplace / imported personalities). A `secret` value flows into a
    // `providers/<provider>/<name>` ref that must stay inside web_search's
    // capability prefix grant — so it is validated with the same shared rule
    // the vault enforces. An out-of-shape secret drops the WHOLE binding: a
    // provider without its intended key must not silently fall back to a
    // different (default) key.
    if (entry.secret && !isValidSecretName(entry.secret)) continue;
    const ws: NonNullable<PersonalityToolsConfig['web_search']> = {};
    if (entry.provider === 'exa' || entry.provider === 'tavily' || entry.provider === 'brave') {
      ws.provider = entry.provider;
    }
    if (entry.secret) ws.secret = entry.secret;
    if (ws.provider || ws.secret) out.web_search = ws;
  }
  return out;
}

/**
 * Render a `PersonalityToolsConfig` back to the inline flow-map form
 * `parseToolsYaml` reads. Only fields that are set are emitted; a config with
 * no meaningful `web_search` binding renders to `''` (caller removes the file).
 */
export function renderToolsYaml(config: PersonalityToolsConfig): string {
  const ws = config.web_search;
  if (!ws) return '';
  const parts: string[] = [];
  if (ws.provider) parts.push(`provider: ${ws.provider}`);
  if (ws.secret) parts.push(`secret: ${ws.secret}`);
  if (parts.length === 0) return '';
  return `web_search: { ${parts.join(', ')} }\n`;
}

// ---------------------------------------------------------------------------
// mcp.yaml parser — handles the subset we need for McpPolicy
// ---------------------------------------------------------------------------

/**
 * Parse `mcp.yaml` into an `McpPolicy`. Expected shape:
 *
 *   servers:
 *     linear:
 *       tools:
 *         - list_issues
 *         - get_issue
 *       reject_args:
 *         save_issue:
 *           status:
 *             - Done
 *     slack:
 *       tools:
 *         - search_public
 */
export function parseMcpYaml(src: string): {
  policy: import('@ethosagent/types').McpPolicy;
  warnings: string[];
} {
  const lines = src.split('\n');
  const policy: import('@ethosagent/types').McpPolicy = {};
  const warnings: string[] = [];

  // Detect tabs anywhere — tabs in YAML are always wrong.
  for (let t = 0; t < lines.length; t++) {
    if ((lines[t] ?? '').includes('\t')) {
      warnings.push(`line ${t + 1}: contains tab character (YAML requires spaces for indentation)`);
    }
  }

  // Find `servers:` top-level key
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (/^servers:\s*$/.test(line)) {
      i++;
      break;
    }
    i++;
  }
  if (i >= lines.length) return { policy, warnings };

  policy.servers = {};

  // Parse each server block (indent level 2)
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (line.trim() === '' || /^\s*#/.test(line)) {
      i++;
      continue;
    }
    const lineIndent = line.match(/^(\s*)/)?.[1]?.length ?? 0;
    if (lineIndent < 2) break;

    const serverMatch = line.match(/^\s{2}(\w[\w-]*):\s*$/);
    if (!serverMatch) {
      // Non-blank, non-comment line at indent 2 that doesn't match a server name.
      // This is likely a bad indent or structural error — policy is being silently dropped.
      warnings.push(
        `line ${i + 1}: unrecognized line under servers: (expected "  <serverName>:"): ${line.trimEnd()}`,
      );
      i++;
      continue;
    }
    const serverName = serverMatch[1] ?? '';
    const serverPolicy: import('@ethosagent/types').McpServerPolicy = {};
    i++;

    // Parse server sub-keys at indent 4+
    while (i < lines.length) {
      const sline = lines[i] ?? '';
      if (sline.trim() === '' || /^\s*#/.test(sline)) {
        i++;
        continue;
      }
      const sIndent = sline.match(/^(\s*)/)?.[1]?.length ?? 0;
      if (sIndent < 4) break;

      if (/^\s{4}tools:\s*$/.test(sline)) {
        serverPolicy.tools = [];
        i++;
        while (i < lines.length) {
          const tline = lines[i] ?? '';
          if (tline.trim() === '' || /^\s*#/.test(tline)) {
            i++;
            continue;
          }
          const tMatch = tline.match(/^\s{6}-\s+(.+)$/);
          if (!tMatch) break;
          serverPolicy.tools.push((tMatch[1] ?? '').trim());
          i++;
        }
        continue;
      }

      if (/^\s{4}reject_args:\s*$/.test(sline)) {
        serverPolicy.reject_args = {};
        i++;
        while (i < lines.length) {
          const rline = lines[i] ?? '';
          if (rline.trim() === '' || /^\s*#/.test(rline)) {
            i++;
            continue;
          }
          const rIndent = rline.match(/^(\s*)/)?.[1]?.length ?? 0;
          if (rIndent < 6) break;

          const toolMatch = rline.match(/^\s{6}(\w[\w-]*):\s*$/);
          if (!toolMatch) {
            i++;
            continue;
          }
          const toolName = toolMatch[1] ?? '';
          const argRules: Record<string, string[]> = {};
          i++;

          while (i < lines.length) {
            const aline = lines[i] ?? '';
            if (aline.trim() === '' || /^\s*#/.test(aline)) {
              i++;
              continue;
            }
            const aIndent = aline.match(/^(\s*)/)?.[1]?.length ?? 0;
            if (aIndent < 8) break;

            const argMatch = aline.match(/^\s{8}(\w[\w-]*):\s*$/);
            if (!argMatch) {
              i++;
              continue;
            }
            const argName = argMatch[1] ?? '';
            const values: string[] = [];
            i++;

            while (i < lines.length) {
              const vline = lines[i] ?? '';
              if (vline.trim() === '' || /^\s*#/.test(vline)) {
                i++;
                continue;
              }
              const vMatch = vline.match(/^\s{10}-\s+(.+)$/);
              if (!vMatch) break;
              values.push((vMatch[1] ?? '').trim());
              i++;
            }
            argRules[argName] = values;
          }
          serverPolicy.reject_args[toolName] = argRules;
        }
        continue;
      }

      const enabledMatch = sline.match(/^\s{4}enabled:\s*(true|false)\s*$/);
      if (enabledMatch) {
        serverPolicy.enabled = enabledMatch[1] === 'true';
        i++;
        continue;
      }

      // Non-blank, non-comment line at indent 4 that isn't tools: or reject_args:.
      // Unknown key — possible typo; the key's content is silently dropped.
      const unknownKeyMatch = sline.match(/^\s{4}(\w[\w-]*):/);
      const keyName = unknownKeyMatch ? unknownKeyMatch[1] : sline.trim();
      warnings.push(
        `line ${i + 1}: unknown key "${keyName}" under server "${serverName}" (expected "tools", "reject_args", or "enabled")`,
      );
      i++;
    }

    policy.servers[serverName] = serverPolicy;
  }

  return { policy, warnings };
}

/**
 * Serialize an `McpPolicy` back into `mcp.yaml` text — the inverse of
 * `parseMcpYaml`. Round-trips both `tools` and `reject_args` so editing a
 * tool subset never destroys argument-rejection rules.
 *
 * A server with no `tools` and no `reject_args` is still emitted (as a bare
 * `  <name>:` line) so the policy round-trips faithfully. Returns an empty
 * string when the policy has no servers — callers should treat that as
 * "delete the file" or "write nothing".
 */
export function renderMcpYaml(policy: import('@ethosagent/types').McpPolicy): string {
  const servers = policy.servers;
  if (!servers || Object.keys(servers).length === 0) return '';

  const lines: string[] = ['servers:'];
  for (const serverName of Object.keys(servers)) {
    const serverPolicy = servers[serverName] ?? {};
    lines.push(`  ${serverName}:`);
    if (serverPolicy.enabled !== undefined) {
      lines.push(`    enabled: ${serverPolicy.enabled}`);
    }
    if (serverPolicy.tools !== undefined) {
      lines.push('    tools:');
      for (const tool of serverPolicy.tools) {
        lines.push(`      - ${tool}`);
      }
    }
    const rejectArgs = serverPolicy.reject_args;
    if (rejectArgs !== undefined) {
      lines.push('    reject_args:');
      for (const toolName of Object.keys(rejectArgs)) {
        lines.push(`      ${toolName}:`);
        const argRules = rejectArgs[toolName] ?? {};
        for (const argName of Object.keys(argRules)) {
          lines.push(`        ${argName}:`);
          for (const value of argRules[argName] ?? []) {
            lines.push(`          - ${value}`);
          }
        }
      }
    }
  }
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// FilePersonalityRegistry
// ---------------------------------------------------------------------------

export interface DescribedPersonality {
  config: PersonalityConfig;
  /** True if the personality is loaded from the package's bundled data dir
   *  (read-only); false if it lives under the user's writable
   *  `<userPersonalitiesDir>/<id>/`. */
  builtin: boolean;
  /** Per-personality MCP tool policy loaded from mcp.yaml (NOT part of the
   *  frozen PersonalityConfig schema). Undefined when the personality has no
   *  mcp.yaml file. */
  mcpPolicy?: import('@ethosagent/types').McpPolicy;
  /** Warnings from parsing mcp.yaml — present when the file contained
   *  structural problems that caused policy to be silently dropped (e.g.
   *  tab indentation, unknown keys, bad indent). Empty array omitted. */
  mcpWarnings?: string[];
}

export interface CreatePersonalityInput {
  id: string;
  name: string;
  description?: string;
  model?: string | import('@ethosagent/types').ModelTierConfig;
  toolset: string[];
  soulMd: string;
  provider?: string;
  capabilities?: string[];
  mcp_servers?: string[];
  plugins?: string[];
  fs_reach?: { read?: string[]; write?: string[]; workdir?: string };
  skill_evolution?: {
    enabled?: boolean;
    min_tool_calls?: number;
    cooldown_minutes?: number;
    model?: string;
    evolve_existing?: boolean;
    promotion?: 'review' | 'auto';
    scope?: 'personality' | 'shared';
  };
  dreaming?: import('@ethosagent/types').DreamingConfig;
  evolution_approval_mode?: 'auto' | 'user';
  nightly?: import('@ethosagent/types').PersonalityConfig['nightly'];
  /** How this personality sounds and listens. `tts_provider` / `stt_provider`
   *  name entries in the deployment's `voice.tts.providers.*` /
   *  `voice.stt.providers.*` rosters; `tts_voice` is the TTS provider's voice
   *  id. Empty strings are dropped, so an editor can send blanks for "unset". */
  voice?: EditableVoiceConfig;
}

/**
 * The sub-keys of `PersonalityVoiceConfig` an editor may write.
 *
 * `tier`, `model` and `languages` are excluded on purpose: they parse and
 * serialize, but nothing routes on them yet, so exposing them through a create
 * or update API would be advertising a control that does nothing.
 */
export interface EditableVoiceConfig {
  tts_provider?: string;
  stt_provider?: string;
  tts_voice?: string;
}

/** The editable sub-keys, in one place — the merge walks exactly this list. */
const EDITABLE_VOICE_KEYS = ['tts_provider', 'stt_provider', 'tts_voice'] as const;

export interface UpdatePersonalityPatch {
  name?: string;
  description?: string;
  model?: string | import('@ethosagent/types').ModelTierConfig;
  toolset?: string[];
  soulMd?: string;
  mcp_servers?: string[];
  plugins?: string[];
  capabilities?: string[];
  provider?: string;
  fs_reach?: { read?: string[]; write?: string[]; workdir?: string };
  /** Partial dreaming config — shallow-merged onto the existing dreaming block
   *  so a patch that carries only `enable` (or only a cadence number) never
   *  drops sibling fields. */
  dreaming?: Partial<import('@ethosagent/types').DreamingConfig>;
  /** Enable-only dreaming toggle. Merges `enable` into the existing dreaming
   *  cadence (idleMinutes / maxPerDay), defaulting cadence when none exists.
   *  Used by the web editor's toggle so flipping it never resets cadence. */
  dreamingEnable?: boolean;
  /** Governed-learning approval dial. 'auto' applies evolved Expression
   *  automatically; 'user' holds it for human approval. */
  evolution_approval_mode?: 'auto' | 'user';
  /** Skill-evolution tuning — shallow-merged onto the existing config so a
   *  patch to one knob (e.g. `model`) never drops sibling fields. */
  skill_evolution?: import('@ethosagent/types').PersonalityConfig['skill_evolution'];
  /** Per-personality safety config (e.g. approval mode). Merged onto the
   *  existing safety block so a partial patch never drops sibling fields. */
  safety?: import('@ethosagent/types').PersonalityConfig['safety'];
  /** Per-personality memory backend. Merged onto the existing memory block so
   *  a provider patch never drops `options`. */
  memory?: import('@ethosagent/types').PersonalityConfig['memory'];
  /** Nightly governed-learning gates. The UI sends the FULL nightly object
   *  (incl. the full judge sub-object), so a one-level shallow merge onto the
   *  existing block is correct — `judge` is replaced wholesale, not deep-merged. */
  nightly?: import('@ethosagent/types').PersonalityConfig['nightly'];
  /** Voice sub-keys, shallow-merged onto the stored `voice` block so a patch
   *  carrying only `tts_voice` leaves a hand-written `languages` map alone.
   *  `''` CLEARS that sub-key — the same convention `fs_reach.workdir` uses,
   *  and the only way the editor can express "back to the default provider". */
  voice?: EditableVoiceConfig;
}

/**
 * Apply an editable voice patch to the stored `voice` block.
 *
 * `''` clears a sub-key, `undefined` leaves it, anything else sets it. Sub-keys
 * the editor cannot write (`tier`, `model`, `languages`) ride through
 * untouched, so hand-authored config survives a save from the web.
 * A block left with nothing in it is dropped rather than written empty.
 */
function mergeVoiceConfig(
  existing: import('@ethosagent/types').PersonalityVoiceConfig | undefined,
  patch: EditableVoiceConfig,
): import('@ethosagent/types').PersonalityVoiceConfig | undefined {
  const next: import('@ethosagent/types').PersonalityVoiceConfig = { ...existing };
  for (const key of EDITABLE_VOICE_KEYS) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === '') delete next[key];
    else next[key] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

export class FilePersonalityRegistry implements PersonalityRegistry {
  private readonly personalities = new Map<string, PersonalityConfig>();
  /** Per-personality MCP policy loaded from mcp.yaml (sibling artifact, NOT
   *  on PersonalityConfig). Keyed by personality id. */
  private readonly mcpPolicies = new Map<string, import('@ethosagent/types').McpPolicy>();
  /** Warnings from parsing mcp.yaml, keyed by personality id. */
  private readonly mcpWarningsMap = new Map<string, string[]>();
  /** Per-personality tool config loaded from tools.yaml (source of truth,
   *  sibling artifact — NOT on PersonalityConfig). Keyed by personality id. */
  private readonly toolsConfigs = new Map<string, PersonalityToolsConfig>();
  // dir → fingerprint of config.yaml + SOUL.md + toolset.yaml + mcp.yaml mtimes
  private readonly fingerprintCache = new Map<string, string>();
  private defaultId = 'researcher';
  private readonly storage: Storage;
  /** Directory holding user-created personalities (mutable). When unset,
   *  CRUD methods (create/update/delete/duplicate) are unavailable. */
  private readonly userDir: string | undefined;

  constructor(storage: Storage, userPersonalitiesDir?: string) {
    this.storage = storage;
    this.userDir = userPersonalitiesDir ? join(userPersonalitiesDir, 'personalities') : undefined;
  }

  // -------------------------------------------------------------------------
  // Interface methods
  // -------------------------------------------------------------------------

  define(config: PersonalityConfig): void {
    this.personalities.set(config.id, config);
  }

  get(id: string): PersonalityConfig | undefined {
    return this.personalities.get(id);
  }

  /** Return the McpPolicy loaded from mcp.yaml for the given personality id.
   *  Returns undefined when the personality has no mcp.yaml file. */
  getMcpPolicy(id: string): import('@ethosagent/types').McpPolicy | undefined {
    return this.mcpPolicies.get(id);
  }

  /** Return the tool config loaded from tools.yaml for the given personality
   *  id (the source-of-truth binding). Undefined when the personality has no
   *  tools.yaml file. */
  getToolsConfig(id: string): PersonalityToolsConfig | undefined {
    return this.toolsConfigs.get(id);
  }

  list(): PersonalityConfig[] {
    return [...this.personalities.values()];
  }

  getDefault(): PersonalityConfig {
    return (
      this.personalities.get(this.defaultId) ??
      this.personalities.values().next().value ?? {
        id: 'default',
        name: 'Default',
      }
    );
  }

  setDefault(id: string): void {
    if (!this.personalities.has(id)) throw new Error(`Unknown personality: ${id}`);
    this.defaultId = id;
  }

  remove(id: string): void {
    this.personalities.delete(id);
    this.mcpPolicies.delete(id);
    this.mcpWarningsMap.delete(id);
    this.toolsConfigs.delete(id);
    // Also drop fingerprint entries for that id's directory so a
    // subsequent re-create with the same id rebuilds cleanly. We
    // don't know the dir from the id alone, so iterate.
    for (const [dir] of this.fingerprintCache) {
      if (dir.endsWith(`/${id}`)) {
        this.fingerprintCache.delete(dir);
        break;
      }
    }
  }

  async loadFromDirectory(dir: string): Promise<void> {
    const entries = await this.storage.list(dir);
    const observed = new Set(entries);

    // Reconcile deletions: drop any personality previously loaded from THIS
    // directory whose sub-directory no longer exists on disk, so a removed
    // personality stops resolving with its stale toolset / fs_reach allowlist /
    // mcp policy. Scoped by parent dir (fingerprint-cache keys ARE the
    // personality dirs) so built-ins loaded from the package data dir are never
    // evicted. Snapshot the keys — remove() mutates the fingerprint cache. This
    // runs even when `entries` is empty, so deleting the LAST personality in a
    // dir collapses the cache correctly rather than leaving stale entries.
    for (const cachedDir of [...this.fingerprintCache.keys()]) {
      if (dirname(cachedDir) === dir && !observed.has(basename(cachedDir))) {
        this.remove(basename(cachedDir));
      }
    }

    await Promise.all(
      entries.map(async (entry) => {
        const personalityDir = join(dir, entry);
        await this.loadOne(personalityDir, entry);
      }),
    );
  }

  // -------------------------------------------------------------------------
  // CRUD — only available when `userPersonalitiesDir` was passed to the
  // constructor. Built-ins live in the package's bundled `data/` dir and
  // cannot be modified directly; clone via `duplicate` then edit the copy.
  // -------------------------------------------------------------------------

  /** Absolute path of the user-personality directory, even if it doesn't
   *  exist yet. Throws when no user dir was configured. */
  userPathFor(id: string): string {
    if (!this.userDir) {
      throw new Error(
        'FilePersonalityRegistry: userPathFor() requires a userPersonalitiesDir at construction time.',
      );
    }
    assertSafeId(id, 'personalityId');
    return join(this.userDir, id);
  }

  describe(id: string): DescribedPersonality | null {
    const config = this.personalities.get(id);
    return config ? this.toDescribed(config) : null;
  }

  describeAll(): DescribedPersonality[] {
    return [...this.personalities.values()].map((c) => this.toDescribed(c));
  }

  /**
   * Read the SOUL.md body for a personality. Returns `''` if the
   * personality has no `soulFile` (config-only personalities) or if the
   * file isn't readable.
   */
  async readSoulMd(id: string): Promise<string> {
    const config = this.personalities.get(id);
    if (!config?.soulFile) return '';
    return (await this.storage.read(config.soulFile)) ?? '';
  }

  async readLivingSoul(id: string): Promise<LivingSoul> {
    const body = await this.readSoulMd(id);
    return parseLivingSoul(body);
  }

  async evolveExpression(
    id: string,
    newExpression: string,
    opts: { summary: string; evidenceRef: string },
  ): Promise<{ entry: LearningLogEntry; soul: LivingSoul }> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    const body = (await this.storage.read(join(dir, 'SOUL.md'))) ?? '';
    const current = parseLivingSoul(body);
    const revisionId = `expr-rev-${current.learningLog.length + 1}`;
    const historyDir = join(dir, '.expression-history');
    await this.storage.mkdir(historyDir);
    await this.storage.writeAtomic(join(historyDir, `${revisionId}.md`), current.expression);
    const entry: LearningLogEntry = {
      revisionId,
      at: new Date().toISOString(),
      summary: opts.summary,
      evidenceRef: opts.evidenceRef,
      prevExpressionRef: revisionId,
    };
    const next = applyExpressionUpdate(body, newExpression, entry);
    await this.storage.writeAtomic(join(dir, 'SOUL.md'), next);
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
    return { entry, soul: parseLivingSoul(next) };
  }

  async revertExpression(id: string, revisionId: string): Promise<LivingSoul> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    const priorExpression = await this.storage.read(
      join(dir, '.expression-history', `${revisionId}.md`),
    );
    if (priorExpression === null) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `No expression snapshot "${revisionId}" found for personality "${id}".`,
        action:
          'Run `ethos personality revert <id>` without args to see available revisions, or check the Learning Log.',
      });
    }
    const body = (await this.storage.read(join(dir, 'SOUL.md'))) ?? '';
    const current = parseLivingSoul(body);
    const newRevisionId = `expr-rev-${current.learningLog.length + 1}`;
    const historyDir = join(dir, '.expression-history');
    await this.storage.mkdir(historyDir);
    await this.storage.writeAtomic(join(historyDir, `${newRevisionId}.md`), current.expression);
    const entry: LearningLogEntry = {
      revisionId: newRevisionId,
      at: new Date().toISOString(),
      summary: `reverted to ${revisionId}`,
      evidenceRef: revisionId,
      prevExpressionRef: newRevisionId,
    };
    const next = revertExpressionBody(body, priorExpression, entry);
    await this.storage.writeAtomic(join(dir, 'SOUL.md'), next);
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
    return parseLivingSoul(next);
  }

  async listExpressionSnapshots(id: string): Promise<string[]> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    const names = await this.storage.list(join(dir, '.expression-history'));
    const ids = names.filter((n) => n.endsWith('.md')).map((n) => n.slice(0, -'.md'.length));
    ids.sort((a, b) => expressionRevNumber(b) - expressionRevNumber(a));
    return ids;
  }

  async create(input: CreatePersonalityInput): Promise<DescribedPersonality> {
    assertSafeId(input.id, 'personalityId');
    if (this.personalities.get(input.id)) {
      throw new EthosError({
        code: 'PERSONALITY_EXISTS',
        cause: `Personality "${input.id}" already exists.`,
        action: 'Pick a different id, or open the existing one to edit it.',
      });
    }
    const dir = this.userPathFor(input.id);
    await this.storage.mkdir(dir);
    await this.storage.mkdir(join(dir, 'files'));
    // Through `mergeVoiceConfig` even on create, so blank editor fields become
    // "no voice block" rather than `voice.tts_provider: ` lines the loader ignores.
    const voice = input.voice ? mergeVoiceConfig(undefined, input.voice) : undefined;
    await this.storage.write(
      join(dir, 'config.yaml'),
      renderConfigYaml({ ...input, ...(voice ? { voice } : { voice: undefined }) }),
    );
    await this.storage.write(join(dir, 'toolset.yaml'), renderToolsetYaml(input.toolset));
    await this.storage.write(join(dir, 'SOUL.md'), input.soulMd);
    await this.refreshUserDir();
    const created = this.describe(input.id);
    if (!created) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Created personality "${input.id}" but registry refresh did not pick it up.`,
        action: 'Restart the server to recover.',
      });
    }
    return created;
  }

  async update(id: string, patch: UpdatePersonalityPatch): Promise<DescribedPersonality> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    if (
      patch.name !== undefined ||
      patch.description !== undefined ||
      patch.model !== undefined ||
      patch.mcp_servers !== undefined ||
      patch.plugins !== undefined ||
      patch.capabilities !== undefined ||
      patch.provider !== undefined ||
      patch.fs_reach !== undefined ||
      patch.dreaming !== undefined ||
      patch.dreamingEnable !== undefined ||
      patch.evolution_approval_mode !== undefined ||
      patch.skill_evolution !== undefined ||
      patch.safety !== undefined ||
      patch.memory !== undefined ||
      patch.nightly !== undefined ||
      patch.voice !== undefined
    ) {
      const config = existing.config;
      if (patch.provider !== undefined && patch.provider !== '') {
        const validProviders = [
          'anthropic',
          'openai',
          'codex',
          'openrouter',
          'openai-compat',
          'ollama',
          'azure',
        ];
        if (!validProviders.includes(patch.provider)) {
          throw new EthosError({
            code: 'INVALID_INPUT',
            cause: `provider "${patch.provider}" is not a recognized provider. Valid: ${validProviders.join(', ')}.`,
            action: 'Use one of the recognized provider values, or omit to use the engine default.',
          });
        }
      }
      if (patch.capabilities !== undefined) {
        for (const tag of patch.capabilities) {
          if (!/^[a-zA-Z0-9_-]+$/.test(tag)) {
            throw new EthosError({
              code: 'INVALID_INPUT',
              cause: `capabilities tag "${tag}" must only contain letters, digits, hyphens, and underscores.`,
              action: 'Fix the tag and retry.',
            });
          }
        }
      }
      if (patch.fs_reach !== undefined) {
        // workdir is validated by the same predicate — it lands in both derived
        // reach lists, so an unchecked one would be a hole straight through this
        // guard.
        const allPaths = [
          ...(patch.fs_reach.read ?? []),
          ...(patch.fs_reach.write ?? []),
          ...(patch.fs_reach.workdir ? [patch.fs_reach.workdir] : []),
        ];
        for (const p of allPaths) {
          if (/[\n\r,]/.test(p) || p.includes('\0')) {
            throw new EthosError({
              code: 'INVALID_INPUT',
              cause: `fs_reach entry "${p.replace(/[\n\r]/g, '\\n')}" contains invalid characters (newlines, commas, or null bytes are not allowed).`,
              action: 'Fix the path and retry.',
            });
          }
          const validStart =
            p.startsWith('/') ||
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
            p.startsWith('${ETHOS_HOME}') ||
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
            p.startsWith('${self}') ||
            // biome-ignore lint/suspicious/noTemplateCurlyInString: literal config.yaml substitution token
            p.startsWith('${CWD}');
          if (!validStart || p.includes('..') || p === '/') {
            throw new EthosError({
              code: 'INVALID_INPUT',
              cause: `fs_reach entry "${p}" must start with "/" or a substitution token (\${ETHOS_HOME}, \${self}, \${CWD}), must not contain "..", and must not be "/".`,
              action: 'Fix the path and retry.',
            });
          }
        }
      }
      // Resolve dreaming: a `dreaming` patch is shallow-merged onto the existing
      // block (so a patch carrying only `enable` or only a cadence number keeps
      // its siblings, and vice-versa), defaulting cadence when none exists;
      // otherwise an enable-only toggle merges into the existing cadence;
      // otherwise the existing config is carried through untouched.
      let mergedDreaming = config.dreaming;
      if (patch.dreaming !== undefined) {
        const prev = config.dreaming;
        const prompt = patch.dreaming.prompt ?? prev?.prompt;
        mergedDreaming = {
          enable: patch.dreaming.enable ?? prev?.enable ?? false,
          idleMinutes: patch.dreaming.idleMinutes ?? prev?.idleMinutes ?? 60,
          maxPerDay: patch.dreaming.maxPerDay ?? prev?.maxPerDay ?? 1,
          ...(prompt !== undefined ? { prompt } : {}),
        };
      } else if (patch.dreamingEnable !== undefined) {
        const prev = config.dreaming;
        mergedDreaming = {
          enable: patch.dreamingEnable,
          idleMinutes: prev?.idleMinutes ?? 60,
          maxPerDay: prev?.maxPerDay ?? 1,
          ...(prev?.prompt !== undefined ? { prompt: prev.prompt } : {}),
        };
      }
      // Skill-evolution: shallow-merge the patch onto the existing config so a
      // patch to one knob (e.g. `model`) never drops sibling fields.
      const mergedSkillEvolution =
        patch.skill_evolution === undefined
          ? config.skill_evolution
          : { ...config.skill_evolution, ...patch.skill_evolution };
      // Carry the FULL existing config and overlay only the patched fields,
      // so an update to one field never drops the rest. `id`, `soulFile`, and
      // `skillsDirs` are loader-populated and excluded from config.yaml.
      const { id: _id, soulFile: _soulFile, skillsDirs: _skillsDirs, ...rest } = config;
      const merged: RenderConfigInput = {
        ...rest,
        name: patch.name ?? config.name,
        description: patch.description ?? config.description,
        model: patch.model ?? config.model,
        toolset: patch.toolset ?? config.toolset ?? [],
        mcp_servers: patch.mcp_servers ?? config.mcp_servers,
        plugins: patch.plugins ?? config.plugins,
        capabilities: patch.capabilities === undefined ? config.capabilities : patch.capabilities,
        provider: patch.provider === undefined ? config.provider : patch.provider,
        // Shallow-merged, like `safety` / `memory` / `nightly` / `skill_evolution`
        // below: a patch carrying only `read` and `write` (what the web config
        // editor sends) must not silently drop a hand-declared `workdir`. The
        // whole-object replacements in this block are all scalars or arrays,
        // which have no sub-keys to lose. Pass `workdir: ''` to clear it.
        fs_reach:
          patch.fs_reach === undefined
            ? config.fs_reach
            : { ...config.fs_reach, ...patch.fs_reach },
        dreaming: mergedDreaming,
        evolution_approval_mode: patch.evolution_approval_mode ?? config.evolution_approval_mode,
        skill_evolution: mergedSkillEvolution,
        safety: patch.safety === undefined ? config.safety : { ...config.safety, ...patch.safety },
        memory: patch.memory === undefined ? config.memory : { ...config.memory, ...patch.memory },
        nightly:
          patch.nightly === undefined ? config.nightly : { ...config.nightly, ...patch.nightly },
        voice:
          patch.voice === undefined ? config.voice : mergeVoiceConfig(config.voice, patch.voice),
      };
      // renderConfigYaml's safety emission is suppressed here (render with
      // `safety: undefined`) so we append exactly one safety block — never a
      // duplicate (ARCHITECTURE.md §V S7). When `patch.safety` is undefined the
      // verbatim raw block is re-appended, lossless for sub-keys the read path
      // does not parse (network, injectionDefense, …). When `patch.safety` is
      // defined the patched scalar fields are applied line-by-line onto the raw
      // block so the patch wins while those unparseable sub-keys are preserved.
      const rendered = renderConfigYaml({ ...merged, safety: undefined });
      const existingRaw = await this.storage.read(join(dir, 'config.yaml'));
      const rawSafetyBlock = existingRaw ? extractRawSafetyBlock(existingRaw) : '';
      let safetyBlock: string;
      if (patch.safety === undefined) {
        safetyBlock = rawSafetyBlock;
      } else if (rawSafetyBlock) {
        const blockLines = rawSafetyBlock.split('\n');
        for (const [key, value] of Object.entries(patch.safety)) {
          if (value === null || typeof value === 'object') continue;
          const line = `  ${key}: ${renderScalarValue(value)}`;
          const idx = blockLines.findIndex((l) => l.startsWith(`  ${key}:`));
          if (idx === -1) blockLines.splice(1, 0, line);
          else blockLines[idx] = line;
        }
        safetyBlock = blockLines.join('\n');
      } else {
        const mergedSafety = merged.safety as Record<string, unknown> | undefined;
        safetyBlock =
          mergedSafety && Object.keys(mergedSafety).length > 0
            ? `safety:\n${renderNestedBlock(mergedSafety, 1).join('\n')}`
            : '';
      }
      const finalConfig = safetyBlock ? `${rendered}${safetyBlock}\n` : rendered;
      await this.storage.write(join(dir, 'config.yaml'), finalConfig);
    }
    if (patch.toolset !== undefined) {
      await this.storage.write(join(dir, 'toolset.yaml'), renderToolsetYaml(patch.toolset));
    }
    if (patch.soulMd !== undefined) {
      await this.storage.write(join(dir, 'SOUL.md'), patch.soulMd);
    }
    // Invalidate the mtime-based fingerprint so a rapid second write within
    // the same millisecond is not silently skipped by loadOne's cache guard.
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
    const refreshed = this.describe(id);
    if (!refreshed) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Updated personality "${id}" but registry refresh did not pick it up.`,
        action: 'Restart the server to recover.',
      });
    }
    return refreshed;
  }

  /**
   * Write per-server MCP tool subsets into the personality's `mcp.yaml`.
   *
   * `subsets` maps a server name to its desired `tools` intent:
   *  - `string[]` — write an explicit `tools` list (a strict subset, or an
   *    empty list meaning "no tools allowed").
   *  - `null` — delete any existing `tools` key for that server, restoring
   *    the default-allow ("all tools") semantics.
   *
   * The existing `mcp.yaml` policy is read first; only each named server's
   * `tools` key is touched — `reject_args` and any servers absent from
   * `subsets` are preserved verbatim. A server named in `subsets` that did
   * not previously exist in the policy is created (with `tools` only) so an
   * explicit empty subset can be recorded.
   *
   * Built-in personalities are read-only — this throws for them, mirroring
   * `update()`.
   */
  async writeMcpToolSubsets(id: string, subsets: Record<string, string[] | null>): Promise<void> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);

    // Start from the on-disk policy so reject_args and untouched servers
    // survive the round-trip.
    const current = this.mcpPolicies.get(id);
    const servers: Record<string, import('@ethosagent/types').McpServerPolicy> = {};
    if (current?.servers) {
      for (const [name, policy] of Object.entries(current.servers)) {
        servers[name] = { ...policy };
      }
    }

    for (const [serverName, tools] of Object.entries(subsets)) {
      const prev = servers[serverName] ?? {};
      if (tools === null) {
        // Drop the tools key — but keep the server entry only if it still
        // carries reject_args; otherwise remove it entirely so the policy
        // stays minimal.
        if (prev.reject_args !== undefined || prev.enabled !== undefined) {
          const { tools: _omit, ...rest } = prev;
          servers[serverName] = rest;
        } else {
          delete servers[serverName];
        }
      } else {
        // Replace only the tools key; carry reject_args forward unchanged.
        servers[serverName] = { ...prev, tools: [...tools] };
      }
    }

    const policy: import('@ethosagent/types').McpPolicy =
      Object.keys(servers).length > 0 ? { servers } : {};
    const rendered = renderMcpYaml(policy);
    const mcpPath = join(dir, 'mcp.yaml');
    if (rendered === '') {
      await this.storage.remove(mcpPath).catch(() => {});
    } else {
      await this.storage.writeAtomic(mcpPath, rendered);
    }

    // Invalidate the mtime fingerprint so loadOne re-reads even within the
    // same millisecond, then refresh so getMcpPolicy reflects the write.
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
  }

  /**
   * Write the per-personality `tools.yaml` (source of truth for a CUSTOM
   * personality's tool bindings). Only a secret NAME is ever written — never a
   * value (§V S9) — so the directory stays shareable/committable. Built-ins
   * are read-only (`requireMutable` throws); their bindings live in the global
   * `toolSettings` fallback instead. Passing an empty config removes the file.
   */
  async writeToolsConfig(id: string, config: PersonalityToolsConfig): Promise<void> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    const rendered = renderToolsYaml(config);
    const path = join(dir, 'tools.yaml');
    if (rendered === '') {
      await this.storage.remove(path).catch(() => {});
    } else {
      await this.storage.writeAtomic(path, rendered);
    }
    // Invalidate the mtime fingerprint so loadOne re-reads even within the
    // same millisecond, then refresh so getToolsConfig reflects the write.
    this.fingerprintCache.delete(dir);
    await this.refreshUserDir();
  }

  async deletePersonality(id: string): Promise<void> {
    const existing = this.requireMutable(id);
    const dir = this.dirOf(existing);
    await this.storage.remove(dir, { recursive: true });
    this.remove(id);
  }

  /**
   * Copy a built-in (or any other) personality directory into the user
   * dir under a new id. The duplicate's `name:` line is rewritten to
   * "<original> (copy)" so the editor opens with a distinct identity
   * ready to be edited.
   */
  async duplicate(id: string, newId: string): Promise<DescribedPersonality> {
    assertSafeId(newId, 'personalityId');
    if (this.personalities.get(newId)) {
      throw new EthosError({
        code: 'PERSONALITY_EXISTS',
        cause: `Personality "${newId}" already exists.`,
        action: 'Pick a different id for the duplicate.',
      });
    }
    const src = this.personalities.get(id);
    if (!src) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use list() to see available ids.',
      });
    }
    const sourceDir = src.soulFile
      ? src.soulFile.replace(/\/SOUL\.md$/, '')
      : src.skillsDirs?.[0]?.replace(/\/skills$/, '');
    if (!sourceDir) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Personality "${id}" has no resolvable source directory to copy.`,
        action: 'Edit the source manually, or pick a different built-in.',
      });
    }
    const destDir = this.userPathFor(newId);
    if (!this.userDir) throw new Error('userDir undefined after userPathFor() call');
    await this.storage.mkdir(this.userDir);
    await copyTree(this.storage, sourceDir, destDir);
    await this.storage.mkdir(join(destDir, 'files'));
    await this.bumpDuplicateName(destDir, newId, src.name);
    await this.refreshUserDir();
    const created = this.describe(newId);
    if (!created) {
      throw new EthosError({
        code: 'INTERNAL',
        cause: `Duplicated "${id}" → "${newId}" but registry refresh did not pick it up.`,
        action: 'Restart the server to recover.',
      });
    }
    return created;
  }

  // -------------------------------------------------------------------------
  // CRUD internals
  // -------------------------------------------------------------------------

  private requireMutable(id: string): DescribedPersonality {
    const existing = this.describe(id);
    if (!existing) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use list() to see available ids.',
      });
    }
    if (existing.builtin) {
      throw new EthosError({
        code: 'PERSONALITY_READ_ONLY',
        cause: `Personality "${id}" is built-in and cannot be modified directly.`,
        action: 'Duplicate it via duplicate(), then edit the copy.',
      });
    }
    return existing;
  }

  private toDescribed(config: PersonalityConfig): DescribedPersonality {
    const soulFile = config.soulFile;
    const userPrefix = this.userDir ? `${this.userDir}/` : null;
    const builtin = userPrefix && soulFile ? !soulFile.startsWith(userPrefix) : true;
    const mcpPolicy = this.mcpPolicies.get(config.id);
    const mcpWarnings = this.mcpWarningsMap.get(config.id);
    return {
      config,
      builtin,
      ...(mcpPolicy ? { mcpPolicy } : {}),
      ...(mcpWarnings ? { mcpWarnings } : {}),
    };
  }

  private dirOf(p: DescribedPersonality): string {
    const soulFile = p.config.soulFile;
    if (soulFile) return soulFile.replace(/\/SOUL\.md$/, '');
    return this.userPathFor(p.config.id);
  }

  private async refreshUserDir(): Promise<void> {
    if (!this.userDir) return;
    await this.loadFromDirectory(this.userDir);
  }

  private async bumpDuplicateName(
    dir: string,
    newId: string,
    sourceName: string | undefined,
  ): Promise<void> {
    const path = join(dir, 'config.yaml');
    const raw = await this.storage.read(path);
    if (raw === null) return;
    const newName = sourceName ? `${sourceName} (copy)` : newId;
    const lines = raw.split('\n');
    let nameSet = false;
    for (let i = 0; i < lines.length; i++) {
      if (/^name:\s*/.test(lines[i] ?? '')) {
        lines[i] = `name: ${yamlScalar(newName)}`;
        nameSet = true;
        break;
      }
    }
    if (!nameSet) lines.unshift(`name: ${yamlScalar(newName)}`);
    await this.storage.write(path, lines.join('\n'));
  }

  // -------------------------------------------------------------------------
  // Built-in loader
  // -------------------------------------------------------------------------

  async loadBuiltins(): Promise<void> {
    // import.meta.dirname is the extensions/personalities/src directory
    const dataDir = join(import.meta.dirname, '..', 'data');
    await this.loadFromDirectory(dataDir);
    // Ensure researcher is the default if present
    if (this.personalities.has('researcher')) this.defaultId = 'researcher';
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async loadOne(dir: string, id: string): Promise<void> {
    // Fingerprint guard — invalidate when any of the personality's inputs change.
    // mtime alone is enough: filesystems we run on (APFS / ext4 / NTFS) all
    // expose sub-millisecond mtime, so two writes within the same tick
    // is vanishingly unlikely for personality files (humans editing config).
    // `skills/` is a DIRECTORY, and it is fingerprinted because `buildConfig`
    // derives `skillsDirs` from its existence — without it, installing the
    // first skill into a personality that had no `skills/` dir would never be
    // seen until the process restarted.
    const fingerprint = await this.fileFingerprint([
      join(dir, 'config.yaml'),
      join(dir, 'SOUL.md'),
      join(dir, 'toolset.yaml'),
      join(dir, 'mcp.yaml'),
      join(dir, 'tools.yaml'),
      join(dir, 'skills'),
    ]);
    if (this.fingerprintCache.get(dir) === fingerprint) return;
    this.fingerprintCache.set(dir, fingerprint);

    const { config, mcpPolicy, mcpWarnings, toolsConfig } = await this.buildConfig(dir, id);
    if (config) {
      this.define(config);
      if (mcpPolicy) {
        this.mcpPolicies.set(id, mcpPolicy);
      } else {
        this.mcpPolicies.delete(id);
      }
      if (mcpWarnings) {
        this.mcpWarningsMap.set(id, mcpWarnings);
      } else {
        this.mcpWarningsMap.delete(id);
      }
      if (toolsConfig) {
        this.toolsConfigs.set(id, toolsConfig);
      } else {
        this.toolsConfigs.delete(id);
      }
    }
  }

  private async buildConfig(
    dir: string,
    id: string,
  ): Promise<{
    config: PersonalityConfig | null;
    mcpPolicy?: import('@ethosagent/types').McpPolicy;
    mcpWarnings?: string[];
    toolsConfig?: PersonalityToolsConfig;
  }> {
    // Must have at least config.yaml or SOUL.md to be considered a personality
    const [configSrc, toolsetSrc, soulExists, skillsExists, mcpSrc, toolsSrc] = await Promise.all([
      this.storage.read(join(dir, 'config.yaml')),
      this.storage.read(join(dir, 'toolset.yaml')),
      this.storage.exists(join(dir, 'SOUL.md')),
      this.storage.exists(join(dir, 'skills')),
      this.storage.read(join(dir, 'mcp.yaml')),
      this.storage.read(join(dir, 'tools.yaml')),
    ]);

    if (!configSrc && !soulExists) return { config: null };

    const parsed = configSrc ? parseConfigYaml(configSrc) : { flat: {}, nested: {} };
    const cfg = parsed.flat;

    const capabilities = cfg.capabilities
      ? cfg.capabilities
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;

    const streamingTimeoutMs =
      cfg.streamingTimeoutMs && /^\d+$/.test(cfg.streamingTimeoutMs)
        ? Number.parseInt(cfg.streamingTimeoutMs, 10)
        : undefined;

    // fs_reach.read / fs_reach.write are comma-separated path lists;
    // fs_reach.workdir is a single path. Substitutions (${ETHOS_HOME},
    // ${self}, ${CWD}) are resolved by the AgentLoop at turn construction
    // time — the registry only surfaces the raw strings.
    const fsReachRead = parseCsv(cfg['fs_reach.read']);
    const fsReachWrite = parseCsv(cfg['fs_reach.write']);
    const fsReachWorkdir = cfg['fs_reach.workdir']?.trim() || undefined;
    const fsReach: PersonalityConfig['fs_reach'] | undefined =
      fsReachRead || fsReachWrite || fsReachWorkdir
        ? {
            ...(fsReachRead ? { read: fsReachRead } : {}),
            ...(fsReachWrite ? { write: fsReachWrite } : {}),
            ...(fsReachWorkdir ? { workdir: fsReachWorkdir } : {}),
          }
        : undefined;

    // mcp_servers and plugins are space-separated lists in config.yaml.
    const mcpServers = cfg.mcp_servers ? cfg.mcp_servers.split(/\s+/).filter(Boolean) : undefined;
    const plugins = cfg.plugins ? cfg.plugins.split(/\s+/).filter(Boolean) : undefined;

    const budgetCapUsd =
      cfg.budgetCapUsd && /^\d+(\.\d+)?$/.test(cfg.budgetCapUsd)
        ? Number.parseFloat(cfg.budgetCapUsd)
        : undefined;

    const safety = parsed.nested.safety ? buildSafetyConfig(parsed.nested.safety) : undefined;

    // E5 — context_layering.* dotted keys. Mirrors the fs_reach.* pattern so
    // we don't need a new nested-block parser entry for one-off configs.
    const contextLayering = buildContextLayering(cfg);

    // E4 — context_engine + context_engine_options.* dotted keys.
    const contextEngine = cfg.context_engine || undefined;
    const evolutionApprovalMode =
      cfg.evolution_approval_mode === 'auto' || cfg.evolution_approval_mode === 'user'
        ? cfg.evolution_approval_mode
        : undefined;
    const contextEngineOptions = buildContextEngineOptions(cfg);

    // E3 — skill_evolution.* dotted keys.
    const skillEvolution = buildSkillEvolution(cfg);
    const dreamingConfig = buildDreamingConfig(cfg);
    const nightlyConfig = buildNightlyConfig(cfg);
    const memoryConfig = buildMemoryConfig(cfg);
    const mcpExport = buildMcpExportConfig(cfg);
    const outboundPolicy = buildOutboundPolicy(cfg);
    const voice = buildVoiceConfig(cfg);

    const model = buildModelConfig(cfg);

    const config: PersonalityConfig = {
      id,
      name: cfg.name ?? titleCase(id),
      description: cfg.description,
      model,
      provider: cfg.provider,
      platform: cfg.platform,
      ...(capabilities?.length ? { capabilities } : {}),
      soulFile: join(dir, 'SOUL.md'),
      ...(skillsExists ? { skillsDirs: [join(dir, 'skills')] } : {}),
      ...(toolsetSrc ? { toolset: parseToolsetYaml(toolsetSrc) } : {}),
      ...(streamingTimeoutMs !== undefined ? { streamingTimeoutMs } : {}),
      ...(fsReach ? { fs_reach: fsReach } : {}),
      ...(mcpServers !== undefined ? { mcp_servers: mcpServers } : {}),
      ...(plugins !== undefined ? { plugins } : {}),
      ...(budgetCapUsd !== undefined ? { budgetCapUsd } : {}),
      ...(safety !== undefined ? { safety } : {}),
      ...(contextLayering !== undefined ? { context_layering: contextLayering } : {}),
      ...(contextEngine !== undefined ? { context_engine: contextEngine } : {}),
      ...(contextEngineOptions !== undefined
        ? { context_engine_options: contextEngineOptions }
        : {}),
      ...(skillEvolution !== undefined ? { skill_evolution: skillEvolution } : {}),
      ...(dreamingConfig !== undefined ? { dreaming: dreamingConfig } : {}),
      ...(nightlyConfig !== undefined ? { nightly: nightlyConfig } : {}),
      ...(memoryConfig !== undefined ? { memory: memoryConfig } : {}),
      ...(mcpExport !== undefined ? { mcp_export: mcpExport } : {}),
      ...(outboundPolicy !== undefined ? { outbound_policy: outboundPolicy } : {}),
      ...(evolutionApprovalMode !== undefined
        ? { evolution_approval_mode: evolutionApprovalMode }
        : {}),
      ...(voice !== undefined ? { voice } : {}),
    };

    validateUnsafeCombinations(id, config);
    let mcpPolicy: import('@ethosagent/types').McpPolicy | undefined;
    let mcpWarnings: string[] | undefined;
    if (mcpSrc) {
      const parsed = parseMcpYaml(mcpSrc);
      mcpPolicy = parsed.policy;
      if (parsed.warnings.length > 0) mcpWarnings = parsed.warnings;
    }
    let toolsConfig: PersonalityToolsConfig | undefined;
    if (toolsSrc) {
      const parsed = parseToolsYaml(toolsSrc);
      if (parsed.web_search) toolsConfig = parsed;
    }
    return { config, mcpPolicy, mcpWarnings, toolsConfig };
  }

  private async fileFingerprint(paths: string[]): Promise<string> {
    const parts = await Promise.all(
      paths.map(async (p) => {
        const t = await this.storage.mtime(p);
        return t === null ? 'missing' : String(t);
      }),
    );
    return parts.join('|');
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function createPersonalityRegistry(
  storageOrOpts: Storage | { storage: Storage; userPersonalitiesDir?: string },
): Promise<FilePersonalityRegistry> {
  // Two accepted shapes: a bare Storage, or { storage, userPersonalitiesDir }
  // to enable CRUD. Storage is required either way — the composition root
  // injects it; the registry never falls back to raw disk.
  let storage: Storage;
  let userDir: string | undefined;
  if (isStorageLike(storageOrOpts)) {
    storage = storageOrOpts;
  } else {
    storage = storageOrOpts.storage;
    userDir = storageOrOpts.userPersonalitiesDir;
  }
  const registry = new FilePersonalityRegistry(storage, userDir);
  await registry.loadBuiltins();
  return registry;
}

function isStorageLike(v: unknown): v is Storage {
  return (
    !!v &&
    typeof v === 'object' &&
    typeof (v as { read?: unknown }).read === 'function' &&
    typeof (v as { write?: unknown }).write === 'function'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function expressionRevNumber(s: string): number {
  const m = /(\d+)$/.exec(s);
  return m ? Number.parseInt(m[1], 10) : 0;
}

function buildContextLayering(
  cfg: Record<string, string>,
): PersonalityConfig['context_layering'] | undefined {
  const mode = cfg['context_layering.mode'];
  const maxDepth = cfg['context_layering.max_depth'];
  const discovery = cfg['context_layering.discovery_files'];
  const cap = cfg['context_layering.cap_total_chars'];
  if (!mode && !maxDepth && !discovery && !cap) return undefined;
  const out: NonNullable<PersonalityConfig['context_layering']> = {};
  if (mode) {
    if (mode !== 'static' && mode !== 'progressive' && mode !== 'off') {
      throw new Error(
        `Invalid context_layering.mode: "${mode}". Expected one of: static, progressive, off`,
      );
    }
    out.mode = mode;
  }
  if (maxDepth && /^\d+$/.test(maxDepth)) out.max_depth = Number.parseInt(maxDepth, 10);
  if (discovery) {
    const list = discovery
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (list.length > 0) out.discovery_files = list;
  }
  if (cap && /^\d+$/.test(cap)) out.cap_total_chars = Number.parseInt(cap, 10);
  return out;
}

function buildSkillEvolution(
  cfg: Record<string, string>,
): PersonalityConfig['skill_evolution'] | undefined {
  const enabled = cfg['skill_evolution.enabled'];
  const minToolCalls = cfg['skill_evolution.min_tool_calls'];
  const cooldown = cfg['skill_evolution.cooldown_minutes'];
  const model = cfg['skill_evolution.model'];
  const evolveExisting = cfg['skill_evolution.evolve_existing'];
  const promotion = cfg['skill_evolution.promotion'];
  const scope = cfg['skill_evolution.scope'];
  if (!enabled && !minToolCalls && !cooldown && !model && !evolveExisting && !promotion && !scope) {
    return undefined;
  }
  const out: NonNullable<PersonalityConfig['skill_evolution']> = {};
  if (enabled === 'true') out.enabled = true;
  else if (enabled === 'false') out.enabled = false;
  if (minToolCalls && /^\d+$/.test(minToolCalls)) {
    out.min_tool_calls = Number.parseInt(minToolCalls, 10);
  }
  if (cooldown && /^\d+$/.test(cooldown)) {
    out.cooldown_minutes = Number.parseInt(cooldown, 10);
  }
  if (model) out.model = model;
  if (evolveExisting === 'true') out.evolve_existing = true;
  else if (evolveExisting === 'false') out.evolve_existing = false;
  if (promotion === 'review' || promotion === 'auto') out.promotion = promotion;
  if (scope === 'personality' || scope === 'shared') out.scope = scope;
  return out;
}

function buildDreamingConfig(cfg: Record<string, string>): DreamingConfig | undefined {
  const enable = cfg['dreaming.enable'];
  if (enable !== 'true') return undefined;
  const idleMinutes = cfg['dreaming.idleMinutes'];
  const maxPerDay = cfg['dreaming.maxPerDay'];
  const prompt = cfg['dreaming.prompt'];
  const out: DreamingConfig = {
    enable: true,
    idleMinutes: idleMinutes && /^\d+$/.test(idleMinutes) ? Number.parseInt(idleMinutes, 10) : 60,
    maxPerDay: maxPerDay && /^\d+$/.test(maxPerDay) ? Number.parseInt(maxPerDay, 10) : 1,
  };
  if (prompt) out.prompt = prompt;
  return out;
}

// Parse the dotted nightly.* keys into a PersonalityConfig['nightly'] block.
// Only emits the keys actually present so absent fields fall back to their
// behavior-preserving defaults at the call sites. Returns undefined when no
// nightly.* key is set, so the personality carries no nightly block at all.
function buildNightlyConfig(cfg: Record<string, string>): PersonalityConfig['nightly'] | undefined {
  const enabled = cfg['nightly.enabled'];
  const judgeEnabled = cfg['nightly.judge.enabled'];
  const minInteractions = cfg['nightly.judge.minInteractions'];
  const expression = cfg['nightly.expression'];
  if (
    enabled === undefined &&
    judgeEnabled === undefined &&
    minInteractions === undefined &&
    expression === undefined
  ) {
    return undefined;
  }
  const out: NonNullable<PersonalityConfig['nightly']> = {};
  if (enabled !== undefined) out.enabled = enabled === 'true';
  const judge: NonNullable<NonNullable<PersonalityConfig['nightly']>['judge']> = {};
  if (judgeEnabled !== undefined) judge.enabled = judgeEnabled === 'true';
  if (minInteractions !== undefined && /^\d+$/.test(minInteractions)) {
    judge.minInteractions = Number.parseInt(minInteractions, 10);
  }
  if (judge.enabled !== undefined || judge.minInteractions !== undefined) out.judge = judge;
  if (expression !== undefined) out.expression = expression === 'true';
  return out;
}

function buildMemoryConfig(
  cfg: Record<string, string>,
): import('@ethosagent/types').PersonalityMemoryConfig | undefined {
  const provider = cfg['memory.provider'];
  if (!provider) return undefined;
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.startsWith('memory.options.')) continue;
    const subKey = key.slice('memory.options.'.length);
    if (subKey.length === 0) continue;
    if (/^-?\d+$/.test(value)) options[subKey] = Number.parseInt(value, 10);
    else if (value === 'true') options[subKey] = true;
    else if (value === 'false') options[subKey] = false;
    else options[subKey] = value;
  }
  return { provider, ...(Object.keys(options).length > 0 ? { options } : {}) };
}

/**
 * Parse the dotted `voice.*` keys into `PersonalityConfig.voice`.
 *
 * Dotted keys, not a nested block: `config.yaml` is flat by design, the flat
 * parser already reads `[\w.]+` keys, and every comparable field (`fs_reach.*`,
 * `memory.options.*`, `nightly.judge.*`) uses the same shape. Adding `voice` to
 * `NESTED_BLOCKS` would mean a second parse path, a second render path, and a
 * raw-block-preservation dance like `safety`'s — for four scalars and a string
 * map. The language map mirrors `memory.options.*`: any `voice.languages.<tag>`
 * key becomes an entry.
 *
 *   voice.tts_provider: studio
 *   voice.stt_provider: whisper-es
 *   voice.tts_voice: af_bella
 *   voice.tier: pipeline
 *   voice.model: claude-haiku-4-5
 *   voice.languages.es: ef_dora
 *
 * `voice.tts_provider` / `voice.stt_provider` name entries in the deployment's
 * `voice.tts.providers.*` / `voice.stt.providers.*` rosters. They are kept
 * verbatim — validating them here would mean this loader knew the machine's
 * config, and a name this machine lacks is a fallback at resolution time
 * (`selectTtsEntry` / `selectSttEntry`), not a load failure.
 *
 * `voice.provider` is accepted as the older spelling of `voice.tts_provider`
 * (it shipped before a personality could name an STT engine). The explicit new
 * key wins; the renderer only ever writes the new one, so a personality
 * re-saved from either spelling carries one key, not two.
 *
 * An unknown `voice.tier` is dropped rather than thrown on: a bad voice id
 * should not make a personality unloadable — it falls back to the global voice.
 */
function buildVoiceConfig(
  cfg: Record<string, string>,
): import('@ethosagent/types').PersonalityVoiceConfig | undefined {
  const ttsProvider = cfg['voice.tts_provider'] || cfg['voice.provider'];
  const sttProvider = cfg['voice.stt_provider'];
  const ttsVoice = cfg['voice.tts_voice'];
  const tier = cfg['voice.tier'];
  const model = cfg['voice.model'];
  const languages: Record<string, string> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.startsWith('voice.languages.')) continue;
    const tag = key.slice('voice.languages.'.length);
    if (tag.length > 0 && value) languages[tag] = value;
  }
  const out: import('@ethosagent/types').PersonalityVoiceConfig = {
    ...(ttsProvider ? { tts_provider: ttsProvider } : {}),
    ...(sttProvider ? { stt_provider: sttProvider } : {}),
    ...(ttsVoice ? { tts_voice: ttsVoice } : {}),
    ...(tier === 'pipeline' || tier === 'realtime' ? { tier } : {}),
    ...(model ? { model } : {}),
    ...(Object.keys(languages).length > 0 ? { languages } : {}),
  };
  return Object.keys(out).length > 0 ? out : undefined;
}

function buildOutboundPolicy(
  cfg: Record<string, string>,
): import('@ethosagent/types').OutboundPolicyConfig | undefined {
  const approve = cfg['outbound_policy.approve_before_send'];
  if (!approve) return undefined;
  const out: import('@ethosagent/types').OutboundPolicyConfig = {
    approve_before_send: approve === 'true',
  };
  const channels = cfg['outbound_policy.channels'];
  if (channels) out.channels = channels.split(/\s+/).filter(Boolean);
  const approver = cfg['outbound_policy.approver_personality'];
  if (approver) out.approver_personality = approver;
  return out;
}

function buildMcpExportConfig(
  cfg: Record<string, string>,
): import('@ethosagent/types').PersonalityMcpExportConfig | undefined {
  const enabled = cfg['mcp_export.enabled'];
  if (!enabled) return undefined;
  const out: import('@ethosagent/types').PersonalityMcpExportConfig = {
    enabled: enabled === 'true',
  };
  const tools = cfg['mcp_export.expose_tools'];
  if (tools === 'all' || tools === 'none') out.expose_tools = tools;
  else if (tools) out.expose_tools = tools.split(/\s+/).filter(Boolean);
  const memory = cfg['mcp_export.expose_memory'];
  if (memory === 'scoped' || memory === 'none' || memory === 'full') out.expose_memory = memory;
  if (cfg['mcp_export.expose_sessions'] === 'true') out.expose_sessions = true;
  if (cfg['mcp_export.expose_sessions'] === 'false') out.expose_sessions = false;
  const auth = cfg['mcp_export.auth'];
  if (auth === 'localhost' || auth === 'bearer') out.auth = auth;
  return out;
}

function buildModelConfig(cfg: Record<string, string>): string | ModelTierConfig | undefined {
  const trivial = cfg['model.trivial'];
  const defaultModel = cfg['model.default'];
  const deep = cfg['model.deep'];
  const dreaming = cfg['model.dreaming'];
  if (!trivial && !defaultModel && !deep && !dreaming) return cfg.model || undefined;
  const out: ModelTierConfig = {};
  if (trivial) out.trivial = trivial;
  if (defaultModel) out.default = defaultModel;
  if (deep) out.deep = deep;
  if (dreaming) out.dreaming = dreaming;
  return out;
}

function buildContextEngineOptions(
  cfg: Record<string, string>,
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (!key.startsWith('context_engine_options.')) continue;
    const subKey = key.slice('context_engine_options.'.length);
    if (subKey.length === 0) continue;
    if (/^-?\d+$/.test(value)) out[subKey] = Number.parseInt(value, 10);
    else if (/^-?\d+\.\d+$/.test(value)) out[subKey] = Number.parseFloat(value);
    else if (value === 'true') out[subKey] = true;
    else if (value === 'false') out[subKey] = false;
    else out[subKey] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function parseCsv(value: string | undefined): string[] | undefined {
  if (!value) return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function buildSafetyConfig(raw: Record<string, unknown>): PersonalitySafetyConfig {
  const result: PersonalitySafetyConfig = {};
  const obs = raw.observability as Record<string, unknown> | undefined;
  if (obs) {
    const validStoreValues = ['none', 'redacted', 'full'] as const;
    const validLlmValues = ['none', 'metadata', 'full'] as const;
    const observability: PersonalityObservabilityConfig = {};
    if (obs.storeToolArgs !== undefined) {
      if (!validStoreValues.includes(obs.storeToolArgs as (typeof validStoreValues)[number]))
        throw new Error(`Invalid storeToolArgs: "${obs.storeToolArgs}"`);
      observability.storeToolArgs =
        obs.storeToolArgs as PersonalityObservabilityConfig['storeToolArgs'];
    }
    if (obs.storeToolBodies !== undefined) {
      if (!validStoreValues.includes(obs.storeToolBodies as (typeof validStoreValues)[number]))
        throw new Error(`Invalid storeToolBodies: "${obs.storeToolBodies}"`);
      observability.storeToolBodies =
        obs.storeToolBodies as PersonalityObservabilityConfig['storeToolBodies'];
    }
    if (obs.storeLlmPayloads !== undefined) {
      if (!validLlmValues.includes(obs.storeLlmPayloads as (typeof validLlmValues)[number]))
        throw new Error(`Invalid storeLlmPayloads: "${obs.storeLlmPayloads}"`);
      observability.storeLlmPayloads =
        obs.storeLlmPayloads as PersonalityObservabilityConfig['storeLlmPayloads'];
    }
    if (Array.isArray(obs.redactPatterns)) {
      for (const p of obs.redactPatterns) {
        if (typeof p !== 'string') throw new Error('redactPatterns entries must be strings');
      }
      observability.redactPatterns = obs.redactPatterns as string[];
    }
    result.observability = observability;
  }

  // Ch.4b — approvalMode parsing
  if (raw.approvalMode !== undefined) {
    const mode = raw.approvalMode;
    if (mode !== 'manual' && mode !== 'smart' && mode !== 'off') {
      throw new Error(`Invalid approvalMode: "${mode}". Expected one of: manual, smart, off`);
    }
    result.approvalMode = mode;
  }

  // Ch.4b — denyRules parsing. Same posture as approvalMode above: a malformed
  // value throws at load rather than being dropped, because a safety field that
  // silently accepts garbage reads as protection while gating nothing.
  //
  // Empty and whitespace-only entries are rejected because of how
  // `matchDenyRule` (packages/wiring/src/danger-predicate.ts) matches: a rule is
  // a substring of `${toolName} ${canonical-json-args}`, guarded by
  // `rule.length > 0`. So `""` can never match (a silent no-op rule) and `" "`
  // matches every call (the subject always contains a space). Both are config
  // mistakes worth catching at load.
  if (raw.denyRules !== undefined) {
    const rules = raw.denyRules;
    if (!Array.isArray(rules)) {
      throw new Error(
        `Invalid denyRules: ${JSON.stringify(rules)}. Expected a list of match strings`,
      );
    }
    const denyRules: string[] = [];
    for (const rule of rules) {
      if (typeof rule !== 'string') {
        throw new Error(
          `Invalid denyRules entry: ${JSON.stringify(rule)}. Every entry must be a string`,
        );
      }
      if (rule.trim() === '') {
        throw new Error('Invalid denyRules entry: empty rule. Every entry must be non-empty');
      }
      denyRules.push(rule);
    }
    result.denyRules = denyRules;
  }

  const asp = raw.allowed_skill_permissions as Record<string, unknown> | undefined;
  if (asp) {
    const out: NonNullable<PersonalitySafetyConfig['allowed_skill_permissions']> = {};
    for (const cat of ['fs_read', 'fs_write', 'network', 'mcp_env_passthrough'] as const) {
      const v = nestedListOrBool(asp[cat]);
      if (v !== undefined) out[cat] = v;
    }
    if (Object.keys(out).length > 0) result.allowed_skill_permissions = out;
  }

  const net = raw.network as Record<string, unknown> | undefined;
  if (net) {
    const out: NonNullable<PersonalitySafetyConfig['network']> = {};
    if (Array.isArray(net.allow)) out.allow = net.allow.map(String);
    if (Array.isArray(net.deny)) out.deny = net.deny.map(String);
    const priv = nestedBool(net.allow_private_urls);
    if (priv !== undefined) out.allow_private_urls = priv;
    if (Object.keys(out).length > 0) result.network = out;
  }

  const inj = raw.injectionDefense as Record<string, unknown> | undefined;
  if (inj) {
    const out: NonNullable<PersonalitySafetyConfig['injectionDefense']> = {};
    const classifier = inj.classifier as Record<string, unknown> | undefined;
    if (classifier) {
      const alwaysCallLLM = nestedBool(classifier.alwaysCallLLM);
      if (alwaysCallLLM !== undefined) out.classifier = { alwaysCallLLM };
    }
    const prd = inj.postReadDowngrade as Record<string, unknown> | undefined;
    if (prd) {
      const downgrade: NonNullable<
        NonNullable<PersonalitySafetyConfig['injectionDefense']>['postReadDowngrade']
      > = {};
      const dEnabled = nestedBool(prd.enabled);
      if (dEnabled !== undefined) downgrade.enabled = dEnabled;
      const turns = nestedInt(prd.turns);
      if (turns !== undefined) downgrade.turns = turns;
      if (prd.tools === 'auto') downgrade.tools = 'auto';
      else if (Array.isArray(prd.tools)) downgrade.tools = prd.tools.map(String);
      if (Object.keys(downgrade).length > 0) out.postReadDowngrade = downgrade;
    }
    const blockSecretResults = nestedBool(inj.blockSecretResults);
    if (blockSecretResults !== undefined) out.blockSecretResults = blockSecretResults;
    const toolResultDelimiters = nestedBool(inj.toolResultDelimiters);
    if (toolResultDelimiters !== undefined) out.toolResultDelimiters = toolResultDelimiters;
    if (Object.keys(out).length > 0) result.injectionDefense = out;
  }

  const pii = raw.piiRedaction as Record<string, unknown> | undefined;
  if (pii) {
    const enabled = nestedBool(pii.enabled);
    if (enabled !== undefined) {
      const out: NonNullable<PersonalitySafetyConfig['piiRedaction']> = { enabled };
      if (Array.isArray(pii.extraPatterns)) out.extraPatterns = pii.extraPatterns.map(String);
      result.piiRedaction = out;
    }
  }
  return result;
}

/** Coerce a nested-block scalar to a boolean. Returns undefined when the value
 *  is absent or not a recognized boolean string. */
function nestedBool(v: unknown): boolean | undefined {
  if (v === 'true') return true;
  if (v === 'false') return false;
  return undefined;
}

/** Coerce a nested-block scalar to an integer, or undefined when not numeric. */
function nestedInt(v: unknown): number | undefined {
  return typeof v === 'string' && /^\d+$/.test(v) ? Number.parseInt(v, 10) : undefined;
}

/** A skill-permission category is either a string list or a boolean toggle. */
function nestedListOrBool(v: unknown): string[] | boolean | undefined {
  if (Array.isArray(v)) return v.map(String);
  return nestedBool(v);
}

// Ch.4b — load-time refusal of unsafe combinations (v1 floor).
//
// `approvalMode: off` paired with a channel-ingress platform is the
// catastrophic combination — a stranger or allowlisted remote user
// can drive auto-approved destructive actions. We refuse it at config
// load.
//
// **v1 limitation.** This check matches a hardcoded set of platform
// strings on `personality.platform`. A new channel adapter or a
// multi-channel binding wired solely at the gateway layer will not be
// caught here. The plan-tracked v2 lifts this check up to the wiring
// layer (which knows which surfaces actually bind the personality)
// and replaces the string match with a typed "ingress capability"
// flag. Until then, every channel-adapter package adding a new
// platform name is responsible for adding it to the set below — the
// alternative (silent bypass) is the worse failure mode.
const CHANNEL_INGRESS_PLATFORMS: ReadonlySet<string> = new Set([
  'telegram',
  'discord',
  'slack',
  'whatsapp',
  'email',
]);

function validateUnsafeCombinations(id: string, config: PersonalityConfig): void {
  const mode = config.safety?.approvalMode;
  if (mode === 'off' && config.platform && CHANNEL_INGRESS_PLATFORMS.has(config.platform)) {
    throw new Error(
      `personality "${id}" has approvalMode: off but is bound to channel "${config.platform}".\n` +
        '       Remote senders + auto-approve = remote-driven destructive actions.\n' +
        "       Either: (a) move approvalMode to 'smart' or 'manual', or\n" +
        '               (b) remove channel bindings from this personality (cli/cron only).\n' +
        '       This combination is not configurable; it is rejected at config load.',
    );
  }
}

function yamlScalar(value: string): string {
  if (/[:\n\r#[\]{}&*!|>'"%@`]/.test(value) || value.trim() !== value) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Fields `renderConfigYaml` can emit. A superset of the user-settable
 * `CreatePersonalityInput` and the full `PersonalityConfig` so `update()` can
 * round-trip the entire existing config losslessly. Loader-populated fields
 * (`id`, `soulFile`, `skillsDirs`) and `soulMd` are intentionally excluded —
 * they are not part of config.yaml.
 */
type RenderConfigInput = Omit<CreatePersonalityInput, 'id' | 'soulMd'> &
  Pick<
    PersonalityConfig,
    | 'platform'
    | 'streamingTimeoutMs'
    | 'budgetCapUsd'
    | 'safety'
    | 'context_engine'
    | 'context_engine_options'
    | 'context_layering'
    | 'memory'
    | 'mcp_export'
    | 'outbound_policy'
    | 'voice'
  >;

function renderConfigYaml(input: RenderConfigInput): string {
  const lines: string[] = [`name: ${yamlScalar(input.name)}`];
  if (input.description) lines.push(`description: ${yamlScalar(input.description)}`);
  if (input.provider) lines.push(`provider: ${yamlScalar(input.provider)}`);
  if (input.platform) lines.push(`platform: ${yamlScalar(input.platform)}`);
  if (input.model) {
    if (typeof input.model === 'string') {
      lines.push(`model: ${yamlScalar(input.model)}`);
    } else {
      if (input.model.trivial) lines.push(`model.trivial: ${yamlScalar(input.model.trivial)}`);
      if (input.model.default) lines.push(`model.default: ${yamlScalar(input.model.default)}`);
      if (input.model.deep) lines.push(`model.deep: ${yamlScalar(input.model.deep)}`);
      if (input.model.dreaming) lines.push(`model.dreaming: ${yamlScalar(input.model.dreaming)}`);
    }
  }
  if (input.capabilities !== undefined && input.capabilities.length > 0) {
    lines.push(`capabilities: ${input.capabilities.map(yamlScalar).join(', ')}`);
  }
  if (input.mcp_servers !== undefined)
    lines.push(`mcp_servers: ${input.mcp_servers.map(yamlScalar).join(' ')}`);
  if (input.plugins !== undefined)
    lines.push(`plugins: ${input.plugins.map(yamlScalar).join(' ')}`);
  if (input.fs_reach?.read !== undefined && input.fs_reach.read.length > 0) {
    lines.push(`fs_reach.read: ${input.fs_reach.read.join(', ')}`);
  }
  if (input.fs_reach?.write !== undefined && input.fs_reach.write.length > 0) {
    lines.push(`fs_reach.write: ${input.fs_reach.write.join(', ')}`);
  }
  if (input.fs_reach?.workdir) {
    lines.push(`fs_reach.workdir: ${input.fs_reach.workdir}`);
  }
  if (input.streamingTimeoutMs !== undefined) {
    lines.push(`streamingTimeoutMs: ${input.streamingTimeoutMs}`);
  }
  if (input.budgetCapUsd !== undefined) lines.push(`budgetCapUsd: ${input.budgetCapUsd}`);
  if (input.context_engine !== undefined) {
    lines.push(`context_engine: ${yamlScalar(input.context_engine)}`);
  }
  if (input.context_engine_options !== undefined) {
    for (const [k, v] of Object.entries(input.context_engine_options)) {
      lines.push(`context_engine_options.${k}: ${renderScalarValue(v)}`);
    }
  }
  if (input.context_layering !== undefined) {
    const cl = input.context_layering;
    if (cl.mode !== undefined) lines.push(`context_layering.mode: ${cl.mode}`);
    if (cl.max_depth !== undefined) lines.push(`context_layering.max_depth: ${cl.max_depth}`);
    if (cl.discovery_files !== undefined) {
      lines.push(`context_layering.discovery_files: ${cl.discovery_files.join(', ')}`);
    }
    if (cl.cap_total_chars !== undefined) {
      lines.push(`context_layering.cap_total_chars: ${cl.cap_total_chars}`);
    }
  }
  if (input.skill_evolution) {
    const se = input.skill_evolution;
    if (se.enabled !== undefined) lines.push(`skill_evolution.enabled: ${se.enabled}`);
    if (se.min_tool_calls !== undefined)
      lines.push(`skill_evolution.min_tool_calls: ${se.min_tool_calls}`);
    if (se.cooldown_minutes !== undefined)
      lines.push(`skill_evolution.cooldown_minutes: ${se.cooldown_minutes}`);
    if (se.model !== undefined) lines.push(`skill_evolution.model: ${yamlScalar(se.model)}`);
    if (se.evolve_existing !== undefined)
      lines.push(`skill_evolution.evolve_existing: ${se.evolve_existing}`);
    if (se.promotion !== undefined) lines.push(`skill_evolution.promotion: ${se.promotion}`);
    if (se.scope !== undefined) lines.push(`skill_evolution.scope: ${se.scope}`);
  }
  if (input.memory !== undefined) {
    lines.push(`memory.provider: ${yamlScalar(input.memory.provider)}`);
    if (input.memory.options !== undefined) {
      for (const [k, v] of Object.entries(input.memory.options)) {
        lines.push(`memory.options.${k}: ${renderScalarValue(v)}`);
      }
    }
  }
  if (input.mcp_export !== undefined) {
    const me = input.mcp_export;
    lines.push(`mcp_export.enabled: ${me.enabled}`);
    if (me.expose_tools !== undefined) {
      const tools = Array.isArray(me.expose_tools) ? me.expose_tools.join(' ') : me.expose_tools;
      lines.push(`mcp_export.expose_tools: ${tools}`);
    }
    if (me.expose_memory !== undefined) lines.push(`mcp_export.expose_memory: ${me.expose_memory}`);
    if (me.expose_sessions !== undefined) {
      lines.push(`mcp_export.expose_sessions: ${me.expose_sessions}`);
    }
    if (me.auth !== undefined) lines.push(`mcp_export.auth: ${me.auth}`);
  }
  if (input.outbound_policy !== undefined) {
    const op = input.outbound_policy;
    lines.push(`outbound_policy.approve_before_send: ${op.approve_before_send}`);
    if (op.channels !== undefined) {
      lines.push(`outbound_policy.channels: ${op.channels.join(' ')}`);
    }
    if (op.approver_personality !== undefined) {
      lines.push(`outbound_policy.approver_personality: ${yamlScalar(op.approver_personality)}`);
    }
  }
  if (input.dreaming !== undefined) {
    const d = input.dreaming;
    lines.push(`dreaming.enable: ${d.enable}`);
    if (d.idleMinutes !== undefined) lines.push(`dreaming.idleMinutes: ${d.idleMinutes}`);
    if (d.maxPerDay !== undefined) lines.push(`dreaming.maxPerDay: ${d.maxPerDay}`);
    if (d.prompt !== undefined) lines.push(`dreaming.prompt: ${yamlScalar(d.prompt)}`);
  }
  if (input.nightly !== undefined) {
    const n = input.nightly;
    if (n.enabled !== undefined) lines.push(`nightly.enabled: ${n.enabled}`);
    if (n.judge?.enabled !== undefined) lines.push(`nightly.judge.enabled: ${n.judge.enabled}`);
    if (n.judge?.minInteractions !== undefined) {
      lines.push(`nightly.judge.minInteractions: ${n.judge.minInteractions}`);
    }
    if (n.expression !== undefined) lines.push(`nightly.expression: ${n.expression}`);
  }
  if (input.evolution_approval_mode !== undefined) {
    lines.push(`evolution_approval_mode: ${yamlScalar(input.evolution_approval_mode)}`);
  }
  if (input.voice !== undefined) {
    const v = input.voice;
    // Always the NEW spelling — a personality read from `voice.provider` is
    // written back as `voice.tts_provider`, never both.
    if (v.tts_provider !== undefined) {
      lines.push(`voice.tts_provider: ${yamlScalar(v.tts_provider)}`);
    }
    if (v.stt_provider !== undefined) {
      lines.push(`voice.stt_provider: ${yamlScalar(v.stt_provider)}`);
    }
    if (v.tts_voice !== undefined) lines.push(`voice.tts_voice: ${yamlScalar(v.tts_voice)}`);
    if (v.tier !== undefined) lines.push(`voice.tier: ${v.tier}`);
    if (v.model !== undefined) lines.push(`voice.model: ${yamlScalar(v.model)}`);
    for (const [tag, id] of Object.entries(v.languages ?? {})) {
      lines.push(`voice.languages.${tag}: ${yamlScalar(id)}`);
    }
  }
  if (input.safety !== undefined && Object.keys(input.safety).length > 0) {
    lines.push('safety:');
    lines.push(...renderNestedBlock(input.safety as Record<string, unknown>, 1));
  }
  return `${lines.join('\n')}\n`;
}

/** Render a scalar config value (string/number/boolean) for a dotted key. */
function renderScalarValue(v: unknown): string {
  if (typeof v === 'string') return yamlScalar(v);
  return String(v);
}

/**
 * Emit a nested object block (the inverse of `parseNestedBlock`) at the given
 * indent depth (2 spaces per level). Mirrors the parser's value handling:
 * scalars inline, string arrays as `- item` lists, and nested objects
 * recursively. Used for `safety:`.
 */
function renderNestedBlock(obj: Record<string, unknown>, depth: number): string[] {
  const pad = '  '.repeat(depth);
  const out: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      out.push(`${pad}${key}:`);
      for (const item of value) out.push(`${pad}  - ${renderScalarValue(item)}`);
    } else if (value !== null && typeof value === 'object') {
      out.push(`${pad}${key}:`);
      out.push(...renderNestedBlock(value as Record<string, unknown>, depth + 1));
    } else {
      out.push(`${pad}${key}: ${renderScalarValue(value)}`);
    }
  }
  return out;
}

function renderToolsetYaml(toolset: string[]): string {
  if (toolset.length === 0) return '# No tools enabled — agent runs without external action.\n';
  return `${toolset.map((t) => `- ${t}`).join('\n')}\n`;
}

async function copyTree(storage: Storage, source: string, dest: string): Promise<void> {
  await storage.mkdir(dest);
  const entries = await storage.listEntries(source);
  for (const entry of entries) {
    const sp = join(source, entry.name);
    const dp = join(dest, entry.name);
    if (entry.isDir) {
      await copyTree(storage, sp, dp);
    } else {
      const content = await storage.read(sp);
      if (content !== null) await storage.write(dp, content);
    }
  }
}
