import {
  type ConstitutionEnforcement,
  type ExecutionPosture,
  type PersonalityConfig,
  resolveModelDisplay,
} from '@ethosagent/types';
import { parseLivingSoul } from './living-soul';

// The generated character sheet — the "tight character sheet" promise from
// SOUL.md made into a real artifact. One Markdown screen per personality:
// what it is, what it has, what it can reach. Regenerated on demand from
// the personality's config + SOUL.md; never stored. The CLI
// (`ethos personality show`) and the Web Personalities tab both render
// this single source.

/**
 * The prose directly under the SOUL.md title — the personality's own
 * voice describing who it is. Returns `''` when the document has no body
 * paragraph (heading-only or empty file). Exported so surfaces that build
 * their own character-sheet rendering (e.g. the Slack `/ethos personality
 * rich` card) extract the identity line the same way the canonical sheet
 * does.
 */
export function firstParagraph(soulMd: string): string {
  const para: string[] = [];
  for (const line of soulMd.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // skip heading lines
    if (trimmed === '') {
      if (para.length > 0) break; // blank line closes the first paragraph
      continue; // skip leading blank lines
    }
    para.push(trimmed);
  }
  return para.join(' ');
}

function bulletList(items: readonly string[], emptyLabel: string): string[] {
  if (items.length === 0) return [`- ${emptyLabel}`];
  return items.map((item) => `- ${item}`);
}

// Rough char/4 token estimate for the injection-defense prelude — a static
// system-prompt component the character sheet cannot see directly. Kept as a
// constant so the estimate approximates the assembled prompt without pulling in
// a cross-package dependency on @ethosagent/safety-injection.
const PRELUDE_TOKEN_ESTIMATE = 340;

/**
 * Estimate the assembled system-prompt token count from the components the
 * character sheet already carries: the injection prelude, SOUL.md, and the
 * toolset names. char/4 rule of thumb — deliberately an under-estimate (no tool
 * schemas, no memory), labeled `~` in the sheet.
 */
function estimateSystemPromptTokens(soulMd: string, toolset: readonly string[]): number {
  const chars = soulMd.length + toolset.join(', ').length;
  return PRELUDE_TOKEN_ESTIMATE + Math.ceil(chars / 4);
}

/**
 * Lane 6 (eng review D5/D19) — the arithmetic model-fit verdict, as PLAIN DATA.
 * Computed by `computeModelFit()` in `@ethosagent/wiring` (which can see the
 * tool registry, the provider, and the window resolution) and passed in here;
 * the personalities package never reaches up into wiring. One generator renders
 * it for both the CLI (`ethos personality show`) and the
 * `personalities.characterSheet` RPC.
 */
export interface CharacterSheetModelFit {
  verdict: 'fits' | 'fits-degraded' | 'refuses' | 'unknown';
  /** Model the verdict was computed against. */
  model: string;
  /** Resolved served window in tokens. Absent → unresolved (verdict `unknown`);
   *  the verdict is NEVER computed against the 128,000-token default (D19). */
  windowTokens?: number;
  /** Where the window number came from. `default` = nothing resolved. */
  windowSource: 'config' | 'probe' | 'catalog' | 'default';
  /** Static-floor breakdown from `measureStaticFloor()` — serialized tool-schema
   *  size, not toolset name count (D8). */
  floor: {
    tokens: number;
    toolCount: number;
    components: Array<{ name: string; tokens: number }>;
  };
  outputReserveTokens?: number;
  /** `window − output reserve − static floor`; ≤ 0 → `refuses`. */
  compactibleTokens?: number;
  /** `floor.tokens / windowTokens`, when the window is known. */
  staticShare?: number;
  /** Named arithmetic costs in effect (small-window mode, narrowed toolset,
   *  static share over the budget ratio). Non-empty → `fits-degraded`. */
  degradations: string[];
  /** The Lane 1(b) diagnostic — set on `refuses`, names the largest component. */
  refusalReason?: string;
  /** What the arithmetic could not see (MCP schemas, tier models). */
  exclusions: string[];
}

