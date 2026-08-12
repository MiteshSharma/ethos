import type { PersonalityConfig, ToolRegistry } from '@ethosagent/types';
import { evaluateToolSchemaBudget, measureStaticFloor } from '@ethosagent/wiring';

// `ethos bench context` — context-economy Phase 0 (plan/phases/gap-context-economy.md §4).
// Quantifies the per-turn context tax: a static per-personality table (SOUL.md
// chars + tool-schema chars, no LLM calls) and optional --live scenario runs
// that record per-turn token usage and the provider's requestTokens split.

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  yellow: '\x1b[33m',
};

const USAGE = [
  'Usage: ethos bench context [--live] [--scenario <id>] [--turns <n>] [--write-baseline]',
  '',
  '  Static measurement (always): per-personality SOUL.md + tool-schema size.',
  '  --live             Run live scenarios against the configured provider.',
  '  --scenario <id>    Run only one scenario (hi | one-tool | multi-tool | long-session).',
  '  --turns <n>        Turns for the long-session scenario (default: 10;',
  '                     --turns 50 reproduces the plan/phases/gap-context-economy.md scenario).',
  '  --write-baseline   Write results to evals/local/context-baseline.json.',
].join('\n');

// ---------------------------------------------------------------------------
// Static measurement
// ---------------------------------------------------------------------------

export interface StaticMeasurement {
  id: string;
  soulChars: number;
  toolCount: number;
  toolSchemaChars: number;
  /**
   * `measureStaticFloor().tokens` — the SAME chars/4 static-floor number
   * wiring's build-agent-loop computes (D8: one arithmetic, shared helper).
   * Includes the injection-defense prelude when `preludeChars` is passed;
   * before Lane 1 this table silently omitted it and disagreed with wiring.
   */
  estStaticTokens: number;
}

/**
 * Measure the static context tax one personality pays: SOUL.md size plus the
 * serialized tool schemas its resolved toolset exposes to the LLM, plus the
 * injection-defense prelude. Pure — takes the SOUL.md body and a ToolRegistry
 * so it is testable without the CLI. When no registry is available (no
 * ~/.ethos config → no wired tools), tool columns degrade to the toolset name
 * count and zero schema chars. Delegates the token estimate to wiring's
 * `measureStaticFloor` so this table and build-agent-loop can never drift.
 */
export function measurePersonalityStatic(
  personality: PersonalityConfig,
  soulMd: string,
  tools?: Pick<ToolRegistry, 'toDefinitions'>,
  preludeChars = 0,
): StaticMeasurement {
  const soulChars = soulMd.length;
  const defs = tools?.toDefinitions(personality.toolset);
  const toolSchemaChars = defs ? JSON.stringify(defs).length : 0;
  const floor = measureStaticFloor({
    soulChars,
    toolSchemaChars,
    toolCount: defs?.length ?? personality.toolset?.length ?? 0,
    preludeChars,
  });
  return {
    id: personality.id,
    soulChars,
    toolCount: floor.toolCount,
    toolSchemaChars,
    estStaticTokens: floor.tokens,
  };
}

// ---------------------------------------------------------------------------
// Live scenarios
// ---------------------------------------------------------------------------

interface BenchScenario {
  id: string;
  description: string;
  /** One prompt per turn, all in a single session. */
  prompts: (turns: number) => string[];
}

const SCENARIOS: BenchScenario[] = [
  {
    id: 'hi',
    description: 'single-turn "hi" — the minimal-turn context tax',
    prompts: () => ['hi'],
  },
  {
    id: 'one-tool',
    description: 'one tool call (read a small file)',
    prompts: () => [
      'Use the read_file tool to read ./package.json and tell me the value of its "name" field.',
    ],
  },
  {
    id: 'multi-tool',
    description: 'two to three tool calls in one turn',
    prompts: () => [
      'Use search_files to find files named *.json in the current directory, then read_file ' +
        './package.json and report its "name" and "version" fields.',
    ],
  },
  {
    id: 'long-session',
    description: 'N short turns in one session (history growth)',
    prompts: (turns) =>
      Array.from({ length: turns }, (_, i) => `Turn ${i + 1}: reply with just "ok ${i + 1}".`),
  },
];

interface TurnRecord {
  turn: number;
  inputTokens: number;
  outputTokens: number;
  requestTokens?: { system: number; tools: number; messages: number };
  latencyMs: number;
  error?: string;
}

interface ScenarioResult {
  scenario: string;
  model: string;
  turns: TurnRecord[];
}

interface BenchFlags {
  live: boolean;
  writeBaseline: boolean;
  scenario?: string;
  turns: number;
}

