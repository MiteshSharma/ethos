// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal `${self}` / `${shared}` tokens in config.yaml — they resolve at
// AgentLoop construction, not in the registry, so the renderer sees them verbatim.
import { type ExecutionPosture, GUARANTEE_IDS, type PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  type CharacterSheetModelFit,
  type CharacterSheetScriptSurface,
  renderCharacterSheet,
} from '../character-sheet';

// The character sheet is the SOUL.md "tight character sheet" promise made
// into a real artifact — one Markdown screen that says what a personality
// is, what it has, and what it can reach. `renderCharacterSheet` is the
// single generator both the CLI (`ethos personality show`) and the Web
// Personalities tab render.

const fullConfig: PersonalityConfig = {
  id: 'engineer',
  name: 'Engineer',
  description: 'Terse, code-first agent that writes working code immediately.',
  model: 'claude-sonnet-4-6',
  provider: 'anthropic',
  toolset: ['read_file', 'write_file', 'terminal'],
  mcp_servers: ['github', 'sentry'],
  plugins: ['linear'],
  fs_reach: { read: ['${self}', '${shared}'], write: ['${self}'] },
};

const soulMd =
  '# Engineer\n\nI write working code. That is the primary output.\n\nI read error messages fully before responding.\n';

describe('renderCharacterSheet', () => {
  it('puts the personality id and name in the identity heading', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toMatch(/^# engineer — Engineer$/m);
  });

  it('renders the description as the role tagline', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('Terse, code-first agent that writes working code immediately.');
  });

  it('renders the first SOUL.md paragraph as role prose and stops there', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('I write working code. That is the primary output.');
    expect(sheet).not.toContain('I read error messages fully before responding.');
  });

  it('renders model and provider routing', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('claude-sonnet-4-6');
    expect(sheet).toContain('anthropic');
  });

  it('renders an estimated system-prompt token count (§2)', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('## Prompt size');
    expect(sheet).toMatch(/Estimated system-prompt tokens: ~\d+/);
  });

  it('renders dreaming off when unset', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('Dreaming: off');
  });

  it('renders dreaming on when enabled', () => {
    const config = { ...fullConfig, dreaming: { enable: true, idleMinutes: 60, maxPerDay: 1 } };
    const sheet = renderCharacterSheet(config, soulMd);
    expect(sheet).toContain('Dreaming: on');
  });

  it('renders the memory scope', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toMatch(/Memory scope.*personality:engineer/i);
  });

  it('lists every tool in the toolset', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('read_file');
    expect(sheet).toContain('write_file');
    expect(sheet).toContain('terminal');
  });

  it('renders mcp servers, plugins, and fs_reach when present', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('github');
    expect(sheet).toContain('sentry');
    expect(sheet).toContain('linear');
    expect(sheet).toContain('${self}');
    expect(sheet).toContain('${shared}');
  });

  it('shows explicit none/default states when optional fields are absent', () => {
    const minimal: PersonalityConfig = { id: 'plain', name: 'Plain' };
    const sheet = renderCharacterSheet(minimal, '# Plain\n\nA plain personality.\n');
    // Absent routing/reach must read as a deliberate default, not a blank.
    expect(sheet).toContain('Model: (engine default)');
    expect(sheet).toContain('Provider: (engine default)');
    expect(sheet).toMatch(/## Toolset\n- \(none\)/);
    expect(sheet).toMatch(/## MCP servers\n- \(none\)/);
    expect(sheet).toMatch(/## Plugins\n- \(none\)/);
    expect(sheet).toMatch(/## Filesystem reach\n- \(default/);
  });

  it('falls back gracefully when SOUL.md is empty', () => {
    const sheet = renderCharacterSheet(fullConfig, '');
    expect(sheet).toMatch(/^# engineer — Engineer$/m);
    expect(sheet).not.toContain('undefined');
  });

  it('renders capabilities when set', () => {
    const config = { ...fullConfig, capabilities: ['triage', 'cost-sensitive'] };
    const sheet = renderCharacterSheet(config, soulMd);
    expect(sheet).toContain('## Capabilities');
    expect(sheet).toContain('- triage');
    expect(sheet).toContain('- cost-sensitive');
  });

  it('renders (none) when capabilities are absent', () => {
    const minimal: PersonalityConfig = { id: 'plain', name: 'Plain' };
    const sheet = renderCharacterSheet(minimal, '# Plain\n\nA plain personality.\n');
    expect(sheet).toContain('## Capabilities');
    expect(sheet).toMatch(/## Capabilities\n- \(none\)/);
  });

  it('renders the Living Soul section for a sectioned soul', () => {
    const livingSoulMd =
      '# Core\nI am the engineer. This never changes.\n\n# Expression\nI write terse, code-first replies.\n\n# Learning Log\n- 2026-06-17T00:00:00.000Z · expr-rev-1 · "tightened tone" · evidence: sessions:3 · prev: expr-rev-1\n';
    const sheet = renderCharacterSheet(fullConfig, livingSoulMd);
    expect(sheet).toContain('## Living Soul');
    expect(sheet).toContain('I write terse, code-first replies.');
    expect(sheet).toContain('expr-rev-1');
    expect(sheet).toContain('tightened tone');
  });

  it('renders no Living Soul section for a flat soul', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).not.toContain('## Living Soul');
  });
});

describe('renderCharacterSheet — ## Execution section', () => {
  function dockerPosture(extra: Partial<ExecutionPosture> = {}): ExecutionPosture {
    return {
      backend: 'docker',
      networkMode: 'none',
      memoryMb: 256,
      containerized: false,
      mounts: [
        { hostPath: '/Users/me/proj', containerPath: '/Users/me/proj', mode: 'rw' },
        { hostPath: '/etc/ethos/skills', containerPath: '/etc/ethos/skills', mode: 'ro' },
      ],
      scratchPaths: ['/tmp'],
      ...extra,
    };
  }

  it('omits the Execution section when no posture is passed', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).not.toContain('## Execution');
  });

  it('renders posture, network, memory cap, mounts, scratch, and blast radius', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture(),
      platform: 'linux',
    });
    expect(sheet).toContain('## Execution');
    expect(sheet).toMatch(/- Posture:\s+docker \(sandboxed\)/);
    expect(sheet).toMatch(/- Network:\s+none/);
    expect(sheet).toMatch(/- Memory cap: 256 MB/);
    expect(sheet).toContain('/Users/me/proj (rw)');
    expect(sheet).toContain('/etc/ethos/skills (ro)');
    expect(sheet).toContain('/tmp (ephemeral scratch, wiped on exit)');
    // A7 — the rw mount roots are the write blast radius.
    expect(sheet).toMatch(/Write blast radius \(A7\): \/Users\/me\/proj/);
  });

  it('relabels ssh posture as remote-host trust, not mount-confined (A3)', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: { ...dockerPosture(), backend: 'ssh', mounts: [], scratchPaths: [] },
      platform: 'linux',
    });
    expect(sheet).toMatch(/ssh = remote-host trust — NOT mount-confined/);
  });

  it('renders the containerized note for a containerized local posture', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: {
        backend: 'local',
        networkMode: 'none',
        memoryMb: 256,
        containerized: true,
        mounts: [],
        scratchPaths: [],
      },
      platform: 'linux',
    });
    expect(sheet).toMatch(/Posture:\s+containerized \(local\)/);
    expect(sheet).toMatch(/isolation boundary = the Ethos container/);
    expect(sheet).toMatch(/enforced app-layer only/);
  });

  it('renders the #7 macOS caveat for docker on darwin', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture(),
      platform: 'darwin',
    });
    expect(sheet).toMatch(/macOS \(#7\)/);
    expect(sheet).toMatch(/NOT a hard security boundary/);
  });

  it('does NOT render the macOS caveat on linux', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture(),
      platform: 'linux',
    });
    expect(sheet).not.toMatch(/macOS \(#7\)/);
  });

  it('renders the A1 docker-absent decision with a consent option', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture({
        dockerAbsent: { blocked: true, canInstall: true, canConsentLocal: true },
      }),
      platform: 'linux',
    });
    expect(sheet).toMatch(/Docker required but not running \(A1\)/);
    expect(sheet).toMatch(/run un-sandboxed on host \(explicit consent required\)/);
  });

  it('renders the A1 state without a consent option when local is forbidden', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture({
        dockerAbsent: {
          blocked: true,
          canInstall: true,
          canConsentLocal: false,
          consentForbiddenReason: 'the constitution forbids the local posture',
        },
      }),
      platform: 'linux',
    });
    expect(sheet).toMatch(/Un-sandboxed consent withheld: the constitution forbids/);
    expect(sheet).not.toMatch(/explicit consent required/);
  });

  it('renders the honest local host-fallback posture (F1) instead of claiming Docker', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: {
        backend: 'local',
        networkMode: 'none',
        memoryMb: 256,
        containerized: false,
        mounts: [],
        scratchPaths: [],
        hostFallback: { reason: 'docker-disabled' },
      },
      platform: 'linux',
    });
    // The posture line must say it runs un-sandboxed on the host, never "docker".
    expect(sheet).toMatch(/Posture:\s+local \(un-sandboxed — runs on host; Docker unavailable\)/);
    expect(sheet).toMatch(/Host fallback \(F1\)/);
    expect(sheet).toMatch(/Docker execution is disabled in this process/);
    expect(sheet).not.toMatch(/docker \(sandboxed\)/);
  });

  it('renders the honest local host-fallback posture (P2) instead of claiming ssh', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: {
        backend: 'local',
        networkMode: 'none',
        memoryMb: 256,
        containerized: false,
        mounts: [],
        scratchPaths: [],
        hostFallback: { reason: 'ssh-unavailable' },
      },
      platform: 'linux',
    });
    // Never claims "ssh (remote host)" — says it runs un-sandboxed on the host.
    expect(sheet).toMatch(
      /Posture:\s+local \(un-sandboxed — runs on host; ssh backend unavailable\)/,
    );
    expect(sheet).toMatch(/Host fallback \(P2\)/);
    expect(sheet).toMatch(/no ssh execution backend is wired in this build/);
    expect(sheet).not.toMatch(/ssh \(remote host\)/);
  });

  it('marks a forbidden-ssh posture as refusing exec (P2), never silent host', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: { ...dockerPosture(), backend: 'ssh', mounts: [], scratchPaths: [] },
      platform: 'linux',
    });
    expect(sheet).toMatch(/Note \(P2\)/);
    expect(sheet).toMatch(/execution tools refuse \(not_available\)/);
  });

  it('renders a constitution clamp notice for the active personality', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, {
      posture: dockerPosture(),
      platform: 'linux',
      enforcement: {
        clamps: [
          { personalityId: 'engineer', field: 'budgetCapUsd', declared: 100, clamped: 10 },
          { personalityId: 'other', field: 'budgetCapUsd', declared: 5, clamped: 1 },
        ],
      },
    });
    expect(sheet).toMatch(/Constitution clamp: budgetCapUsd 100 → 10/);
    // A clamp for a DIFFERENT personality must not leak onto this sheet.
    expect(sheet).not.toMatch(/budgetCapUsd 5 → 1/);
  });
});