/** Render the `## Model fit` block. Pure — takes the computed verdict data. */
function modelFitSection(fit: CharacterSheetModelFit): string[] {
  const n = (v: number) => v.toLocaleString('en-US');
  const lines: string[] = ['## Model fit'];
  lines.push(`- Verdict: ${fit.verdict}`);
  lines.push(`- Model: ${fit.model}`);
  // D19 — every verdict prints its inputs: the window and its source. An
  // unresolved window prints "unknown", never a fallback number.
  if (fit.windowTokens !== undefined) {
    lines.push(`- Window: ${n(fit.windowTokens)} tokens (source: ${fit.windowSource})`);
  } else {
    lines.push(
      '- Window: unknown (no config, no probe, no catalog — verdict not computed against the default)',
    );
  }
  lines.push(
    `- Static floor: ${n(fit.floor.tokens)} tokens (${fit.floor.toolCount} tool schema${
      fit.floor.toolCount === 1 ? '' : 's'
    }):`,
  );
  for (const comp of fit.floor.components) {
    lines.push(`    - ${comp.name}: ${n(comp.tokens)} tokens`);
  }
  if (fit.outputReserveTokens !== undefined) {
    lines.push(`- Output reserve: ${n(fit.outputReserveTokens)} tokens`);
  }
  if (fit.compactibleTokens !== undefined) {
    lines.push(`- Compactible: ${n(fit.compactibleTokens)} tokens`);
  }
  if (fit.staticShare !== undefined) {
    lines.push(`- Static share of window: ${Math.round(fit.staticShare * 100)}%`);
  }
  if (fit.degradations.length > 0) {
    lines.push('- Degradations:');
    for (const d of fit.degradations) lines.push(`    - ${d}`);
  }
  if (fit.refusalReason) lines.push(`- Refusal: ${fit.refusalReason}`);
  if (fit.exclusions.length > 0) {
    lines.push('- Exclusions:');
    for (const e of fit.exclusions) lines.push(`    - ${e}`);
  }
  return lines;
}

/**
 * Optional context for the `## Execution` section. The renderer is pure: it
 * formats whatever posture the caller resolved (via the wiring posture
 * resolver) and the constitution enforcement it loaded. When `posture` is
 * absent the section is omitted entirely (e.g. surfaces that don't resolve
 * execution).
 */
export interface CharacterSheetExecution {
  posture: ExecutionPosture;
  /** Operator constitution enforcement — surfaces clamp notices for this id. */
  enforcement?: ConstitutionEnforcement;
  /**
   * Host platform exec will run on (`process.platform`). Drives the #7 macOS
   * caveat. Injectable for tests; defaults to the current platform.
   */
  platform?: NodeJS.Platform;
}

const POSTURE_LABEL: Record<ExecutionPosture['backend'], string> = {
  docker: 'docker (sandboxed)',
  local: 'local (un-sandboxed — runs in this process)',
  ssh: 'ssh (remote host)',
  none: 'none (no execution backend)',
};

/** Render the `## Execution` block. Pure — takes the resolved posture + context. */
function executionSection(config: PersonalityConfig, exec: CharacterSheetExecution): string[] {
  const { posture, enforcement } = exec;
  const platform = exec.platform ?? process.platform;
  const lines: string[] = ['## Execution'];

  let postureLabel: string;
  if (posture.containerized) {
    postureLabel = 'containerized (local)';
  } else if (posture.hostFallback) {
    // F1/P2 — a sandbox/remote backend was wanted but unavailable; execution
    // honestly runs on the host. Never claim "Sandboxed · Docker" or
    // "ssh (remote host)" while running un-sandboxed on the host.
    postureLabel =
      posture.hostFallback.reason === 'ssh-unavailable'
        ? 'local (un-sandboxed — runs on host; ssh backend unavailable)'
        : 'local (un-sandboxed — runs on host; Docker unavailable)';
  } else {
    postureLabel = POSTURE_LABEL[posture.backend];
  }
  lines.push(`- Posture:    ${postureLabel}`);
  lines.push(`- Network:    ${posture.networkMode}`);
  lines.push(`- Memory cap: ${posture.memoryMb} MB`);

  // Mounts + the ${CWD} blast radius (A7): the rw mount roots are the writable
  // host paths a shell escape could damage.
  if (posture.backend === 'docker') {
    if (posture.mounts.length > 0) {
      lines.push(`- Mounts (${posture.mounts.length}):`);
      for (const m of posture.mounts) {
        lines.push(`    - ${m.hostPath} (${m.mode})`);
      }
    } else {
      lines.push('- Mounts:     (default — personality directory + cwd)');
    }
    for (const scratch of posture.scratchPaths) {
      lines.push(`    - ${scratch} (ephemeral scratch, wiped on exit)`);
    }
    const rwRoots = posture.mounts.filter((m) => m.mode === 'rw').map((m) => m.hostPath);
    lines.push(
      `- Write blast radius (A7): ${
        rwRoots.length > 0 ? rwRoots.join(', ') : '(none — read-only mounts)'
      }`,
    );
  }

  // Containerized note (mirrors the honest trade in the plan).
  if (posture.containerized) {
    lines.push(
      '- Containerized: isolation boundary = the Ethos container; fs_reach + network',
      '  enforced app-layer only, shared across personalities in this process.',
    );
  }

  // ssh relabel (A3) — remote-host trust, NOT mount-confinement.
  if (posture.backend === 'ssh') {
    lines.push('- Note (A3): ssh = remote-host trust — NOT mount-confined.');
    // P2 — a `backend: 'ssh'` posture only survives resolution when NO ssh
    // backend is wired AND the constitution forbids the local host fallback.
    // Be honest: exec tools refuse rather than silently run on the host.
    lines.push(
      '- Note (P2): no ssh execution backend is wired in this build; the constitution',
      '  forbids the un-sandboxed host fallback, so execution tools refuse (not_available).',
    );
  }

  // #7 macOS caveat — docker on macOS is best-effort, not a hard boundary.
  if (posture.backend === 'docker' && platform === 'darwin') {
    lines.push(
      '- macOS (#7): boundary is best-effort via Docker Desktop’s VM —',
      '  best-effort, NOT a hard security boundary. Rootless/gVisor is deferred.',
    );
  }

  // F1 honest host fallback — Docker wanted but disabled/unavailable in this
  // process, constitution permits local, so execution runs un-sandboxed on the
  // host. Surfaced so the UI never claims a sandbox it doesn't have.
  if (posture.hostFallback) {
    let why: string;
    let tag: string;
    if (posture.hostFallback.reason === 'docker-disabled') {
      why = 'Docker execution is disabled in this process';
      tag = 'F1';
    } else if (posture.hostFallback.reason === 'ssh-unavailable') {
      why = 'no ssh execution backend is wired in this build';
      tag = 'P2';
    } else {
      why = 'the Docker daemon is unavailable';
      tag = 'F1';
    }
    lines.push(
      `- Host fallback (${tag}): ${why}; running un-sandboxed on the host (constitution permits local).`,
    );
  }

  // A1 docker-absent decision state — surfaced, never a silent fallback.
  if (posture.dockerAbsent) {
    lines.push('- Docker required but not running (A1):');
    lines.push('    - Option: install/start Docker');
    if (posture.dockerAbsent.canConsentLocal) {
      lines.push('    - Option: run un-sandboxed on host (explicit consent required)');
    } else {
      lines.push(
        `    - Un-sandboxed consent withheld: ${
          posture.dockerAbsent.consentForbiddenReason ?? 'forbidden by the constitution'
        }`,
      );
    }
  }

  // Constitution clamp notices (from D1 enforcement) for THIS personality.
  const clamps = (enforcement?.clamps ?? []).filter((c) => c.personalityId === config.id);
  for (const clamp of clamps) {
    lines.push(`- Constitution clamp: ${clamp.field} ${clamp.declared} → ${clamp.clamped}`);
  }

  return lines;
}