function parseFlags(args: string[]): BenchFlags | null {
  const flags: BenchFlags = { live: false, writeBaseline: false, turns: 10 };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? '';
    if (arg === '--live') {
      flags.live = true;
    } else if (arg === '--write-baseline') {
      flags.writeBaseline = true;
    } else if (arg === '--scenario') {
      flags.scenario = args[++i];
      if (!flags.scenario || !SCENARIOS.some((s) => s.id === flags.scenario)) return null;
    } else if (arg === '--turns') {
      const n = Number(args[++i]);
      if (!Number.isInteger(n) || n < 1) return null;
      flags.turns = n;
    } else {
      return null;
    }
  }
  return flags;
}

async function runScenario(
  loop: import('@ethosagent/core').AgentLoop,
  personalityId: string,
  model: string,
  scenario: BenchScenario,
  turns: number,
): Promise<ScenarioResult> {
  const sessionKey = `bench:${scenario.id}:${Date.now()}`;
  const records: TurnRecord[] = [];

  // requestTokens rides the after_llm_call hook payload (the usage AgentEvent
  // carries only input/output totals). Capture the first split per turn — the
  // opening request of a turn is the per-turn context tax.
  let turnSplit: TurnRecord['requestTokens'];
  const cleanup = loop.hooks.registerVoid('after_llm_call', async (payload) => {
    if (!turnSplit && payload.usage.requestTokens) turnSplit = payload.usage.requestTokens;
  });

  try {
    const prompts = scenario.prompts(turns);
    for (let i = 0; i < prompts.length; i++) {
      turnSplit = undefined;
      let inputTokens = 0;
      let outputTokens = 0;
      let error: string | undefined;
      const start = Date.now();
      for await (const event of loop.run(prompts[i] ?? '', { sessionKey, personalityId })) {
        if (event.type === 'usage') {
          inputTokens += event.inputTokens;
          outputTokens += event.outputTokens;
        }
        if (event.type === 'error') error = `[${event.code}] ${event.error}`;
      }
      records.push({
        turn: i + 1,
        inputTokens,
        outputTokens,
        ...(turnSplit ? { requestTokens: turnSplit } : {}),
        latencyMs: Date.now() - start,
        ...(error ? { error } : {}),
      });
    }
  } finally {
    cleanup();
  }

  return { scenario: scenario.id, model, turns: records };
}