describe('renderCharacterSheet — ## Model fit section (Lane 6)', () => {
  const fit: CharacterSheetModelFit = {
    verdict: 'fits-degraded',
    model: 'qwen3:8b',
    windowTokens: 8_192,
    windowSource: 'probe',
    floor: {
      tokens: 2_113,
      toolCount: 3,
      components: [
        { name: 'SOUL.md', tokens: 812 },
        { name: 'tool schemas', tokens: 961 },
        { name: 'injection-defense prelude', tokens: 340 },
      ],
    },
    outputReserveTokens: 4_096,
    compactibleTokens: 1_983,
    staticShare: 0.258,
    degradations: [
      'small-window mode active',
      'toolset narrowed to declared small_window_toolset (2 tools): read_file, terminal',
    ],
    exclusions: [
      '2 MCP servers not counted — schemas unknown until connect',
      'tier models not evaluated',
    ],
  };

  it('renders nothing new when modelFit is absent — the no-modelFit sheet is unchanged', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toBe(renderCharacterSheet(fullConfig, soulMd, undefined, undefined));
    expect(sheet).not.toContain('## Model fit');
    expect(sheet).toMatch(/Estimated system-prompt tokens: ~\d+/);
  });

  it('prints the verdict with its inputs: window + source, floor breakdown, degradations, exclusions', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, undefined, fit);
    expect(sheet).toContain('## Model fit');
    expect(sheet).toContain('- Verdict: fits-degraded');
    expect(sheet).toContain('- Model: qwen3:8b');
    expect(sheet).toContain('- Window: 8,192 tokens (source: probe)');
    expect(sheet).toContain('- Static floor: 2,113 tokens (3 tool schemas):');
    expect(sheet).toContain('    - SOUL.md: 812 tokens');
    expect(sheet).toContain('    - tool schemas: 961 tokens');
    expect(sheet).toContain('    - injection-defense prelude: 340 tokens');
    expect(sheet).toContain('- Output reserve: 4,096 tokens');
    expect(sheet).toContain('- Compactible: 1,983 tokens');
    expect(sheet).toContain('- Static share of window: 26%');
    expect(sheet).toContain('    - small-window mode active');
    expect(sheet).toContain('read_file, terminal');
    expect(sheet).toContain('    - 2 MCP servers not counted — schemas unknown until connect');
    expect(sheet).toContain('    - tier models not evaluated');
  });

  it('only appends the verdict section and swaps the prompt-size line — the rest is byte-identical', () => {
    const plain = renderCharacterSheet(fullConfig, soulMd);
    const withFit = renderCharacterSheet(fullConfig, soulMd, undefined, fit);
    const idx = withFit.indexOf('\n## Model fit');
    expect(idx).toBeGreaterThan(-1);
    // Strip the appended section, then swap the measured prompt-size line
    // back to the estimate: the result must be EXACTLY today's sheet.
    const stripped = withFit.slice(0, idx);
    const estimateLine = plain
      .split('\n')
      .find((l) => l.startsWith('- Estimated system-prompt tokens:'));
    if (!estimateLine) throw new Error('expected an estimate line in the plain sheet');
    const measuredLine =
      '- System-prompt tokens: ~2113 (measured static floor — serialized tool schemas included)';
    expect(stripped).toContain(measuredLine);
    expect(stripped.replace(measuredLine, estimateLine)).toBe(plain);
  });

  it('renders an unknown verdict with no numbers — never the 128k default', () => {
    const unknown: CharacterSheetModelFit = {
      verdict: 'unknown',
      model: 'mystery:7b',
      windowSource: 'default',
      floor: { tokens: 900, toolCount: 1, components: [{ name: 'SOUL.md', tokens: 900 }] },
      degradations: [],
      exclusions: ['1 MCP server not counted — schemas unknown until connect'],
    };
    const sheet = renderCharacterSheet(fullConfig, soulMd, undefined, unknown);
    expect(sheet).toContain('- Verdict: unknown');
    expect(sheet).toContain(
      '- Window: unknown (no config, no probe, no catalog — verdict not computed against the default)',
    );
    expect(sheet).not.toContain('128,000');
    expect(sheet).not.toContain('- Output reserve:');
    expect(sheet).not.toContain('- Compactible:');
    expect(sheet).not.toContain('NaN');
  });

  it('refuses verdict renders the refusal reason', () => {
    const refuses: CharacterSheetModelFit = {
      ...fit,
      verdict: 'refuses',
      degradations: [],
      compactibleTokens: -1_002,
      refusalReason:
        'personality `engineer` cannot run on `qwen3:8b` (8,192 tokens): static prefix 7,200 + output reserve 4,096 exceeds the window. Largest contributor: tool schemas (4,800 tokens, 12 tools).',
    };
    const sheet = renderCharacterSheet(fullConfig, soulMd, undefined, refuses);
    expect(sheet).toContain('- Verdict: refuses');
    expect(sheet).toContain('- Refusal: personality `engineer` cannot run on `qwen3:8b`');
    expect(sheet).toContain('Largest contributor: tool schemas (4,800 tokens, 12 tools).');
  });
});