/**
 * tools-as-code-api Lane G — the script-callable tool surface, as PLAIN DATA.
 * Computed by callers via `scriptCallableFor()` from `@ethosagent/core` — the
 * SAME derivation the ScriptToolBridge enforces, so the displayed surface
 * cannot drift from the enforced one. Passed in like `CharacterSheetModelFit`:
 * the personalities package never reaches into core/wiring for a registry.
 * Absent (no live tool registry at the call site) → the line is omitted,
 * mirroring the fail-soft `## Model fit` behaviour.
 */
export interface CharacterSheetScriptSurface {
  /** Sorted tool names from `scriptCallableFor(personality, registry)`. */
  callable: readonly string[];
}

/**
 * What each known renderer name means in prose, so the sheet says more than an
 * opaque `echarts@1`. A renderer with no entry prints its bare spec string —
 * the declaration is honest either way, and a surface that maps no renderer of
 * that name simply renders the fence as a code block.
 */
const RENDERER_NOTE: Record<string, string> = {
  echarts: 'interactive charts — via charts skill',
};

/** `echarts@1` → `echarts@1 (interactive charts — via charts skill)`. */
function renderSpecLabel(spec: string): string {
  const note = RENDERER_NOTE[spec.split('@')[0] ?? ''];
  return note ? `${spec} (${note})` : spec;
}

/**
 * Render a personality's character sheet as Markdown. Pure — takes the
 * loaded config and the SOUL.md body, returns the artifact. Optional
 * fields render as explicit `(none)` / `(engine default)` states so a
 * reader never has to guess whether a blank means "unset" or "missing".
 *
 * `renderers` is the skill-declared output capability (`ethos.renders`), as
 * PLAIN DATA — computed by callers via `SkillsInjector.resolveRenderers()`,
 * the SAME derivation the surfaces gate on, so the sheet cannot claim a
 * capability the renderer path would refuse. Absent or empty → no line.
 */
