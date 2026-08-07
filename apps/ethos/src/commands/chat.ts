import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { clearLine, createInterface } from 'node:readline';
import { InMemorySteerSink } from '@ethosagent/agent-bridge';
import type { EthosConfig, QuickCommandConfig } from '@ethosagent/config';
import { ethosDir } from '@ethosagent/config';
import { type AgentEvent, type AgentLoop, stripAnsiEscapes } from '@ethosagent/core';
import { FsAttachmentCache, FsStorage } from '@ethosagent/storage-fs';
import { parseSlashCommand, shouldSurfaceProgress } from '@ethosagent/surface-kit';
import type { SplashInventory } from '@ethosagent/tui';
import type {
  Attachment,
  JobStore,
  NotificationAdapter,
  SteerSink,
  Storage,
} from '@ethosagent/types';
import { resolveAtRefs } from '../lib/at-refs';
import { makeCompleter } from '../lib/autocomplete';
import { formatClarifyPrompt, parseClarifyAnswer } from '../lib/clarify-prompt';
import {
  type CommandMeta,
  refreshCommandIfStale,
  scanCommandsIntoRegistry,
} from '../lib/command-loader';
import { grantQuickCommandConsent, hasQuickCommandConsent } from '../lib/onboarding';
import { formatQuickCommandOutput, runQuickCommand } from '../lib/quick-command-runner';
import { formatRecap } from '../lib/recap';
import { formatResumeHint } from '../lib/resume-hint';
import { refreshSkillIfStale, type SkillMeta, scanSkillsIntoRegistry } from '../lib/skill-slash';
import { buildBaseRegistry, type SlashCommandRegistry } from '../lib/slash-commands';
import { SpinnerState } from '../lib/spinner';
import { renderStatusBar, type Threshold } from '../lib/status-bar';
import { formatToolFeedLine } from '../lib/tool-feed';
import {
  formatSkillProposedNotice,
  makeTuiNotificationSubscriber,
  makeTuiSlashCommands,
} from '../lib/tui-capabilities';
import { isVerbosity, nextVerbosity, projectEvent, type Verbosity } from '../lib/verbosity';
import { getFunnelTracker, getStorage, resolveActiveLoop } from '../wiring';
import { runPairingCommand } from './pairing-commands';
import { formatVerboseSummary, type TurnTiming } from './verbose-timing';

async function buildInventory(loop: AgentLoop, _config: EthosConfig): Promise<SplashInventory> {
  const tools = loop.getAvailableTools();
  let personalities: string[];
  try {
    personalities = loop.getPersonalityIds();
    if (personalities.length === 0)
      personalities = ['researcher', 'engineer', 'reviewer', 'coach', 'operator'];
  } catch {
    personalities = ['researcher', 'engineer', 'reviewer', 'coach', 'operator'];
  }

  const groupMap = new Map<string, string[]>();
  for (const tool of tools) {
    const ts = tool.toolset ?? 'general';
    const names = groupMap.get(ts) ?? [];
    names.push(tool.name);
    groupMap.set(ts, names);
  }

  const toolGroups = [...groupMap.entries()].map(([toolset, names]) => ({ toolset, names }));

  return {
    tools: toolGroups,
    totalTools: tools.length,
    personalities,
    skills: [],
    mcpServers: [],
  };
}

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const c = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  orange: '\x1b[38;5;208m',
};

const out = (s: string) => process.stdout.write(s);

function colorForThreshold(t: Threshold): string {
  switch (t) {
    case 'red':
      return c.red;
    case 'orange':
      return c.orange;
    case 'yellow':
      return c.yellow;
    case 'green':
      return c.green;
  }
}

// FW-1 — model context window. Conservative default of 200K matches Anthropic
// Sonnet/Opus and the OpenAI Compat default. Specific routes can refine later.
const DEFAULT_CONTEXT_MAX = 200_000;

// ---------------------------------------------------------------------------
// Mutable chat state
// ---------------------------------------------------------------------------

type BusyInputMode = 'interrupt' | 'queue' | 'steer';

interface ChatState {
  sessionKey: string;
  personalityId: string;
  usage: { inputTokens: number; outputTokens: number; costUsd: number };
  /** FW-1 — running max-of-turn context tokens for the status bar. */
  contextTokens: number;
  /** Latest turn's input tokens = current context size. Drives the prompt chip. */
  contextInputTokens: number;
  startedAt: number;
  verbosity: Verbosity;
  busyMode: BusyInputMode;
  toolPreviewLength: number;
  modelName: string;
  /** Steer sink used by AgentLoop when `busyMode === 'steer'`. */
  steerSink: SteerSink;
  /** Inputs typed during an in-flight turn (`queue` mode). FIFO. */
  inputQueue: string[];
  /** Currently running turn — null when idle. */
  abort: AbortController | null;
  /** Phase B — durable background engine handles (undefined when background is disabled). */
  jobStore?: JobStore;
  backgroundExecutor?: import('@ethosagent/wiring').CreateAgentLoopResult['backgroundExecutor'];
  /** Total in-flight iterations seen this turn (for steer pre-first-iteration fallback). */
  iterationsThisTurn: number;
  /**
   * True from the moment the user submits a normal turn through the end of
   * queue-draining. Distinct from `abort` (which is null between consecutive
   * drained turns). Prevents a second `'line'` event from spawning an
   * overlapping `runTurn` while we're mid-drain. (Codex P2 finding #4.)
   */
  draining: boolean;
  /** FW-15/16 — set by handleSlashCommand when a skill/quick command wants to run a turn. */
  pendingTurn?: string;
  /** FW-16 — true while awaiting yes/no consent for quick commands. */
  awaitingConsent: boolean;
  /** True while a `clarify` tool prompt owns the readline loop. */
  awaitingClarify: boolean;
  /** Attachments queued via /attach, drained on the next turn. */
  pendingAttachments: Attachment[];
  /** Pending tier override for the next turn (from /tier command). Consumed once. */
  pendingTierOverride?: 'trivial' | 'default' | 'deep';
  /** Dry-run mode — tools are planned but not executed. */
  dryRun: boolean;
  /** Pending toolset narrowing for the next command-triggered turn. */
  pendingToolsetNarrow?: string[];
}

interface RunChatOptions {
  singleQuery?: string;
  /** FW-2 — resume an existing session by its stored key. */
  resumeSessionKey?: string;
  /** FW-2 — session ID to display in the resume hint and recap. */
  resumeSessionId?: string;
  /** FW-5 — suppress the resume hint on exit regardless of config. */
  noResumeHint?: boolean;
  /** Dry-run mode — tools are planned but not executed. */
  dryRun?: boolean;
}

function renderStatusBarLine(state: ChatState): void {
  const cols = process.stdout.columns ?? 80;
  const bar = renderStatusBar({
    model: state.modelName,
    contextTokens: state.contextTokens,
    contextMax: DEFAULT_CONTEXT_MAX,
    elapsedSecs: Math.floor((Date.now() - state.startedAt) / 1000),
    columns: cols,
  });
  const color = colorForThreshold(bar.threshold);
  out(`${c.dim}⚕ ${color}${bar.text}${c.reset}\n`);
}