// tools-as-code-api Lane G — the script-callable surface line. Plain data
// computed by callers via core's `scriptCallableFor` (the same derivation the
// ScriptToolBridge enforces) and injected like the model-fit verdict.
describe('renderCharacterSheet — script-callable surface (Lane G)', () => {
  const scriptConfig: PersonalityConfig = {
    ...fullConfig,
    toolset: ['read_file', 'write_file', 'run_code', 'run_tests'],
  };
  const surface: CharacterSheetScriptSurface = { callable: ['read_file', 'write_file'] };

  it('renders "N of M tools" with the exclusion categories when run_code is in the toolset', () => {
    const sheet = renderCharacterSheet(scriptConfig, soulMd, undefined, undefined, surface);
    expect(sheet).toContain(
      '- Script-callable (run_code): 2 of 4 tools ' +
        '(excluded: code, delegation, MCP, plugins, clarify, credential-bearing terminal/debug)',
    );
  });

  it('omits the line when the personality has no run_code (the gate is the toolset)', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, undefined, undefined, surface);
    expect(sheet).not.toContain('Script-callable');
  });

  it('omits the line fail-soft when no surface data is injected (no registry at the call site)', () => {
    const sheet = renderCharacterSheet(scriptConfig, soulMd);
    expect(sheet).not.toContain('Script-callable');
  });
});