function printScenarioResult(result: ScenarioResult): void {
  console.log(
    `\n${c.bold}scenario: ${result.scenario}${c.reset}  ${c.dim}${result.model}${c.reset}`,
  );
  console.log(
    `  ${'turn'.padEnd(6)}${'in'.padStart(9)}${'out'.padStart(8)}${'system'.padStart(9)}${'tools'.padStart(8)}${'msgs'.padStart(8)}${'ms'.padStart(8)}`,
  );
  for (const t of result.turns) {
    const rt = t.requestTokens;
    console.log(
      `  ${String(t.turn).padEnd(6)}${String(t.inputTokens).padStart(9)}${String(t.outputTokens).padStart(8)}` +
        `${String(rt?.system ?? '-').padStart(9)}${String(rt?.tools ?? '-').padStart(8)}${String(rt?.messages ?? '-').padStart(8)}` +
        `${String(t.latencyMs).padStart(8)}${t.error ? `  ${c.yellow}${t.error}${c.reset}` : ''}`,
    );
  }
  const n = result.turns.length;
  if (n > 1) {
    const totalIn = result.turns.reduce((a, t) => a + t.inputTokens, 0);
    const totalOut = result.turns.reduce((a, t) => a + t.outputTokens, 0);
    const avgMs = Math.round(result.turns.reduce((a, t) => a + t.latencyMs, 0) / n);
    console.log(
      `  ${c.dim}total  ${String(totalIn).padStart(8)}${String(totalOut).padStart(8)}   avg latency ${avgMs}ms${c.reset}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Command entry
// ---------------------------------------------------------------------------

export async function runBench(args: string[]): Promise<void> {
  const sub = args[0] ?? '';
  if (sub !== 'context') {
    console.log(USAGE);
    if (sub !== '' && sub !== '--help' && sub !== '-h') process.exitCode = 1;
    return;
  }

  const flags = parseFlags(args.slice(1));
  if (!flags) {
    console.error(USAGE);
    process.exit(1);
  }

  const { join } = await import('node:path');
  const { ethosDir, readConfig } = await import('@ethosagent/config');
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { getSecretsResolver, getStorage } = await import('../wiring');

  const storage = getStorage();
  const config = await readConfig(storage, await getSecretsResolver());

  // Personality registry — same loading path as `ethos personality show`:
  // built-ins from the package data dir plus any user personalities.
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  // Tool registry — from the same wiring the chat/eval commands use. Needs a
  // config (provider, model); construction makes no LLM calls.
  let toolRegistry: ToolRegistry | undefined;
  let loop: import('@ethosagent/core').AgentLoop | undefined;
  let activePersonalityId = '';
  let contextWindow: number | undefined;
  if (config) {
    const { createAgentLoop } = await import('../wiring');
    // Lane 0 (D16) — bench context probes the served window LIVE and rewrites
    // the probe cache; the tuning loop must never show stale numbers.
    const result = await createAgentLoop(config, { probeWindowRefresh: true });
    toolRegistry = result.toolRegistry;
    loop = result.loop;
    activePersonalityId = result.activePersonality.id;
    contextWindow = result.contextWindow;
  } else {
    console.log(
      `${c.yellow}No ~/.ethos/config.yaml — measuring built-in personalities without a wired ` +
        `tool registry (tool-schema chars unavailable; run ethos setup for the full table).${c.reset}`,
    );
  }

  // Static table — no LLM calls. The injection-defense prelude is part of
  // every assembled prompt, so it belongs in the static floor (D8: same
  // number wiring computes; the full prelude is the default posture — a
  // per-model compact-prelude profile would shave a few hundred chars).
  const { INJECTION_DEFENSE_PRELUDE } = await import('@ethosagent/wiring/security-kernel');
  const staticRows: StaticMeasurement[] = [];
  for (const personality of reg.list()) {
    const soulMd = await reg.readSoulMd(personality.id);
    staticRows.push(
      measurePersonalityStatic(personality, soulMd, toolRegistry, INJECTION_DEFENSE_PRELUDE.length),
    );
  }
  staticRows.sort((a, b) => b.estStaticTokens - a.estStaticTokens);

  console.log(
    `\n${c.bold}Static context tax per personality${c.reset} ${c.dim}(chars/4 token estimate)${c.reset}`,
  );
  console.log(
    `  ${'personality'.padEnd(24)}${'soul ch'.padStart(9)}${'tools'.padStart(7)}${'schema ch'.padStart(11)}${'~tokens'.padStart(9)}`,
  );
  for (const row of staticRows) {
    console.log(
      `  ${row.id.padEnd(24)}${String(row.soulChars).padStart(9)}${String(row.toolCount).padStart(7)}` +
        `${String(row.toolSchemaChars).padStart(11)}${String(row.estStaticTokens).padStart(9)}`,
    );
  }

  // Lane 3(b) — the schema-budget gate, wired into the bench (no second
  // measurement path): the same `evaluateToolSchemaBudget` wiring runs at
  // startup, dividing the SAME toDefinitions payload by the SAME served
  // window. A personality flagged here is the one warned about at startup.
  if (toolRegistry && contextWindow !== undefined) {
    for (const personality of reg.list()) {
      const verdict = evaluateToolSchemaBudget({
        personalityId: personality.id,
        windowTokens: contextWindow,
        toolDefinitions: toolRegistry.toDefinitions(personality.toolset),
      });
      if (verdict.message) console.log(`  ${c.yellow}⚠ ${verdict.message}${c.reset}`);
    }
  }

  // Live scenarios — only with --live and a configured provider.
  const liveResults: ScenarioResult[] = [];
  if (flags.live) {
    if (!config || !loop) {
      console.log(
        `\n${c.yellow}--live skipped: no provider configured. Run ethos setup first.${c.reset}`,
      );
    } else {
      const selected = SCENARIOS.filter((s) => !flags.scenario || s.id === flags.scenario);
      for (const scenario of selected) {
        console.log(`\n${c.dim}running ${scenario.id} — ${scenario.description}…${c.reset}`);
        const result = await runScenario(
          loop,
          activePersonalityId,
          config.model,
          scenario,
          flags.turns,
        );
        liveResults.push(result);
        printScenarioResult(result);
      }
    }
  } else {
    console.log(
      `\n${c.dim}Live scenarios not run (pass --live with a configured provider).${c.reset}`,
    );
  }

  if (flags.writeBaseline) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const outDir = join('evals', 'local');
    const outPath = join(outDir, 'context-baseline.json');
    const baseline = {
      generatedAt: new Date().toISOString(),
      static: staticRows,
      ...(liveResults.length > 0 ? { live: liveResults } : {}),
    };
    await mkdir(outDir, { recursive: true });
    await writeFile(outPath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8');
    console.log(`\n${c.dim}baseline → ${outPath}${c.reset}`);
  }

  console.log();
  // Loop construction can leave live handles (MCP children, cron timers);
  // measurements are complete and flushed, so exit explicitly.
  process.exit(process.exitCode ?? 0);
}