// Compact formatter for the context-size chip. Mirrors
// apps/web/src/lib/format-context-tokens.ts exactly so web + CLI read identically.
//   < 1000       → exact           (820)
//   >= 1000      → one-decimal k   (12.4k), trailing `.0` trimmed (12k)
//   >= 1_000_000 → one-decimal M   (1.2M),  trailing `.0` trimmed (2M)
function formatContextTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${trimTrailingZero((n / 1000).toFixed(1))}k`;
  return `${trimTrailingZero((n / 1_000_000).toFixed(1))}M`;
}

function trimTrailingZero(s: string): string {
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

// The interactive input prompt. Prepends a muted context-size chip once the
// first turn has reported usage; before that the prompt is unchanged.
function promptString(state: ChatState): string {
  const base = `${c.cyan}You${c.reset} > `;
  if (state.contextInputTokens <= 0) return base;
  return `${c.dim}[${formatContextTokens(state.contextInputTokens)}]${c.reset} ${base}`;
}

// ---------------------------------------------------------------------------
// Main chat entry point
// ---------------------------------------------------------------------------

export async function runChat(config: EthosConfig, opts: RunChatOptions = {}): Promise<void> {
  // FW-14 — build the shared slash command registry. FW-15 and FW-16 extend it.
  // Built BEFORE the loop so plugin loading (inside resolveActiveLoop) can
  // register plugin slash commands into it via registerSlashCommand.
  const registry = buildBaseRegistry();

  const {
    loop,
    personalityId,
    displayName,
    setOnSkillProposed,
    onMemoryCaptured,
    notificationRouter,
    pluginLoader,
    jobStore,
    backgroundExecutor,
  } = await resolveActiveLoop(config, { slashRegistry: registry });

  // FW-15 — scan global and per-personality skill directories into the registry.
  const storage: Storage = new FsStorage();
  const attachmentCache = new FsAttachmentCache(storage, join(ethosDir(), 'cache', 'attachments'));
  const skillCache = new Map<string, SkillMeta>();
  const globalSkillsDir = join(ethosDir(), 'skills');
  const personalitySkillsDir = join(ethosDir(), 'personalities', personalityId, 'skills');
  await scanSkillsIntoRegistry(
    storage,
    globalSkillsDir,
    personalitySkillsDir,
    registry,
    skillCache,
  );

  // FW-§9.4 — scan file-drop command directories into the registry.
  const commandCache = new Map<string, CommandMeta>();
  const commandDirs: { path: string; scope: import('../lib/command-loader').CommandScope }[] = [
    { path: join(ethosDir(), 'commands'), scope: 'global' },
    { path: join(ethosDir(), 'personalities', personalityId, 'commands'), scope: 'personality' },
    { path: join(process.cwd(), '.ethos', 'commands'), scope: 'project' },
  ];
  await scanCommandsIntoRegistry(storage, commandDirs, registry, commandCache);

  // FW-16 — register user-defined quick commands.
  const quickCommands: Record<string, QuickCommandConfig> = config.quick_commands ?? {};
  for (const [name, qc] of Object.entries(quickCommands)) {
    registry.register({
      name,
      description: qc.type === 'exec' ? `Run: ${qc.command}` : `Reply: ${qc.reply}`,
      usage: `/${name}`,
      prefix: '[quick]',
    });
  }
  let quickConsentGiven = await hasQuickCommandConsent(ethosDir());

  if (opts.singleQuery) {
    await runSingleQuery(loop, config, {
      query: opts.singleQuery,
      sessionKey: `cli:${basename(process.cwd())}`,
      personalityId,
    });
    return;
  }

  if (process.stdout.isTTY && process.stdin.isTTY) {
    const { runTUI } = await import('@ethosagent/tui');
    const inventory = await buildInventory(loop, config);
    await runTUI(loop, {
      model: config.model,
      personality: displayName,
      verbose: config.verbose ?? false,
      skin: config.skin,
      inventory,
      rebuildLoop: async (modelId: string) => {
        const { loop: newLoop } = await resolveActiveLoop({ ...config, model: modelId });
        return newLoop;
      },
      preprocessInput: (text) => resolveAtRefs(text, process.cwd()),
      slashCommands: makeTuiSlashCommands(pluginLoader),
      onNotification: makeTuiNotificationSubscriber(notificationRouter),
      ...(setOnSkillProposed
        ? {
            onSkillProposed: (cb: (text: string) => void) => {
              setOnSkillProposed((skillId, _personalityId) => {
                cb(formatSkillProposedNotice(skillId));
              });
              return () => {
                setOnSkillProposed(() => {});
              };
            },
          }
        : {}),
    });
    return;
  }

  const completer = makeCompleter(registry);
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    ...(completer ? { completer } : {}),
  });

  // Wire skill-evolution notifications into the interactive readline session.
  setOnSkillProposed?.((skillId, _personalityId) => {
    clearLine(process.stdout, 0);
    process.stdout.write(`\n${c.dim}${formatSkillProposedNotice(skillId)}${c.reset}\n> `);
  });

  // memory-experience §3.3 — surface a dim, single-line "remembered" notice when
  // a proactive capture lands (after the turn's event stream has closed). CLI is
  // subtle-on by default; suppressible via `display.memory_notices: false`.
  if (config.displayMemoryNotices !== false) {
    onMemoryCaptured?.((n) => {
      const summary = n.summary.length > 80 ? `${n.summary.slice(0, 79)}…` : n.summary;
      clearLine(process.stdout, 0);
      process.stdout.write(`\n${c.dim}· remembered: ${summary}${c.reset}\n> `);
    });
  }

  const sessionKey = opts.resumeSessionKey ?? `cli:${basename(process.cwd())}`;

  // v2.2 — Register a CLI NotificationAdapter so plugin monitors can deliver
  // messages to the interactive terminal session.
  const cliAdapter: NotificationAdapter = {
    async send(message) {
      console.log(`\n[notification] ${message}`);
    },
    async injectUserMessage(message) {
      // Print the notification; actual input injection requires readline
      // integration which is deferred to a future iteration.
      console.log(`\n[notification] ${message}`);
    },
  };
  notificationRouter.register(sessionKey, cliAdapter);

  const state: ChatState = {
    sessionKey,
    personalityId,
    usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
    contextTokens: 0,
    contextInputTokens: 0,
    startedAt: Date.now(),
    verbosity: config.displayVerbosity ?? (config.verbose ? 'verbose' : 'default'),
    busyMode: config.displayBusyInputMode ?? 'interrupt',
    toolPreviewLength: config.displayToolPreviewLength ?? 0,
    modelName: config.model,
    steerSink: new InMemorySteerSink(),
    inputQueue: [],
    abort: null,
    iterationsThisTurn: 0,
    draining: false,
    ...(jobStore ? { jobStore } : {}),
    ...(backgroundExecutor ? { backgroundExecutor } : {}),
    awaitingConsent: false,
    awaitingClarify: false,
    pendingAttachments: [],
    dryRun: opts.dryRun ?? false,
  };

  // Clarify surface — when the agent calls the `clarify` tool, pause the
  // readline loop, present the question, read one line, and route the answer
  // back. Ctrl-C aborts the turn, which the bridge resolves as a cancel.
  loop.clarifyBridge?.setPresenter((req) => {
    state.awaitingClarify = true;
    out(`\n${c.dim}${formatClarifyPrompt(req)}${c.reset}`);
    rl.setPrompt(`${c.cyan}?${c.reset}> `);
    rl.prompt();

    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      rl.off('line', onLine);
      unsubscribe();
      state.awaitingClarify = false;
      rl.setPrompt(promptString(state));
      if (!state.abort) rl.prompt();
    };
    const onLine = (raw: string) => {
      const answer = parseClarifyAnswer(raw, req.options);
      finish();
      void loop.respondToClarify({ requestId: req.requestId, answer, source: 'user' });
    };
    // Teardown if the request resolves another way first (timeout / abort-cancel).
    const unsubscribe =
      loop.clarifyBridge?.onResolved((row) => {
        if (row.requestId === req.requestId) finish();
      }) ?? (() => {});
    rl.once('line', onLine);
  });

  // Completion notice rendered at the idle prompt — no auto-turn. Auto-triggering
  // a turn while the user is mid-thought is hostile, so we only print and re-prompt.
  // Only `done`/`failed` are surfaced; `aborted` is user-requested and stays silent.
  backgroundExecutor?.onComplete((job) => {
    if (job.status !== 'done' && job.status !== 'failed') return;
    const header = `bg:${job.id.slice(0, 8)}`;
    const statusLine = job.status === 'done' ? 'done' : `error: ${job.error ?? 'unknown'}`;
    const body = job.status === 'done' ? job.summary : undefined;
    out(`\n${c.dim}╭─ background [${header}] ${statusLine}${c.reset}\n`);
    if (body) {
      const lines = body.split('\n').slice(0, 10);
      for (const line of lines) {
        out(`${c.dim}│ ${line}${c.reset}\n`);
      }
      if (body.split('\n').length > 10) {
        out(`${c.dim}│ ... (truncated)${c.reset}\n`);
      }
    }
    out(`${c.dim}╰─${c.reset}\n`);
    if (config.displayBellOnComplete) out('\x07');
    rl.prompt();
  });

  rl.on('SIGINT', () => {
    if (state.abort) {
      state.abort.abort();
      out(`\n${c.dim}[aborted — press Ctrl+C again to exit]${c.reset}\n`);
    } else {
      out('\n');
      rl.close();
    }
  });

  rl.on('close', async () => {
    notificationRouter.deregister(state.sessionKey);
    // Phase B (T9) — warn if durable background jobs are still active for this
    // session's root. They'll be orphaned when the process exits and reappear as
    // `stale`/`expired` on the next boot (`task_status` shows their owner). This
    // is intentionally a simple one-line warning — a full interactive wait/abort
    // prompt is out of scope.
    if (state.jobStore) {
      try {
        const active = await state.jobStore.countActiveByRoot(state.sessionKey);
        if (active > 0) {
          out(
            `\n${c.yellow}[${active} background job${active === 1 ? '' : 's'} still running — ` +
              `they will be orphaned on exit; ${active === 1 ? 'it' : 'they'} will show as ` +
              `stale/expired on next boot]${c.reset}\n`,
          );
        }
      } catch {
        // best-effort — never block exit on a store read failure
      }
    }
    if (config.displayResumeHint !== false && !opts.noResumeHint) {
      try {
        const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
        const store = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
        try {
          const session = await store.getSessionByKey(state.sessionKey);
          if (session) {
            const messages = await store.getMessages(session.id);
            const userCount = messages.filter((m) => m.role === 'user').length;
            const hint = formatResumeHint({
              sessionId: session.id,
              title: session.title,
              durationMs: Date.now() - state.startedAt,
              userMessageCount: userCount,
              totalMessageCount: messages.length,
            });
            if (hint) out(`\n${c.dim}${hint}${c.reset}\n`);
          }
        } finally {
          store.close();
        }
      } catch {
        // best-effort — don't break exit on hint failure
      }
    }
    process.exit(0);
  });

  // Welcome
  out(`${c.bold}ethos${c.reset}  ${c.dim}${config.model} · ${displayName} · /help${c.reset}\n\n`);

  // FW-6 — show recap panel when resuming
  if (opts.resumeSessionId) {
    try {
      const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
      const store = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
      try {
        const messages = await store.getMessages(opts.resumeSessionId);
        const recap = formatRecap(messages, { turns: config.displayResumeRecapTurns ?? 3 });
        if (recap) {
          for (const line of recap.lines) out(`${c.dim}${line}${c.reset}\n`);
          out('\n');
        }
      } finally {
        store.close();
      }
    } catch {
      // best-effort
    }
  }

  if (state.verbosity !== 'quiet') renderStatusBarLine(state);

  // FW-15/16 — build the slash handler context (skill cache + quick commands).
  const slashCtx: SlashHandlerContext = {
    skillCache,
    commandCache,
    storage,
    quickCommands,
    isQuickConsentGiven: () => quickConsentGiven,
    grantConsent: async () => {
      quickConsentGiven = true;
      await grantQuickCommandConsent(ethosDir());
    },
    attachmentCache,
    notificationRouter,
    cliAdapter,
    pluginLoader,
  };

  // Switch from blocking rl.question to event-driven rl.on('line') so mid-turn
  // input can be dispatched on busyMode.
  rl.setPrompt(promptString(state));
  rl.prompt();

  rl.on('line', (raw) => {
    // FW-16 — block all input while the consent prompt is active.
    if (state.awaitingConsent) return;
    // A clarify prompt owns the loop via its own one-shot `line` listener.
    if (state.awaitingClarify) return;

    const input = raw.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    // Slash commands are always dispatched immediately — even mid-turn — except
    // /busy and /steer which have special busy-state semantics handled below.
    const isBusySlash = input.startsWith('/busy') || input.startsWith('/steer');
    if (input.startsWith('/') && !isBusySlash) {
      handleSlashCommand(input, state, loop, rl, config, registry, slashCtx)
        .then(() => {
          if (state.pendingTurn) {
            const pending = state.pendingTurn;
            state.pendingTurn = undefined;
            state.draining = true;
            runTurn(pending, state, loop)
              .then(() => {
                state.draining = false;
                if (state.verbosity !== 'quiet') renderStatusBarLine(state);
                rl.setPrompt(promptString(state));
                rl.prompt();
              })
              .catch((err) => {
                state.draining = false;
                out(
                  `${c.red}Error: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`,
                );
                rl.prompt();
              });
            return;
          }
          // Only re-prompt when idle; a running turn will prompt on completion.
          if (!state.draining && !state.abort) {
            rl.setPrompt(promptString(state));
            rl.prompt();
          }
        })
        .catch((err) => {
          out(`${c.red}Error: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
          if (!state.draining && !state.abort) rl.prompt();
        });
      return;
    }

    // Mid-drain / mid-turn: route non-slash input (and /busy, /steer) through
    // the busy handler so two consecutive 'line' events can't spawn overlapping turns.
    if (state.draining || state.abort) {
      handleBusyInput(input, state);
      return;
    }

    state.draining = true;
    resolveAtRefs(input, process.cwd())
      .then((resolved) => runTurn(resolved, state, loop))
      .then(() => {
        const drainNext = () => {
          const next = state.inputQueue.shift();
          if (!next) {
            state.draining = false;
            if (state.verbosity !== 'quiet') renderStatusBarLine(state);
            rl.setPrompt(promptString(state));
            rl.prompt();
            return;
          }
          out(`${c.dim}[draining queue → ${next}]${c.reset}\n`);
          runTurn(next, state, loop)
            .then(drainNext)
            .catch((err) => {
              state.draining = false;
              out(`${c.red}Error: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
              rl.prompt();
            });
        };
        drainNext();
      })
      .catch((err) => {
        state.draining = false;
        out(`${c.red}Error: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`);
        rl.prompt();
      });
  });
}

// ---------------------------------------------------------------------------
// FW-9 — busy-input dispatch
// ---------------------------------------------------------------------------

function handleBusyInput(input: string, state: ChatState): void {
  // /steer <text> and /busy <mode|status> always work regardless of mode.
  if (input.startsWith('/steer ')) {
    const text = input.slice('/steer '.length).trim();
    pushSteer(text, state);
    return;
  }
  if (input.startsWith('/busy')) {
    const arg = input.slice('/busy'.length).trim();
    handleBusyCommand(arg, state);
    return;
  }

  switch (state.busyMode) {
    case 'interrupt': {
      state.abort?.abort();
      // Queue the new input — it fires on the next prompt cycle after the
      // current turn unwinds.
      state.inputQueue.unshift(input);
      out(`${c.dim}[interrupted — restarting with new input]${c.reset}\n`);
      return;
    }
    case 'queue': {
      state.inputQueue.push(input);
      out(`${c.dim}[queued — depth ${state.inputQueue.length}]${c.reset}\n`);
      return;
    }
    case 'steer': {
      pushSteer(input, state);
      return;
    }
  }
}

function pushSteer(text: string, state: ChatState): void {
  if (!text) return;
  // Pre-first-iteration steers fall back to queue (LLM hasn't called yet, so
  // no tool_results to attach to). Iterations >0 reach the seam.
  if (state.iterationsThisTurn === 0) {
    state.inputQueue.push(text);
    out(
      `${c.dim}[steer → queued (pre-first-iteration), depth ${state.inputQueue.length}]${c.reset}\n`,
    );
    return;
  }
  const ok = state.steerSink.push(text);
  if (!ok) {
    out(`${c.red}[steer sink full — dropped]${c.reset}\n`);
    return;
  }
  out(`${c.dim}[steer queued — folds in at next iteration]${c.reset}\n`);
}

function handleBusyCommand(arg: string, state: ChatState): void {
  if (!arg || arg === 'status') {
    out(`${c.dim}busy mode: ${state.busyMode}${c.reset}\n`);
    return;
  }
  if (arg === 'interrupt' || arg === 'queue' || arg === 'steer') {
    state.busyMode = arg;
    out(`${c.dim}busy mode: ${arg}${c.reset}\n`);
    return;
  }
  out(`${c.dim}Usage: /busy [interrupt|queue|steer|status]${c.reset}\n`);
}

// ---------------------------------------------------------------------------
// Turn runner
// ---------------------------------------------------------------------------

async function runTurn(input: string, state: ChatState, loop: AgentLoop): Promise<void> {
  state.abort = new AbortController();
  state.iterationsThisTurn = 0;

  const reducedMotion = process.env.ETHOS_NO_SPINNER_ANIMATION === '1';
  const spinner = new SpinnerState({ reducedMotion });
  spinner.start(Date.now());

  let spinnerCleared = false;
  if (state.verbosity !== 'quiet') {
    out(
      `${c.bold}ethos${c.reset} ${c.dim}${spinner.frame()} thinking ${spinner.elapsed()}${c.reset}`,
    );
  }
  const spinnerInterval = setInterval(
    () => {
      spinner.tick(Date.now());
      if (!spinnerCleared && state.verbosity !== 'quiet') {
        out(
          `\r${c.bold}ethos${c.reset} ${c.dim}${spinner.frame()} thinking ${spinner.elapsed()}${c.reset}`,
        );
      }
    },
    reducedMotion ? 500 : 100,
  );

  function clearSpinner(): void {
    if (spinnerCleared) return;
    spinnerCleared = true;
    spinner.stop(Date.now());
    clearInterval(spinnerInterval);
    if (state.verbosity !== 'quiet') {
      // Wipe the spinner line cleanly so trailing chars don't bleed into output.
      out('\r\x1b[2K');
    }
  }

  const turnStart = Date.now();
  let firstTextDeltaAt: number | null = null;
  const toolDurations: number[] = [];
  let turnUsage: TurnTiming['turnUsage'] = null;
  const toolStartTimes = new Map<string, number>();
  const toolArgs = new Map<string, unknown>();
  const toolNames = new Map<string, string>();
  let hasText = false;

  // Drain pending attachments — pass to loop.run() and clear the list.
  const turnAttachments =
    state.pendingAttachments.length > 0 ? state.pendingAttachments.splice(0) : undefined;

  try {
    const tierOverride = state.pendingTierOverride;
    state.pendingTierOverride = undefined;
    const toolsetNarrow = state.pendingToolsetNarrow;
    state.pendingToolsetNarrow = undefined;
    for await (const event of loop.run(input, {
      sessionKey: state.sessionKey,
      personalityId: state.personalityId,
      abortSignal: state.abort.signal,
      ...(state.busyMode === 'steer' ? { steerSink: state.steerSink } : {}),
      ...(turnAttachments ? { attachments: turnAttachments } : {}),
      ...(tierOverride ? { tierOverride } : {}),
      ...(toolsetNarrow ? { toolsetNarrow } : {}),
      ...(state.dryRun ? { dryRun: true } : {}),
    })) {
      // Lane E (tools-as-code-api) — in-script inner calls carry
      // `audience: 'internal'`. They must not drive turn-level UI state
      // (iteration proxy, spinner, duration stats); rendering is gated in
      // projectEvent (verbosity.ts).
      const internalToolEvent =
        (event.type === 'tool_start' || event.type === 'tool_end') && event.audience === 'internal';

      // Track iteration count — proxy by counting `run_start`+tool_start sequences.
      // Per AgentLoop, an iteration starts on before_llm_call hook. We don't get
      // that event externally, so use first tool_start or text_delta as proxy.
      if (event.type === 'text_delta' || (event.type === 'tool_start' && !internalToolEvent)) {
        if (state.iterationsThisTurn === 0) state.iterationsThisTurn = 1;
      }
      if (event.type === 'tool_end' && !internalToolEvent) {
        // A tool_end -> next iteration boundary, so the steer drain fires next.
        state.iterationsThisTurn++;
      }

      if (event.type === 'tool_start' && !internalToolEvent) {
        toolStartTimes.set(event.toolCallId, Date.now());
        toolArgs.set(event.toolCallId, event.args);
        toolNames.set(event.toolCallId, event.toolName);
      }
      if (event.type === 'text_delta' && firstTextDeltaAt === null) {
        firstTextDeltaAt = Date.now();
        clearSpinner();
        if (state.verbosity !== 'quiet') out(`${c.bold}ethos${c.reset} > `);
      }
      if (event.type === 'tool_start' && !internalToolEvent && !spinnerCleared) {
        clearSpinner();
        if (state.verbosity !== 'quiet') out('\n');
      }
      if (event.type === 'tool_end' && !internalToolEvent) {
        toolDurations.push(event.durationMs);
      }
      if (event.type === 'usage') {
        turnUsage = {
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          estimatedCostUsd: event.estimatedCostUsd,
        };
        state.contextTokens = event.inputTokens + event.outputTokens;
        // Latest turn's input tokens = current context size (mirrors web composer).
        state.contextInputTokens = event.inputTokens;
      }
      if (event.type === 'error') clearSpinner();

      renderEventForVerbosity(event, state, {
        hasText,
        toolStartTimes,
        toolArgs,
        toolNames,
      });

      if (event.type === 'text_delta') hasText = true;

      if (event.type === 'done') {
        clearSpinner();
        // W4.1 — first-ever completed turn stamps funnel.first_reply (no-op after).
        void getFunnelTracker().recordFirstReply();
        if (state.verbosity === 'verbose' || state.verbosity === 'debug') {
          const summary = formatVerboseSummary({
            turnStart,
            turnEnd: Date.now(),
            firstTextDeltaAt,
            toolDurations,
            turnUsage,
          });
          out(`\n${c.dim}${summary}${c.reset}`);
        }
      }
    }
  } catch (err) {
    clearSpinner();
    if (!state.abort?.signal.aborted) {
      out(`\n${c.red}Error: ${err instanceof Error ? err.message : String(err)}${c.reset}`);
    }
  } finally {
    clearInterval(spinnerInterval);
    state.abort = null;
    // Codex P2 #2 — steers attach to an iteration seam (tool_results). A
    // text-only turn (no tools) has no seam, so a steer typed during it
    // would otherwise linger and fold into a later, unrelated turn. Drop
    // anything still queued when this turn ends.
    const stranded = state.steerSink.drain();
    if (stranded.length > 0 && state.verbosity !== 'quiet') {
      out(
        `${c.yellow}[discarded ${stranded.length} unread steer${stranded.length === 1 ? '' : 's'} — no tool seam in turn]${c.reset}\n`,
      );
    }
    if (state.verbosity !== 'quiet') out('\n\n');
  }
}

// ---------------------------------------------------------------------------
// Event renderer
// ---------------------------------------------------------------------------

interface RenderContext {
  hasText: boolean;
  toolStartTimes: Map<string, number>;
  toolArgs: Map<string, unknown>;
  toolNames: Map<string, string>;
}

function renderEventForVerbosity(event: AgentEvent, state: ChatState, ctx: RenderContext): void {
  const lines = projectEvent(event, state.verbosity);
  if (lines.length === 0) return;

  switch (event.type) {
    case 'text_delta':
      out(stripAnsiEscapes(event.text));
      break;

    case 'tool_start':
      if (state.verbosity === 'verbose' || state.verbosity === 'debug') {
        if (ctx.hasText) out('\n');
        out(`${c.dim}  ⟳ ${event.toolName}${c.reset}\n`);
      }
      break;

    case 'tool_progress':
      if (state.verbosity === 'default' && !shouldSurfaceProgress(event)) break;
      if (event.toolName === '_watcher') {
        out(`${c.yellow}  ${stripAnsiEscapes(event.message)}${c.reset}\n`);
      } else {
        out(`${c.dim}  · ${event.toolName}: ${stripAnsiEscapes(event.message)}${c.reset}\n`);
      }
      break;

    case 'tool_end': {
      const startedAt = ctx.toolStartTimes.get(event.toolCallId) ?? Date.now();
      const ms = Date.now() - startedAt;
      ctx.toolStartTimes.delete(event.toolCallId);
      const args = ctx.toolArgs.get(event.toolCallId) ?? {};
      ctx.toolArgs.delete(event.toolCallId);
      ctx.toolNames.delete(event.toolCallId);
      const line = formatToolFeedLine({
        toolName: event.toolName,
        args,
        durationMs: event.durationMs ?? ms,
        previewLength: state.toolPreviewLength,
      });
      const mark = event.ok ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
      out(`${c.dim}  ${mark} ${line}${c.reset}\n`);
      break;
    }

    case 'usage':
      state.usage.inputTokens += event.inputTokens;
      state.usage.outputTokens += event.outputTokens;
      state.usage.costUsd += event.estimatedCostUsd;
      break;

    case 'error':
      out(`\n${c.red}[${event.code}] ${event.error}${c.reset}`);
      break;

    case 'run_start':
      if (state.verbosity === 'verbose' || state.verbosity === 'debug') {
        out(`${c.dim}↳ ${event.provider}/${event.model} (${event.source})${c.reset}\n`);
      }
      break;

    case 'dry_run_summary': {
      const label = `Dry-run plan (${event.plan.length} tool call${event.plan.length === 1 ? '' : 's'}${event.capped > 0 ? `, ${event.capped} capped` : ''}):`;
      out(`\n${c.cyan}${c.bold}${label}${c.reset}\n`);
      for (const step of event.plan) {
        const argsPreview = JSON.stringify(step.args).slice(0, 120);
        out(`  ${c.dim}${step.toolName}${c.reset} ${argsPreview}\n`);
      }
      out('\n');
      break;
    }

    case 'thinking_delta':
    case 'done':
    case 'context_meta':
      // Not surfaced in the rendered stream.
      break;

    default:
      // Forward-compat: AgentEvent may grow new variants in any release.
      // Unknown types are a no-op here by design — do NOT add an
      // `assertNever(event)` exhaustiveness check; it would force a
      // breaking change on every consumer the moment a new event ships.
      // See KNOWN_AGENT_EVENT_TYPES in @ethosagent/core for the current
      // known set; use `isKnownAgentEvent` for opt-in dev-mode warnings.
      break;
  }

  // Debug verbosity: dump raw JSON for every event (after primary render).
  if (state.verbosity === 'debug') {
    out(`${c.dim}[debug] ${JSON.stringify(event)}${c.reset}\n`);
  }
}

// ---------------------------------------------------------------------------
// Single-query (non-interactive) runner
// ---------------------------------------------------------------------------

async function runSingleQuery(
  loop: AgentLoop,
  config: EthosConfig,
  input: { query: string; sessionKey: string; personalityId: string },
): Promise<void> {
  const verbosity: Verbosity = config.displayVerbosity ?? (config.verbose ? 'verbose' : 'default');
  const turnStart = Date.now();
  let firstTextDeltaAt: number | null = null;
  const toolDurations: number[] = [];
  let turnUsage: TurnTiming['turnUsage'] = null;

  for await (const event of loop.run(input.query, {
    sessionKey: input.sessionKey,
    personalityId: input.personalityId,
  })) {
    if (event.type === 'text_delta') {
      if (firstTextDeltaAt === null) firstTextDeltaAt = Date.now();
      out(event.text);
    }
    if (event.type === 'tool_end') toolDurations.push(event.durationMs);
    if (event.type === 'usage') {
      turnUsage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        estimatedCostUsd: event.estimatedCostUsd,
      };
    }
    if (event.type === 'done' && (verbosity === 'verbose' || verbosity === 'debug')) {
      const summary = formatVerboseSummary({
        turnStart,
        turnEnd: Date.now(),
        firstTextDeltaAt,
        toolDurations,
        turnUsage,
      });
      out(`\n${c.dim}${summary}${c.reset}`);
    }
  }
  out('\n');
}

// ---------------------------------------------------------------------------
// Slash commands
// ---------------------------------------------------------------------------

interface SlashHandlerContext {
  skillCache: Map<string, SkillMeta>;
  commandCache: Map<string, CommandMeta>;
  storage: Storage;
  quickCommands: Record<string, QuickCommandConfig>;
  isQuickConsentGiven: () => boolean;
  grantConsent: () => Promise<void>;
  attachmentCache: import('@ethosagent/types').AttachmentCache;
  notificationRouter: import('@ethosagent/types').NotificationRouter;
  cliAdapter: NotificationAdapter;
  pluginLoader?: import('@ethosagent/plugin-loader').PluginLoader;
}

/**
 * Build the /help body. Static built-in commands first, then any
 * plugin-registered slash commands with a `[plugin]` suffix. Exported for
 * unit testing the merge.
 */
export function buildChatHelpText(
  pluginCommands: { name: string; description: string }[] = [],
): string {
  let text =
    `  /title <name>         set a name for this session\n` +
    `  /title                show current session title\n` +
    `  /new                  start a fresh session\n` +
    `  /personality          show current personality\n` +
    `  /personality list     list all personalities\n` +
    `  /personality <id>     switch personality\n` +
    `  /model <name>         switch model for this session\n` +
    `  /tier <name>          override tier for next turn (trivial|default|deep)\n` +
    `  /memory               show ~/.ethos/MEMORY.md and USER.md\n` +
    `  /usage                show token and cost stats\n` +
    `  /budget               show session spend against cap\n` +
    `  /budget reset         reset the session budget counter\n` +
    `  /verbose              cycle quiet → default → verbose → debug\n` +
    `  /verbose <level>      set level directly\n` +
    `  /background <prompt>  spawn a background agent task\n` +
    `  /background list      show all background tasks\n` +
    `  /background cancel <id>  abort a running background task\n` +
    `  /verbose status       show current level\n` +
    `  /busy <mode|status>   busy-input mode (interrupt/queue/steer)\n` +
    `  /attach <path>        attach a file to the next message\n` +
    `  /compact [focus]      compress older context now (optional focus hint)\n` +
    `  /compact status       show context anatomy (system/tools/messages tokens)\n` +
    `  /undo [N]             undo last N turns (default 1)\n` +
    `  /dry-run on|off      toggle dry-run mode (plan tools without executing)\n` +
    `  /goal <text>          create and start a new goal\n` +
    `  /goal cancel|resume|steer <id>  manage a running goal\n` +
    `  /goals                list recent goals\n` +
    `  /steer <text>         inject [USER STEER] mid-turn\n` +
    `  /allow <code>         approve a pending channel sender by pairing code\n` +
    `  /deny <platform> <id> revoke an approved channel sender\n` +
    `  /communications       list approved senders + pending pairing codes\n` +
    `  /exit                 quit\n`;
  for (const cmd of pluginCommands) {
    text += `  /${cmd.name.padEnd(20)} ${cmd.description} [plugin]\n`;
  }
  return text;
}

async function handleSlashCommand(
  raw: string,
  state: ChatState,
  loop: AgentLoop,
  rl: ReturnType<typeof createInterface>,
  _config: EthosConfig,
  registry: SlashCommandRegistry,
  ctx: SlashHandlerContext,
): Promise<void> {
  const { name, arg } = parseSlashCommand(raw);

  switch (name) {
    case 'help':
      out(`\n${c.dim}${buildChatHelpText(ctx.pluginLoader?.getAllSlashCommands())}${c.reset}\n`);
      break;

    case 'new':
    case 'reset':
      loop.resetSessionCost(state.sessionKey);
      ctx.notificationRouter.deregister(state.sessionKey);
      state.sessionKey = `cli:${basename(process.cwd())}:${Date.now()}`;
      ctx.notificationRouter.register(state.sessionKey, ctx.cliAdapter);
      state.contextTokens = 0;
      state.contextInputTokens = 0;
      state.startedAt = Date.now();
      out(`${c.dim}[new session started]${c.reset}\n`);
      break;

    case 'personality': {
      if (!arg) {
        out(`${c.dim}Current: ${state.personalityId}${c.reset}\n`);
        break;
      }
      if (arg === 'list') {
        out(
          `${c.dim}Built-ins: researcher · engineer · reviewer · coach · operator\n` +
            `User personalities: ~/.ethos/personalities/<id>/\n${c.reset}`,
        );
        break;
      }
      state.personalityId = arg;
      out(`${c.dim}[personality: ${arg}]${c.reset}\n`);
      break;
    }

    case 'model': {
      if (!arg) {
        out(`${c.dim}Current model: ${_config.model}${c.reset}\n`);
        break;
      }
      out(
        `${c.yellow}Model switching takes effect on next restart. Edit ~/.ethos/config.yaml to persist.${c.reset}\n`,
      );
      break;
    }

    case 'tier': {
      const validTiers = ['trivial', 'default', 'deep'];
      if (!arg || arg === 'status') {
        out(
          `${c.dim}Tier override: use /tier [trivial|default|deep] to set for next turn.${c.reset}\n`,
        );
        break;
      }
      if (!validTiers.includes(arg)) {
        out(`${c.yellow}Invalid tier '${arg}'. Valid: ${validTiers.join(' | ')}${c.reset}\n`);
        break;
      }
      state.pendingTierOverride = arg as 'trivial' | 'default' | 'deep';
      out(`${c.dim}[next turn will use tier: ${arg}]${c.reset}\n`);
      break;
    }

    case 'memory': {
      const { createMemoryProvider } = await import('@ethosagent/wiring');
      const { ethosDir } = await import('@ethosagent/config');
      const mem = createMemoryProvider({ dataDir: ethosDir(), storage: getStorage() });
      const result = await mem.prefetch({
        scopeId: `personality:${state.personalityId}`,
        sessionId: '',
        sessionKey: state.sessionKey,
        platform: 'cli',
        workingDir: process.cwd(),
      });
      if (result && result.entries.length > 0) {
        out(`\n${result.entries.map((e) => e.content.trim()).join('\n\n')}\n\n`);
      } else {
        out(`${c.dim}[no memory yet — chat to build it]${c.reset}\n`);
      }
      break;
    }

    case 'usage':
      out(
        `${c.dim}` +
          `Tokens  : ${state.usage.inputTokens.toLocaleString()} in · ${state.usage.outputTokens.toLocaleString()} out\n` +
          `Cost    : $${state.usage.costUsd.toFixed(5)}\n` +
          `${c.reset}`,
      );
      break;

    case 'budget': {
      if (arg === 'reset') {
        loop.resetSessionCost(state.sessionKey);
        out(`${c.dim}[budget counter reset]${c.reset}\n`);
        break;
      }
      const spent = loop.getSessionCost(state.sessionKey);
      out(
        `${c.dim}Session spend: $${spent.toFixed(5)}\n` +
          `Use /budget reset to clear the counter.\n${c.reset}`,
      );
      break;
    }

    case 'verbose': {
      if (!arg) {
        state.verbosity = nextVerbosity(state.verbosity);
        out(`${c.dim}verbosity: ${state.verbosity}${c.reset}\n`);
        break;
      }
      if (arg === 'status') {
        out(`${c.dim}verbosity: ${state.verbosity}${c.reset}\n`);
        break;
      }
      if (isVerbosity(arg)) {
        state.verbosity = arg;
        out(`${c.dim}verbosity: ${arg}${c.reset}\n`);
        break;
      }
      out(
        `${c.yellow}Invalid level '${arg}' — falling back to default. Valid: quiet|default|verbose|debug${c.reset}\n`,
      );
      state.verbosity = 'default';
      break;
    }

    case 'busy':
      handleBusyCommand(arg, state);
      break;

    case 'steer':
      // When idle, /steer queues as a fresh turn (no in-flight run to steer).
      if (!arg) {
        out(`${c.dim}Usage: /steer <text>${c.reset}\n`);
        break;
      }
      if (!state.abort) {
        state.inputQueue.push(arg);
        out(`${c.dim}[idle — /steer queued as a turn]${c.reset}\n`);
        break;
      }
      pushSteer(arg, state);
      break;

    case 'allow': {
      if (!arg) {
        out(`${c.dim}Usage: /allow <code>${c.reset}\n`);
        break;
      }
      const r = await runPairingCommand('allow', { code: arg });
      out(`${c.dim}${r}${c.reset}\n`);
      break;
    }

    case 'deny': {
      const tokens = arg.split(/\s+/).filter(Boolean);
      if (tokens.length < 2) {
        out(`${c.dim}Usage: /deny <platform> <senderId>${c.reset}\n`);
        break;
      }
      const r = await runPairingCommand('deny', {
        platform: tokens[0],
        senderId: tokens.slice(1).join(' '),
      });
      out(`${c.dim}${r}${c.reset}\n`);
      break;
    }

    case 'communications':
    case 'comms': {
      const r = await runPairingCommand('list', {});
      out(`${c.dim}${r}${c.reset}\n`);
      break;
    }

    case 'title': {
      const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
      const store = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
      try {
        const session = await store.getSessionByKey(state.sessionKey);
        if (!session) {
          out(`${c.dim}[no session found — send a message first]${c.reset}\n`);
          break;
        }
        if (!arg) {
          // No args: print current title
          out(`${c.dim}Title: ${session.title ?? '(none)'}${c.reset}\n`);
          break;
        }
        // Empty string arg: clear title
        const newTitle = arg === '""' || arg === "''" ? null : arg;
        await store.setTitle(session.id, newTitle);
        if (newTitle) {
          out(`${c.dim}[ titled: ${newTitle} ]${c.reset}\n`);
        } else {
          out(`${c.dim}[ title cleared ]${c.reset}\n`);
        }
      } finally {
        store.close();
      }
      break;
    }

    case 'attach': {
      if (!arg) {
        out(`${c.dim}Usage: /attach <path>${c.reset}\n`);
        break;
      }
      try {
        const absPath = resolve(arg);
        const bytes = await readFile(absPath);
        const filename = basename(absPath);
        const mime = mimeFromExtension(filename);
        const url = await ctx.attachmentCache.write(new Uint8Array(bytes), {
          sessionKey: state.sessionKey,
          messageId: Date.now().toString(),
          filename,
          mime,
        });
        const isImage = mime.startsWith('image/');
        const attachment: Attachment = {
          type: isImage ? 'image' : 'file',
          ref: `cli-${Date.now()}`,
          url,
          mimeType: mime,
          filename,
          sizeBytes: bytes.byteLength,
        };
        state.pendingAttachments.push(attachment);
        out(
          `${c.dim}[attached ${filename} (${(bytes.byteLength / 1024).toFixed(1)} KB) — send a message to include it]${c.reset}\n`,
        );
      } catch (err) {
        out(
          `${c.red}Failed to attach: ${err instanceof Error ? err.message : String(err)}${c.reset}\n`,
        );
      }
      break;
    }

    case 'dry-run': {
      if (arg === 'on') {
        state.dryRun = true;
        out(`${c.dim}[dry-run mode ON — tools will not execute]${c.reset}\n`);
      } else if (arg === 'off') {
        state.dryRun = false;
        out(`${c.dim}[dry-run mode OFF — tools execute normally]${c.reset}\n`);
      } else {
        out(`${c.dim}Dry-run: ${state.dryRun ? 'ON' : 'OFF'}. Usage: /dry-run on|off${c.reset}\n`);
      }
      break;
    }

    case 'goal': {
      if (!arg) {
        out(
          `${c.dim}Usage: /goal <description> | /goal cancel|resume|steer <id> [message]${c.reset}\n`,
        );
        break;
      }
      const subParts = arg.split(/\s+/);
      const sub = subParts[0]?.toLowerCase();

      if (sub === 'cancel' || sub === 'resume' || sub === 'steer') {
        const goalId = subParts[1];
        if (!goalId) {
          out(`${c.yellow}Usage: /goal ${sub} <goal-id>${c.reset}\n`);
          break;
        }
        const { SQLiteGoalStore } = await import('@ethosagent/goal-store');
        const { GoalRunner } = await import('@ethosagent/goal-runner');
        const store = new SQLiteGoalStore(join(ethosDir(), 'goals.db'));
        const runner = new GoalRunner({ store });
        try {
          if (sub === 'cancel') {
            const ok = runner.cancel(goalId);
            out(
              ok
                ? `${c.green}Goal cancelled.${c.reset}\n`
                : `${c.yellow}Cannot cancel goal ${goalId}.${c.reset}\n`,
            );
          } else if (sub === 'resume') {
            const ok = await runner.resume(goalId);
            out(
              ok
                ? `${c.green}Goal resumed.${c.reset}\n`
                : `${c.yellow}Cannot resume goal ${goalId}.${c.reset}\n`,
            );
          } else {
            const msg = subParts.slice(2).join(' ');
            if (!msg) {
              out(`${c.yellow}Usage: /goal steer <id> <message>${c.reset}\n`);
              break;
            }
            const ok = runner.steer(goalId, msg);
            out(
              ok
                ? `${c.dim}Steer sent.${c.reset}\n`
                : `${c.yellow}Cannot steer goal ${goalId}.${c.reset}\n`,
            );
          }
        } finally {
          store.close();
        }
        break;
      }

      // Default: create a new goal
      const { SQLiteGoalStore } = await import('@ethosagent/goal-store');
      const { GoalRunner } = await import('@ethosagent/goal-runner');
      const store = new SQLiteGoalStore(join(ethosDir(), 'goals.db'));
      const runner = new GoalRunner({ store });
      try {
        const goal = store.create({
          userId: 'default-user',
          personalityId: state.personalityId,
          origin: 'cli',
          title: arg.slice(0, 80),
          goalText: arg,
        });
        out(`${c.green}Goal created: ${goal.id}${c.reset}\n`);
        out(`${c.dim}  "${goal.goalText}"${c.reset}\n`);
        out(`${c.dim}  Status: ${goal.status} · /goals to list${c.reset}\n`);
        await runner.startGoal(goal.id);
      } finally {
        store.close();
      }
      break;
    }

    case 'goals': {
      const { SQLiteGoalStore } = await import('@ethosagent/goal-store');
      const store = new SQLiteGoalStore(join(ethosDir(), 'goals.db'));
      try {
        const goals = store.list({ limit: 10 });
        if (goals.length === 0) {
          out(`${c.dim}No goals yet. Use /goal <text> to create one.${c.reset}\n`);
        } else {
          out(`${c.dim}Recent goals:${c.reset}\n`);
          for (const g of goals) {
            const status =
              g.status === 'completed'
                ? `${c.green}${g.status}${c.reset}`
                : g.status === 'failed'
                  ? `${c.red}${g.status}${c.reset}`
                  : `${c.dim}${g.status}${c.reset}`;
            const title = g.title.length > 50 ? `${g.title.slice(0, 50)}...` : g.title;
            out(`  ${c.dim}${g.id.slice(0, 8)}${c.reset}  ${status}  ${title}\n`);
          }
        }
      } finally {
        store.close();
      }
      break;
    }

    case 'undo': {
      const count = Math.max(1, Number.parseInt(arg || '1', 10) || 1);
      const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
      const store = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
      try {
        const session = await store.getSessionByKey(state.sessionKey);
        if (!session) {
          out(`${c.dim}[no session found — send a message first]${c.reset}\n`);
          break;
        }
        const removed = await store.undoTurns(session.id, count);
        if (!removed) {
          out(`${c.dim}[nothing to undo]${c.reset}\n`);
        } else {
          out(`${c.dim}[undid ${removed} turn${removed > 1 ? 's' : ''}]${c.reset}\n`);
        }
      } finally {
        store.close();
      }
      break;
    }

    case 'compact': {
      if (arg === 'status') {
        await printCompactStatus(state.sessionKey);
        break;
      }
      out(`${c.dim}[compacting context…]${c.reset}\n`);
      const result = await loop.compact(state.sessionKey, {
        personalityId: state.personalityId,
        ...(arg ? { instructions: arg } : {}),
      });
      if (!result.ok) {
        out(
          result.reason === 'no_session'
            ? `${c.dim}[no session yet — send a message first]${c.reset}\n`
            : `${c.dim}[not enough history to compact yet]${c.reset}\n`,
        );
        break;
      }
      const saved = Math.max(0, result.preTotalTokens - result.postTotalTokens);
      out(
        `${c.green}[compacted ${result.droppedCount} earlier message(s) via ${result.engineName}: ` +
          `${result.preTotalTokens.toLocaleString()} → ${result.postTotalTokens.toLocaleString()} tok, ` +
          `−${saved.toLocaleString()}]${c.reset}\n`,
      );
      if (!result.summariesEnabled) {
        out(
          `${c.yellow}[summaries disabled — dropped older messages. Set auxiliary.compression.model ` +
            `in ~/.ethos/config.yaml to enable summarized compaction.]${c.reset}\n`,
        );
      }
      // Reflect the shrunk context in the prompt chip immediately.
      state.contextInputTokens = result.postTotalTokens;
      break;
    }

    case 'exit':
    case 'quit':
      rl.close();
      break;

    case 'background':
    case 'bg':
      await handleBackgroundCommand(arg, state);
      break;

    case 'learn': {
      const { parseLearnArgs, buildLearnPrompt } = await import('@ethosagent/core');
      const parsed = parseLearnArgs(arg);
      state.pendingTurn = buildLearnPrompt({
        hint: parsed.hint,
        description: parsed.description,
        personalityId: state.personalityId,
        sessionKey: state.sessionKey,
        surface: 'cli',
      });
      break;
    }

    default: {
      const cmd = registry.get(name);
      if (cmd?.prefix === '[skill]') {
        const meta = await refreshSkillIfStale(ctx.storage, name, ctx.skillCache);
        if (meta) {
          if (!arg && meta.usage) {
            out(`${c.dim}Usage: ${meta.usage}${c.reset}\n`);
            break;
          }
          state.pendingTurn = arg
            ? `[Skill: ${name}]\n\n${meta.content}\n\n${arg}`
            : `[Skill: ${name}]\n\n${meta.content}`;
        }
        break;
      }
      if (cmd?.prefix === '[command]') {
        const meta = await refreshCommandIfStale(ctx.storage, name, ctx.commandCache);
        if (meta) {
          state.pendingTurn = arg
            ? `[Command: ${name}]\n\n${meta.definition.prompt}\n\n${arg}`
            : `[Command: ${name}]\n\n${meta.definition.prompt}`;
          if (meta.definition.allowedTools?.length) {
            state.pendingToolsetNarrow = meta.definition.allowedTools;
          }
        }
        break;
      }
      if (cmd?.prefix === '[quick]') {
        const qcfg = ctx.quickCommands[name];
        if (!qcfg) break;
        if (qcfg.type === 'reply') {
          // Canned reply — no shell involved, so no consent gate.
          out(`${qcfg.reply}\n`);
          break;
        }
        if (!ctx.isQuickConsentGiven()) {
          state.awaitingConsent = true;
          process.stdout.write(
            `Quick commands let you run shell commands as \`${process.env.USER ?? 'user'}\`. Continue? [y/N] `,
          );
          const answer = await new Promise<string>((resolve) => {
            rl.once('line', (line) => resolve(line.trim()));
          });
          state.awaitingConsent = false;
          if (answer.toLowerCase() !== 'y') {
            out(`${c.dim}[quick command cancelled]${c.reset}\n`);
            break;
          }
          await ctx.grantConsent();
        }
        const result = runQuickCommand(qcfg.command);
        out(`${formatQuickCommandOutput(result)}\n`);
        break;
      }
      // v3 — Plugin slash commands (dynamic handlers via registerSlashCommand).
      if (ctx.pluginLoader) {
        const pluginHandler = ctx.pluginLoader.getSlashHandler(name);
        if (pluginHandler) {
          const slashCtx: import('@ethosagent/types').SlashCommandContext = {
            sessionId: state.sessionKey,
            personalityId: state.personalityId,
            platform: 'cli',
            send: async (text) => {
              out(text);
            },
          };
          const result = await pluginHandler(arg, slashCtx);
          if (result) out(`${result}\n`);
          break;
        }
      }
      out(`${c.dim}Unknown command /${name} — type /help${c.reset}\n`);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// /compact status — context anatomy from PERSISTED Phase 0 data (never a live
// countTokens API call). Mirrors `ethos sessions show`.
// ---------------------------------------------------------------------------

async function printCompactStatus(sessionKey: string): Promise<void> {
  const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
  const { SQLiteObservabilityStore, computeContextAnatomy } = await import(
    '@ethosagent/observability-sqlite'
  );
  const store = new SQLiteSessionStore(join(ethosDir(), 'sessions.db'));
  try {
    const session = await store.getSessionByKey(sessionKey);
    if (!session) {
      out(`${c.dim}[no session yet — send a message first]${c.reset}\n`);
      return;
    }
    let obs: InstanceType<typeof SQLiteObservabilityStore> | undefined;
    let anatomy: ReturnType<typeof computeContextAnatomy> = null;
    try {
      obs = new SQLiteObservabilityStore(join(ethosDir(), 'observability.db'));
      anatomy = computeContextAnatomy(obs.getLlmCallSpansForSession(session.id));
    } catch {
      anatomy = null;
    } finally {
      obs?.close();
    }
    if (!anatomy) {
      out(`${c.dim}[no context data yet — send a message first]${c.reset}\n`);
      return;
    }
    const n = (v: number) => v.toLocaleString();
    const pct = (v: number) => `${Math.round((v / DEFAULT_CONTEXT_MAX) * 100)}%`;
    out(
      `\n${c.bold}Context anatomy${c.reset} ${c.dim}(latest of ${anatomy.llmCallCount} llm call${anatomy.llmCallCount === 1 ? '' : 's'})${c.reset}\n` +
        `  ${'system'.padEnd(10)}${n(anatomy.system).padStart(9)} tok  ${c.dim}${pct(anatomy.system)}${c.reset}\n` +
        `  ${'tools'.padEnd(10)}${n(anatomy.tools).padStart(9)} tok  ${c.dim}${pct(anatomy.tools)}${c.reset}\n` +
        `  ${'messages'.padEnd(10)}${n(anatomy.messages).padStart(9)} tok  ${c.dim}${pct(anatomy.messages)}${c.reset}\n` +
        `  ${c.dim}─────────${c.reset}\n` +
        `  ${'total'.padEnd(10)}${n(anatomy.total).padStart(9)} tok  ${c.dim}${pct(anatomy.total)} of ${n(DEFAULT_CONTEXT_MAX)}${c.reset}\n` +
        `  ${'cache hit'.padEnd(10)}${`${Math.round(anatomy.cacheHitRate * 100)}%`.padStart(9)}\n\n`,
    );
  } finally {
    store.close();
  }
}

// ---------------------------------------------------------------------------
// /background command handler — durable background engine (Phase B)
// ---------------------------------------------------------------------------

async function handleBackgroundCommand(arg: string, state: ChatState): Promise<void> {
  const jobStore = state.jobStore;
  const executor = state.backgroundExecutor;
  if (!jobStore || !executor) {
    out(`${c.dim}[background not enabled]${c.reset}\n`);
    return;
  }
  // Root scoping key for every cap/roll-up — the chat REPL's current session key.
  const root = state.sessionKey;

  if (!arg || arg === 'list') {
    const jobs = await jobStore.listByRoot(root);
    if (jobs.length === 0) {
      out(`${c.dim}[no background tasks]${c.reset}\n`);
      return;
    }
    for (const j of jobs) {
      const age = Math.round((Date.now() - j.createdAt) / 1000);
      const label = j.label ?? j.prompt.slice(0, 60);
      out(
        `${c.dim}  ${j.id}  [${j.status}]  ${label}  $${j.spendUsd.toFixed(4)}  (${age}s)${c.reset}\n`,
      );
    }
    return;
  }

  if (arg.startsWith('cancel ')) {
    const taskId = arg.slice('cancel '.length).trim();
    // Cross-process/async: set the cancel flag; the executor honors it shortly.
    await jobStore.requestCancel(taskId);
    out(`${c.dim}[background task ${taskId} cancelled]${c.reset}\n`);
    return;
  }

  // /background <prompt> — spawn a durable job. No origin* fields: the CLI has no
  // channel lane, so completion surfaces via the idle-prompt onComplete notice.
  const short = randomUUID().slice(0, 8);
  const job = await jobStore.create({
    owner: executor.owner,
    parentSessionKey: root,
    rootSessionKey: root,
    childSessionKey: `${root}:bgcmd:${short}`,
    depth: 0,
    prompt: arg,
  });
  executor.nudge();
  out(`${c.dim}[background task started: ${job.id}]${c.reset}\n`);
}

// ---------------------------------------------------------------------------
// /attach — MIME type helper
// ---------------------------------------------------------------------------

const MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.xml': 'application/xml',
  '.html': 'text/html',
  '.md': 'text/markdown',
};

function mimeFromExtension(filename: string): string {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  const ext = filename.slice(dot).toLowerCase();
  return MIME_MAP[ext] ?? 'application/octet-stream';
}