// skill-declared-renderers Lane E — the output-capability line. Same shape as
// the script surface above: plain data computed by callers via
// `SkillsInjector.resolveRenderers()`, the derivation the surfaces gate on.
describe('renderCharacterSheet — renderers (Lane E)', () => {
  it('names the declared renderer under Capabilities', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd, undefined, undefined, undefined, [
      'echarts@1',
    ]);
    expect(sheet).toContain('- Renders: echarts@1 (interactive charts — via charts skill)');
  });

  it('prints an unknown renderer as its bare spec string', () => {
    // A skill may declare a renderer no surface maps; the sheet reports the
    // declaration honestly rather than inventing a description for it.
    const sheet = renderCharacterSheet(fullConfig, soulMd, undefined, undefined, undefined, [
      'echarts@1',
      'mermaid@2',
    ]);
    expect(sheet).toContain(
      '- Renders: echarts@1 (interactive charts — via charts skill), mermaid@2',
    );
  });

  it('omits the line for an absent or empty renderer set', () => {
    expect(renderCharacterSheet(fullConfig, soulMd)).not.toContain('Renders:');
    expect(
      renderCharacterSheet(fullConfig, soulMd, undefined, undefined, undefined, []),
    ).not.toContain('Renders:');
  });

  it('replaces the Capabilities "(none)" placeholder rather than contradicting it', () => {
    const minimal: PersonalityConfig = { id: 'plain', name: 'Plain' };
    const bare = renderCharacterSheet(minimal, '');
    expect(bare).toMatch(/## Capabilities\n- \(none\)/);
    const withRenderer = renderCharacterSheet(minimal, '', undefined, undefined, undefined, [
      'echarts@1',
    ]);
    expect(withRenderer).toMatch(
      /## Capabilities\n- Renders: echarts@1 \(interactive charts — via charts skill\)\n/,
    );
    expect(withRenderer).not.toContain('(none)\n- Renders');
  });
});