export function renderCharacterSheet(
  config: PersonalityConfig,
  soulMd: string,
  execution?: CharacterSheetExecution,
  modelFit?: CharacterSheetModelFit,
  scriptSurface?: CharacterSheetScriptSurface,
  renderers?: readonly string[],
): string {
  const lines: string[] = [`# ${config.id} — ${config.name}`, ''];

  if (config.description) lines.push(config.description, '');

  const prose = firstParagraph(soulMd);
  if (prose) lines.push(prose, '');

  lines.push('## Routing');
  lines.push(`- Model: ${resolveModelDisplay(config.model, '(engine default)')}`);
  lines.push(`- Provider: ${config.provider ?? '(engine default)'}`);
  lines.push(`- Dreaming: ${config.dreaming?.enable ? 'on' : 'off'}`);
  lines.push('');

  // Output capability, derived from the skill set rather than the personality
  // schema: a skill declaring `ethos.renders` both TEACHES the fence format and
  // UNLOCKS the renderer, so one declaration drives both. It joins the declared
  // capabilities rather than following them, so `(none)` still means "nothing
  // here" instead of sitting above a line that contradicts it.
  const capabilities = [...(config.capabilities ?? [])];
  if (renderers && renderers.length > 0) {
    capabilities.push(`Renders: ${renderers.map(renderSpecLabel).join(', ')}`);
  }
  lines.push('## Capabilities');
  lines.push(...bulletList(capabilities, '(none)'));
  lines.push('');

  lines.push('## Memory');
  lines.push(`- Memory scope: personality:${config.id}`);
  lines.push('');

  const toolset = config.toolset ?? [];
  lines.push('## Toolset');
  if (toolset.length > 0) {
    lines.push(`${toolset.length} tool${toolset.length === 1 ? '' : 's'}:`);
  }
  lines.push(...bulletList(toolset, '(none)'));
  // Lane G — the in-script tool surface (`toolset ∩ SCRIPT_SAFE`), shown only
  // when the personality can run scripts at all. The exclusion list mirrors
  // the categories in core's SCRIPT_SAFE policy (script-safe.ts).
  if (toolset.includes('run_code') && scriptSurface) {
    lines.push(
      `- Script-callable (run_code): ${scriptSurface.callable.length} of ${toolset.length} tools ` +
        '(excluded: code, delegation, MCP, plugins, clarify, credential-bearing terminal/debug)',
    );
  }
  lines.push('');

  // §2 — the assembled system-prompt weight, so prompt cost is visible per
  // personality. When the caller injects a computed model fit (Lane 6, D5),
  // the ACCURATE `measureStaticFloor()` number replaces the old name-count
  // estimate — serialized tool schemas included. Without it, fall back to the
  // chars/4 estimate over the components the sheet already has (injection
  // prelude + SOUL.md + toolset names), which does NOT include tool schemas
  // or memory, so it reads low — hence "~" and "Estimated".
  lines.push('## Prompt size');
  if (modelFit) {
    lines.push(
      `- System-prompt tokens: ~${modelFit.floor.tokens} (measured static floor — serialized tool schemas included)`,
    );
  } else {
    lines.push(`- Estimated system-prompt tokens: ~${estimateSystemPromptTokens(soulMd, toolset)}`);
  }
  lines.push('');

  lines.push('## MCP servers');
  lines.push(...bulletList(config.mcp_servers ?? [], '(none)'));
  lines.push('');

  lines.push('## Plugins');
  lines.push(...bulletList(config.plugins ?? [], '(none)'));
  lines.push('');

  lines.push('## Filesystem reach');
  const reach = config.fs_reach;
  const read = reach?.read ?? [];
  const write = reach?.write ?? [];
  if (read.length > 0 || write.length > 0) {
    lines.push(`- Read: ${read.length > 0 ? read.join(', ') : '(none)'}`);
    lines.push(`- Write: ${write.length > 0 ? write.join(', ') : '(none)'}`);
  } else {
    lines.push('- (default — personality directory only)');
  }

  const soul = parseLivingSoul(soulMd);
  const isLivingSoul = soul.expression !== '' || soul.learningLog.length > 0;
  if (isLivingSoul) {
    lines.push('');
    lines.push('## Living Soul');
    const coreLineCount = soul.core.split('\n').filter((l) => l.trim() !== '').length;
    lines.push(
      `- Core: immutable identity (${coreLineCount} line${coreLineCount === 1 ? '' : 's'})`,
    );
    lines.push('');
    lines.push('### Expression');
    lines.push(soul.expression.trim() === '' ? '(empty)' : soul.expression.trim());
    lines.push('');
    lines.push('### Learning Log');
    if (soul.learningLog.length === 0) {
      lines.push('- (no changes yet)');
    } else {
      for (const e of soul.learningLog) {
        lines.push(`- ${e.at} · ${e.revisionId} · ${e.summary}`);
      }
    }
  }

  if (execution) {
    lines.push('');
    lines.push(...executionSection(config, execution));
  }

  if (modelFit) {
    lines.push('');
    lines.push(...modelFitSection(modelFit));
  }

  return `${lines.join('\n')}\n`;
}