// The voice V1a schema amendment made visible. `renderCharacterSheet` is the
// single generator behind `ethos personality show <id>` and the web
// Personalities tab, so the block landing here is the block a user sees.
describe('voice block', () => {
  const base: PersonalityConfig = { id: 'speaker', name: 'Speaker' };

  it('is omitted entirely when the personality declares no voice', () => {
    expect(renderCharacterSheet(base, '')).not.toContain('## Voice');
  });

  it('renders every knob, naming what each unset one inherits', () => {
    const sheet = renderCharacterSheet({ ...base, voice: { tts_voice: 'af_bella' } }, '');
    expect(sheet).toContain('## Voice');
    expect(sheet).toContain('- TTS voice: af_bella');
    expect(sheet).toContain('- Tier: (deployment default)');
    expect(sheet).toContain('- Fast-lane model: (personality model)');
  });

  it('lists the language map in stable order', () => {
    const sheet = renderCharacterSheet(
      {
        ...base,
        voice: {
          tts_voice: 'af_bella',
          languages: { ja: 'jf_alpha', es: 'ef_dora' },
          tier: 'realtime',
          model: 'claude-haiku-4-5',
        },
      },
      '',
    );
    expect(sheet).toContain('- By language:\n    - es: ef_dora\n    - ja: jf_alpha');
    expect(sheet).toContain('- Tier: realtime');
    expect(sheet).toContain('- Fast-lane model: claude-haiku-4-5');
  });

  it('says the TTS voice is inherited when only the model is declared', () => {
    const sheet = renderCharacterSheet({ ...base, voice: { model: 'fast' } }, '');
    expect(sheet).toContain('- TTS voice: (global default)');
    expect(sheet).toContain('- Fast-lane model: fast');
  });

  it('prints the declared call look', () => {
    const sheet = renderCharacterSheet({ ...base, voice: { call_style: 'rings' } }, '');
    expect(sheet).toContain('- Call look: rings');
  });

  it('prints the DERIVED call look when undeclared — there is no "(default)" to name', () => {
    // A personality that declares nothing still draws a specific shape. The
    // sheet's job is to say which, not to say "unset".
    const sheet = renderCharacterSheet({ ...base, voice: { tts_voice: 'af_bella' } }, '');
    expect(sheet).toContain('- Call look: orb (derived from id)');
    // …and it follows the ID, so two personalities do not have to look alike.
    const other = renderCharacterSheet(
      { id: 'reviewer', name: 'Reviewer', voice: { tts_voice: 'af_bella' } },
      '',
    );
    expect(other).toContain('- Call look: rings (derived from id)');
  });
});

// §4.7 — the register-status section. The register (published in
// docs/content/security/security-boundary.md) says what Ethos guarantees in
// general; this section says which of those twelve guarantees are enforced,
// narrowed, relaxed, or inapplicable for THIS personality. The value is in the
// narrowings and relaxations being visible without cross-referencing the doc,
// so these tests assert the STATE, never merely that a section exists.
describe('renderCharacterSheet — ## Boundary section (§4.7)', () => {
  /** Pull the one table row for a guarantee id. */
  function row(sheet: string, id: string): string {
    const line = sheet.split('\n').find((l) => l.startsWith(`| ${id} `));
    if (!line) throw new Error(`no ${id} row in the sheet`);
    return line;
  }

  /** The status cell of a row. */
  function status(sheet: string, id: string): string {
    return (row(sheet, id).split('|')[2] ?? '').trim();
  }

  const permissive: PersonalityConfig = {
    id: 'wide',
    name: 'Wide',
    // No toolset declared at all: every registered built-in tool is reachable.
    safety: {
      approvalMode: 'off',
      network: { allow_private_urls: true },
      injectionDefense: { postReadDowngrade: { enabled: false } },
      observability: { storeToolBodies: 'full' },
    },
  };

  const tight: PersonalityConfig = {
    id: 'tight',
    name: 'Tight',
    toolset: ['read_file', 'web_extract'],
    fs_reach: { read: ['/srv/app', '/etc/app'], write: ['/srv/app'], workdir: '/srv/app' },
    safety: {
      approvalMode: 'manual',
      denyRules: ['git push --force', 'rm -rf /'],
      network: { allow: ['api.internal'], deny: ['evil.example'] },
      injectionDefense: { classifier: { alwaysCallLLM: true } },
      observability: { storeToolArgs: 'redacted', redactPatterns: ['acme_[a-z]+'] },
    },
  };

  /** Chat-only: no network-declaring tool, no exec-bearing tool. */
  const chatOnly: PersonalityConfig = {
    id: 'poet',
    name: 'Poet',
    toolset: ['memory_read'],
  };

  const nonePosture: ExecutionPosture = {
    backend: 'none',
    networkMode: 'none',
    memoryMb: 256,
    containerized: false,
    mounts: [],
    scratchPaths: [],
  };

  it('reports all twelve register rows, in register order', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(sheet).toContain('## Boundary');
    const ids = sheet
      .split('\n')
      .filter((l) => l.startsWith('| G-'))
      .map((l) => (l.split('|')[1] ?? '').trim());
    expect(ids).toEqual([...GUARANTEE_IDS]);
  });

  it('surfaces the actual relaxations a permissive personality made', () => {
    const sheet = renderCharacterSheet(permissive, soulMd);
    expect(status(sheet, 'G-TOOLS')).toBe('relaxed');
    expect(row(sheet, 'G-TOOLS')).toContain('no toolset declared');
    expect(status(sheet, 'G-NET')).toBe('relaxed');
    expect(row(sheet, 'G-NET')).toContain('allow_private_urls');
    expect(row(sheet, 'G-NET')).toContain('cloud metadata still blocked');
    expect(status(sheet, 'G-APP')).toBe('relaxed');
    expect(row(sheet, 'G-APP')).toContain('approvalMode off');
    expect(status(sheet, 'G-RED')).toBe('relaxed');
    expect(row(sheet, 'G-RED')).toContain('tool bodies full');
  });

  it('reports a narrowed injection pipeline as relaxed-but-never-off (no opt-out)', () => {
    const sheet = renderCharacterSheet(permissive, soulMd);
    expect(status(sheet, 'G-INJ')).toBe('relaxed');
    expect(row(sheet, 'G-INJ')).toContain('post-read downgrade off');
    // The register has no waiver for G-INJ: the row must say what still runs.
    expect(row(sheet, 'G-INJ')).toContain('no opt-out');
  });

  it('names each narrowing a tightly-scoped personality made', () => {
    const sheet = renderCharacterSheet(tight, soulMd);
    expect(status(sheet, 'G-TOOLS')).toBe('narrowed');
    expect(row(sheet, 'G-TOOLS')).toContain('2 tools allowed');
    expect(status(sheet, 'G-FS')).toBe('narrowed');
    expect(row(sheet, 'G-FS')).toContain('2 read / 1 write prefixes');
    expect(row(sheet, 'G-FS')).toContain('workdir /srv/app');
    expect(status(sheet, 'G-NET')).toBe('narrowed');
    expect(row(sheet, 'G-NET')).toContain('host allowlist: 1 host');
    expect(row(sheet, 'G-NET')).toContain('1 deny rule');
    expect(status(sheet, 'G-CAP')).toBe('narrowed');
    expect(row(sheet, 'G-CAP')).toContain('fs_reach + network allowlist');
    expect(status(sheet, 'G-INJ')).toBe('narrowed');
    expect(row(sheet, 'G-INJ')).toContain('LLM classifier on every untrusted result');
    expect(status(sheet, 'G-RED')).toBe('narrowed');
    expect(row(sheet, 'G-RED')).toContain('+1 pattern');
    expect(status(sheet, 'G-APP')).toBe('enforced');
    expect(row(sheet, 'G-APP')).toContain('2 deny rules bind first');
  });

  it('states both the allowlist and the private-network opt-in when a personality does both', () => {
    const both: PersonalityConfig = {
      ...tight,
      safety: { network: { allow: ['api.internal'], allow_private_urls: true } },
    };
    const sheet = renderCharacterSheet(both, soulMd);
    expect(status(sheet, 'G-NET')).toBe('relaxed');
    expect(row(sheet, 'G-NET')).toContain('allow_private_urls');
    expect(row(sheet, 'G-NET')).toContain('host allowlist: 1 host');
  });

  it('marks G-NET and G-EXEC not applicable for a personality with no network or exec tool', () => {
    const sheet = renderCharacterSheet(
      chatOnly,
      soulMd,
      { posture: nonePosture },
      undefined,
      undefined,
      undefined,
      { networkTools: [] },
    );
    expect(status(sheet, 'G-NET')).toBe('n/a');
    expect(row(sheet, 'G-NET')).toContain('no tool in this toolset declares network reach');
    expect(status(sheet, 'G-EXEC')).toBe('n/a');
    expect(row(sheet, 'G-EXEC')).toContain('no exec-bearing tool');
    // Everything that still binds a chat-only personality stays enforced.
    expect(status(sheet, 'G-INJ')).toBe('enforced');
    expect(status(sheet, 'G-SEC')).toBe('enforced');
    expect(status(sheet, 'G-AUDIT')).toBe('enforced');
  });

  it('never claims inapplicable network reach when MCP servers or plugins are attached', () => {
    const withMcp: PersonalityConfig = { ...chatOnly, mcp_servers: ['github'] };
    const sheet = renderCharacterSheet(
      withMcp,
      soulMd,
      undefined,
      undefined,
      undefined,
      undefined,
      { networkTools: [] },
    );
    expect(status(sheet, 'G-NET')).not.toBe('n/a');
    expect(row(sheet, 'G-NET')).toContain('MCP/plugin-side only');
  });

  it('does not claim inapplicability when no reach data is injected (no registry at the call site)', () => {
    const sheet = renderCharacterSheet(chatOnly, soulMd);
    expect(status(sheet, 'G-NET')).toBe('enforced');
    expect(row(sheet, 'G-NET')).toContain('safeFetch floor');
    expect(status(sheet, 'G-EXEC')).toBe('enforced');
    expect(row(sheet, 'G-EXEC')).toContain('no execution posture resolved on this surface');
  });

  it('describes the resolved posture in the same words as ## Execution', () => {
    const hostFallback: ExecutionPosture = {
      backend: 'local',
      networkMode: 'bridge',
      memoryMb: 512,
      containerized: false,
      mounts: [],
      scratchPaths: [],
      hostFallback: { reason: 'docker-disabled' },
    };
    const sheet = renderCharacterSheet(fullConfig, soulMd, { posture: hostFallback });
    expect(status(sheet, 'G-EXEC')).toBe('enforced');
    expect(row(sheet, 'G-EXEC')).toContain(
      'local (un-sandboxed — runs on host; Docker unavailable)',
    );
    expect(row(sheet, 'G-EXEC')).toContain('host fallback: docker-disabled');
  });

  it('says channel admission is decided outside the personality', () => {
    const sheet = renderCharacterSheet(fullConfig, soulMd);
    expect(status(sheet, 'G-CHAN')).toBe('n/a');
    expect(row(sheet, 'G-CHAN')).toContain('unconfigured platform is ungated');
  });
});
