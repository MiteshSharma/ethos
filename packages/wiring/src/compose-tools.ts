import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type DefaultToolRegistry,
  LastWriteWinsPolicy,
  LazyOnDemandPolicy,
  SessionManager,
} from '@ethosagent/core';
import type { GoalRunner } from '@ethosagent/goal-runner';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import { autonomyTier, KanbanStore } from '@ethosagent/kanban-store';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import {
  platformId as discordId,
  platformPrompt as discordPrompt,
} from '@ethosagent/platform-discord/format';
import {
  platformId as emailId,
  platformPrompt as emailPrompt,
} from '@ethosagent/platform-email/format';
import {
  platformId as slackId,
  platformPrompt as slackPrompt,
} from '@ethosagent/platform-slack/format';
import {
  platformId as telegramId,
  platformPrompt as telegramPrompt,
} from '@ethosagent/platform-telegram/format';
import { createSkillProposeTool } from '@ethosagent/skill-evolver';
import type { SkillsInjector, UniversalScanner } from '@ethosagent/skills';
import { compose as composeSkills } from '@ethosagent/skills/compose';
import { createCryptoStorage } from '@ethosagent/storage-crypto';
import { FsStorage } from '@ethosagent/storage-fs';
import { compose as composeBrowser } from '@ethosagent/tools-browser/compose';
import { compose as composeCode } from '@ethosagent/tools-code/compose';
import { compose as composeCron } from '@ethosagent/tools-cron/compose';
import { buildDebugTools } from '@ethosagent/tools-debug';
import { createFileTools } from '@ethosagent/tools-file';
import { createGoalTools } from '@ethosagent/tools-goals';
import { createImageTools } from '@ethosagent/tools-image';
import { compose as composeInteractive } from '@ethosagent/tools-interactive/compose';
import {
  type AutonomyTierOf,
  createCompletionVerifier,
  createKanbanRoleGateHook,
  registerPostmortemHandler,
} from '@ethosagent/tools-kanban';
import { compose as composeKanban } from '@ethosagent/tools-kanban/compose';
import { loadMcpConfig, McpManager } from '@ethosagent/tools-mcp';
import { createMeetingTools } from '@ethosagent/tools-meeting';
import { createTeamMemoryTools, isSafeTopicKey } from '@ethosagent/tools-memory';
import type { MessagingSendFn } from '@ethosagent/tools-messaging';
import { compose as composeMessaging } from '@ethosagent/tools-messaging/compose';
import { createTeamDesignTools } from '@ethosagent/tools-personality-design';
import { compose as composePersonalityDesign } from '@ethosagent/tools-personality-design/compose';
import { createProcessGuardHook } from '@ethosagent/tools-process';
import { compose as composeProcess } from '@ethosagent/tools-process/compose';
import { compose as composeSkillsTools } from '@ethosagent/tools-skills/compose';
import { createTerminalGuardHook, createTerminalTools } from '@ethosagent/tools-terminal';
import { createThinkDeeperTool } from '@ethosagent/tools-tier';
import { compose as composeTodo } from '@ethosagent/tools-todo/compose';
import { createTtsTools } from '@ethosagent/tools-tts';
import { buildUiTools } from '@ethosagent/tools-ui';
import { createVoiceTools } from '@ethosagent/tools-voice';
import { compose as composeWatchers } from '@ethosagent/tools-watchers/compose';
import type {
  ContextInjector,
  ExecutionBackend,
  ExecutionBackendConfig,
  InjectionResult,
  LLMProvider,
  LLMProviderRegistry,
  Logger,
  MemoryContext,
  MemoryEntryRef,
  MemoryProvider,
  PersonalityConfig,
  PromptContext,
  SecretsResolver,
  Skill,
  Storage,
  Tool,
} from '@ethosagent/types';
import type { InfrastructureResult } from './build-infrastructure';
import { ensureFsReachDirs } from './fs-reach-dirs';
import type { CreateAgentLoopOptions, WiringConfig, WiringProfile } from './index';
import { resolveKanbanDbPath } from './kanban-path';
import { MODEL_CATALOG } from './model-catalog';
import { fetchManifest, loadModelCatalog, manifestToEntries } from './model-catalog-loader';
import { resolveExecutionPosture } from './resolve-execution-posture';
import { applySkillPassthrough, deriveSkillPassthrough } from './skill-passthrough';
import type { WiringContext } from './types';

// ---------------------------------------------------------------------------
// WEB_PROMPT — kept here since platformPrompts is also assembled here
// ---------------------------------------------------------------------------

const WEB_PROMPT = `## Output format — Web UI

You are responding in a web application with rich markdown rendering. Follow these rules:

- Use full GitHub-flavoured markdown: **bold**, *italic*, # headers, ## subheaders,
  bullet lists (- or *), numbered lists, \`inline code\`, \`\`\`code blocks\`\`\`, tables,
  and horizontal rules (---).
- Structure multi-part answers with ## headers. Use ### for sub-sections.
- Use tables for comparisons with 3+ attributes.
- Code blocks must include the language identifier: \`\`\`typescript.
- Links: [text](url). Images: ![alt](url) when relevant.
- Aim for visual hierarchy — readers scan before they read.
- Length is not constrained by platform. Match depth to complexity.
- Use > blockquotes for direct quotations or highlighted callouts.`;

export const platformPrompts = new Map<string, string>([
  [slackId, slackPrompt],
  [telegramId, telegramPrompt],
  [discordId, discordPrompt],
  [emailId, emailPrompt],
  ['web', WEB_PROMPT],
]);

// ---------------------------------------------------------------------------
// Messaging allowlist loader
// ---------------------------------------------------------------------------

/**
 * Read `<dataDir>/messaging.json` and return a `Map<personalityId, targets[]>`.
 * Missing file or parse failure → empty map (everything stays default-deny).
 */
export async function loadMessagingAllowlist(dataDir: string): Promise<Map<string, string[]>> {
  const storage = new FsStorage();
  const path = join(dataDir, 'messaging.json');
  const raw = await storage.read(path);
  if (!raw) return new Map();
  try {
    const data = JSON.parse(raw) as Record<string, unknown>;
    const out = new Map<string, string[]>();
    for (const [personalityId, value] of Object.entries(data)) {
      if (!Array.isArray(value)) continue;
      const targets = value.filter((t): t is string => typeof t === 'string');
      out.set(personalityId, targets);
    }
    return out;
  } catch {
    return new Map();
  }
}

// ---------------------------------------------------------------------------
// Team memory helpers
// ---------------------------------------------------------------------------

/** Validates that a team name contains only safe characters. */
export function isSafeTeamName(name: string): boolean {
  return /^[a-zA-Z0-9_-]+$/.test(name);
}

const TEAM_MEMORY_BOOTSTRAP_TOPICS = [
  { key: 'onboarding', placeholder: '# Onboarding\n' },
  { key: 'decisions', placeholder: '# Decisions\n' },
] as const;

/**
 * Seed empty topic files via the team memory provider if no .md files exist
 * yet. Called once at AgentLoop wiring time so agents always see at least the
 * bootstrap topics in the lazy index.
 */
export async function seedTeamMemory(teamMemory: MemoryProvider, teamName: string): Promise<void> {
  const seedCtx: MemoryContext = {
    scopeId: `team:${teamName}`,
    sessionId: 'seed',
    sessionKey: 'seed',
    platform: 'cli',
    workingDir: '',
  };
  try {
    const refs = await teamMemory.list(seedCtx);
    if (refs.length === 0) {
      for (const topic of TEAM_MEMORY_BOOTSTRAP_TOPICS) {
        await teamMemory.sync(
          [{ action: 'add', key: `${topic.key}.md`, content: topic.placeholder }],
          seedCtx,
        );
      }
    }
  } catch {
    // Non-fatal — team memory still works; agents just won't see bootstrap topics in the index.
  }
}

/**
 * ContextInjector that injects a short list of available team memory topics
 * into the system prompt at session start. Uses lazy mode — only topic names
 * are injected; content is loaded on demand via team_memory_read.
 */
export function createTeamMemoryIndexInjector(
  teamMemory: MemoryProvider,
  teamName: string,
): ContextInjector {
  return {
    id: `team-memory-index:${teamName}`,
    priority: 70,

    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      const memCtx: MemoryContext = {
        scopeId: `team:${teamName}`,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        platform: ctx.platform,
        workingDir: ctx.workingDir ?? '',
      };

      let refs: MemoryEntryRef[];
      try {
        refs = await teamMemory.list(memCtx);
      } catch {
        return null;
      }

      // Filter to safe, non-USER topic keys only.
      const topics = refs
        .filter((r) => r.key !== 'USER.md' && isSafeTopicKey(r.key))
        .map((r) => r.key.replace(/\.md$/i, ''));

      if (topics.length === 0) return null;

      const lines = topics.map((t) => `- ${t}`).join('\n');
      return {
        content: `Team memory topics available (call team_memory_read to load):\n${lines}`,
        position: 'append',
      };
    },
  };
}

/**
 * ContextInjector that tells the agent about its personality asset folder.
 * Files placed at ~/.ethos/personalities/<id>/files/ are readable by render_*
 * tools via the files:// URI scheme (e.g. files://chart.png).
 */
export function createPersonalityFilesInjector(
  personalityId: string,
  homedirPath: string,
): ContextInjector {
  const filesDir = `${homedirPath}/.ethos/personalities/${personalityId}/files`;
  return {
    id: `personality-files:${personalityId}`,
    priority: 30,
    shouldInject(ctx: PromptContext): boolean {
      return ctx.personalityId === personalityId;
    },
    async inject(_ctx: PromptContext): Promise<InjectionResult | null> {
      return {
        content: `## Asset folder\nFiles at \`${filesDir}/\` are your persistent asset store. Reference them in render tools using the \`files://\` URI scheme — e.g. \`render_file({ src: "files://chart.png" })\`. Files you render from external paths (e.g. /tmp/) are automatically copied here.`,
      };
    },
  };
}

/**
 * Gap 11 — live tool-reach getter for skills gating (`requires.tools` +
 * capability-mode filtering). Lazy on purpose: the closure re-reads the
 * registry on every `resolveSkills()` call, so MCP and plugin tools
 * registered after skills composition are visible. The personality's reach
 * (toolset ∪ attached MCP servers ∪ plugins) is intersected with
 * `getAvailable()` so registered-but-unavailable tools (failed
 * `isAvailable()`, e.g. missing env) don't satisfy `requires.tools`.
 */
export function createToolReachGetter(
  registry: DefaultToolRegistry,
): (personality: PersonalityConfig) => Set<string> {
  return (personality) => {
    const available = new Set(registry.getAvailable().map((t) => t.name));
    const reach = registry.toolNamesForPersonality(personality);
    return new Set([...reach].filter((name) => available.has(name)));
  };
}

// ---------------------------------------------------------------------------
// Main export types
// ---------------------------------------------------------------------------

/** Mutable ref for the gateway send function. Allows post-construction injection. */
export interface GatewaySendRef {
  fn: MessagingSendFn;
}

/** Late-binding ref for the loop-bearing GoalRunner, assigned in build-agent-loop. */
export interface GoalRunnerRef {
  runner?: GoalRunner;
}

export interface ComposeToolsResult {
  /** Mutable ref for injecting the real gateway send function post-construction. */
  gatewaySendRef: GatewaySendRef;
  /** Shared SQLite goal store — always present (one goals.db per dataDir). */
  goalStore: SQLiteGoalStore;
  /** Late-binding ref for the loop-bearing GoalRunner, assigned in build-agent-loop. */
  goalRunnerRef: GoalRunnerRef;
  /** Skill pool built from composeSkills (needed by loadPlugins). */
  skillPool: Map<string, Skill>;
  /** Context injectors array (passed through to loadPlugins and AgentLoop). */
  injectors: ContextInjector[];
  /** Universal scanner (needed by loadPlugins for plugin skill merging). */
  skillScanner: UniversalScanner;
  /** The live SkillsInjector — surfaced so read-only surfaces (the web-api's
   *  `personalities.renderers`) reuse THIS instance's resolveSkills + mtime
   *  cache instead of constructing a second injector with a duplicate scanner. */
  skillsInjector: SkillsInjector;
  /** McpManager instance — threaded to the web-api so re-auth hits the live manager. */
  mcpManager: McpManager;
}

export interface ComposeToolsDeps {
  infra: InfrastructureResult;
  profile: WiringProfile;
}

// ---------------------------------------------------------------------------
// Phase 7 — lazy main-provider resolver for the completion verifier. Mirrors
// buildCompressionSummarizer (index.ts): resolve the factory from the registry
// on first use, construct once, cache. Deferral matters because the verifier
// only needs a provider when a ticket with acceptance criteria completes.
// ---------------------------------------------------------------------------

function buildVerifierProviderGetter(
  registry: LLMProviderRegistry,
  config: WiringConfig,
  log: Logger,
): () => Promise<LLMProvider> {
  let cachedProvider: LLMProvider | undefined;
  return async () => {
    if (cachedProvider) return cachedProvider;
    const factory = registry.get(config.provider);
    if (!factory) {
      throw new Error(
        `LLM provider "${config.provider}" is not registered (completion verifier). ` +
          `Available: ${registry.list().join(', ')}`,
      );
    }
    const NOOP: SecretsResolver = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    cachedProvider = await factory({
      config: {
        provider: config.provider,
        model: config.model,
        apiKey: config.apiKey,
        ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
        ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
      },
      secrets: config.secretsResolver ?? NOOP,
      logger: log,
    });
    return cachedProvider;
  };
}

/**
 * Register all tool groups into the tool registry and wire supporting hooks.
 * Covers: file, terminal, web, todo, think, interactive, kanban, process,
 * image, code, browser, messaging, cron, TTS, skills compose + introspection,
 * MCP, design storage + model catalog + personality design, guard hooks, and
 * team memory (when teamName is set).
 */
export async function composeAllTools(
  wiringCtx: WiringContext,
  config: WiringConfig,
  opts: CreateAgentLoopOptions,
  deps: ComposeToolsDeps,
): Promise<ComposeToolsResult> {
  const { dataDir, log } = wiringCtx;
  const { infra, profile } = deps;
  const { personalities, activePerson, hooks, capabilityBackends, tools, clarifyBridge } = infra;

  // Materialize the personality's derived write directories BEFORE the posture
  // branch below, so every posture gets them: docker would otherwise let the
  // daemon auto-create the missing bind source as root (EACCES for the
  // `--user <uid>:<gid>` container), and local `Storage.write()` requires the
  // parent directory to already exist.
  await ensureFsReachDirs(
    activePerson,
    wiringCtx.storage,
    { ethosHome: dataDir, cwd: wiringCtx.workingDir },
    log,
  );

  // -------------------------------------------------------------------------
  // Execution posture + backend (Phase 2a lane c + security fix F1) — resolve
  // ONE posture and route every execution-bearing tool through it consistently.
  //
  // The posture resolver accounts for backend AVAILABILITY: `dockerBuildable`
  // is false when Docker is disabled in this process (e.g. the desktop
  // in-process backend sets `opts.disableDocker`). When the computed posture is
  // `docker` but no backend can be built, the resolver returns either an honest
  // `local` posture (un-sandboxed, runs on host) when the constitution permits,
  // or a `docker` hard-fail (`dockerAbsent.canConsentLocal === false`) when it
  // forbids `local`. We then:
  //   - posture `docker` + backend built → tools run mount-confined in the container;
  //   - posture `local`/`none`           → tools use the host ScopedProcess (honest);
  //   - posture `docker` + NO backend    → host execution is FORBIDDEN: exec
  //     tools become `not_available` rather than silently running on the host.
  // This makes actual execution match what the character sheet claims.
  // -------------------------------------------------------------------------
  const posture = resolveExecutionPosture({
    personality: activePerson,
    constitution: infra.constitution,
    containerized: { env: process.env },
    dockerBuildable: !opts.disableDocker,
  });

  let executionBackend: ExecutionBackend | undefined;
  if (posture.backend === 'docker' && !opts.disableDocker && !posture.dockerAbsent) {
    const NOOP_SECRETS: SecretsResolver = {
      get: async () => null,
      set: async () => {},
      delete: async () => {},
      list: async () => [],
    };
    const backendConfig: ExecutionBackendConfig = {
      substitutionVars: { ethosHome: dataDir, cwd: wiringCtx.workingDir },
      // F2 — pass the resolved constitution so the docker backend enforces
      // allowedMountRoots / deniedPathPrefixes against the ACTUAL mount set
      // (including the ownDir/skills/cwd defaults), not just declared fs_reach.
      constitution: infra.constitution,
    };
    try {
      executionBackend = await infra.executionBackends.resolve('docker', {
        config: backendConfig,
        secrets: config.secretsResolver ?? NOOP_SECRETS,
        logger: log,
      });
    } catch (err) {
      // Lane B: fail loud. No silent docker -> local fallback. The A1
      // docker-absent guided-install/consent flow is Lane E.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `execution backend "docker" (required by this personality's posture) could not be resolved: ${detail}`,
        { cause: err },
      );
    }
    if (executionBackend) {
      executionBackend = new SessionManager(executionBackend, {
        onEvent: (e) => {
          log.info(`execution session ${e.type}`, {
            personalityId: e.personalityId,
            sessionId: e.sessionId,
            reason: e.reason,
          });
        },
      });
    }
  }

  // Host execution is forbidden when the personality's posture requires a
  // sandbox/remote backend that is not wired here, AND the host fallback is not
  // permitted. Two cases:
  //   - `docker` posture with no backend (disableDocker / daemon down) AND the
  //     constitution forbids the `local` host fallback (resolver leaves it
  //     `docker` + a `dockerAbsent` hard-fail);
  //   - `ssh` posture with no backend (Phase 2a wires none) AND the constitution
  //     forbids `local` (resolver leaves it `ssh`; a permitting constitution
  //     already became honest `local` above, so an `ssh` posture reaching here
  //     means refusal — never silent host).
  // In both cases exec tools must refuse (`not_available`) — never silently run
  // on the host while the sheet claims docker/ssh.
  const hostExecForbidden =
    (posture.backend === 'docker' || posture.backend === 'ssh') && executionBackend === undefined;
  if (hostExecForbidden) {
    log.warn(
      'execution posture: sandbox/remote backend required but none available; host exec forbidden',
      {
        personalityId: activePerson.id,
        backend: posture.backend,
        disableDocker: opts.disableDocker === true,
      },
    );
  }

  // -------------------------------------------------------------------------
  // Group A: inline tool factories
  // -------------------------------------------------------------------------

  for (const tool of createFileTools()) tools.register(tool);
  for (const tool of createTerminalTools({
    backend: executionBackend,
    personality: activePerson,
    hostExecForbidden,
  }))
    tools.register(tool);
  for (const tool of buildUiTools()) tools.register(tool);

  // One InMemoryTodoStore per process — lifetime tied to the AgentLoop.
  const { tools: todoTools } = composeTodo(wiringCtx);
  for (const tool of todoTools) tools.register(tool);
  tools.register(createThinkDeeperTool());

  for (const tool of composeInteractive(wiringCtx, { clarifyBridge }).tools) tools.register(tool);

  // Kanban tools — wired only when the active personality actually uses them.
  let kanbanStore: KanbanStore | null = null;
  if ((activePerson.toolset ?? []).some((name: string) => name.startsWith('kanban_'))) {
    const kanbanDbPath = resolveKanbanDbPath(config, dataDir);
    kanbanStore = new KanbanStore(kanbanDbPath);
    const store = kanbanStore;
    const kanbanOpts: {
      store: KanbanStore;
      hooks?: typeof hooks;
      autonomyTierOf?: AutonomyTierOf;
      personalityLookup?: (id: string) => { name: string } | undefined;
    } = {
      store,
      hooks,
      personalityLookup: (id: string) => {
        const p = personalities.get(id);
        return p ? { name: p.name } : undefined;
      },
    };
    if (config.trustPolicy?.mode === 'tiered') {
      const policy = config.trustPolicy;
      kanbanOpts.autonomyTierOf = (assignee) => {
        const stats = store.getMemberStats();
        const s = stats.get(assignee);
        if (!s) return undefined;
        const total = s.ticketsCompleted + s.ticketsFailed + s.ticketsOrphaned;
        const ratio = total > 0 ? s.ticketsCompleted / total : 0;
        return { tier: autonomyTier(s, policy), ratio };
      };
    }
    for (const tool of composeKanban(wiringCtx, kanbanOpts).tools) tools.register(tool);

    // Phase 7 — mandatory verifier review state on team (multi-personality) goals.
    // Praxis lesson: agents skip an optional review state, so on team deployments
    // the eval-harness verifier is default-wired, not opt-in. Single-personality
    // kanban keeps the opt-in hook.
    if (config.teamName !== undefined) {
      hooks.registerClaiming(
        'before_ticket_complete',
        createCompletionVerifier({
          getProvider: buildVerifierProviderGetter(infra.llmProviders, config, log),
        }),
      );
    }
  }

  // Goal store is shared infrastructure — a single goals.db per dataDir backs the
  // loop-bearing runner constructed later in build-agent-loop (it needs the
  // AgentLoop). It must exist for ANY personality so web-created goals execute,
  // independent of whether the personality exposes goal_* tools. Only the
  // agent-facing goal_* TOOLS stay gated by the personality's toolset.
  const goalStore = new SQLiteGoalStore(join(dataDir, 'goals.db'));
  const goalRunnerRef: GoalRunnerRef = {};
  if ((activePerson.toolset ?? []).some((name: string) => name.startsWith('goal_'))) {
    for (const tool of createGoalTools(goalStore, (id) => goalRunnerRef.runner?.startGoal(id)))
      tools.register(tool);
  }

  for (const tool of composeProcess(wiringCtx, {
    hookRegistry: hooks,
    backend: executionBackend,
    personality: activePerson,
    hostExecForbidden,
  }).tools)
    tools.register(tool);
  for (const tool of createImageTools({
    openaiApiKey: config.provider === 'openai' ? config.apiKey : undefined,
  }))
    tools.register(tool);

  // Vision tools are registered after plugin loading (they need `llm`).

  // Code tools (run_code/run_tests/lint) are registered unconditionally and
  // route through the SAME resolved posture as terminal/process (F1): docker →
  // backend, local/none → host ScopedProcess, docker-without-backend → refuse.
  // run_code self-gates on `backend !== undefined` via its `isAvailable()`.
  for (const tool of composeCode(wiringCtx, {
    backend: executionBackend,
    personality: activePerson,
    hostExecForbidden,
  }).tools)
    tools.register(tool);

  if (!opts.disableDocker) {
    for (const tool of composeBrowser(wiringCtx, {
      visionApiKey: config.apiKey,
      visionProvider: config.provider,
      visionModel: config.model,
    }).tools)
      tools.register(tool);
  }

  // Messaging tools — gatewaySendRef is a mutable object so the closure always
  // calls the latest injected function.
  const gatewaySendRef: GatewaySendRef = {
    fn: async () => ({
      ok: false,
      error: 'Gateway not active — send_message requires gateway mode',
    }),
  };

  const messagingAllowlist = await loadMessagingAllowlist(dataDir);

  for (const tool of composeMessaging(wiringCtx, {
    send: async (platform, target, body, botKey) =>
      gatewaySendRef.fn(platform, target, body, botKey),
    getAllowedTargets: (personalityId) => {
      if (!personalityId) return [];
      return messagingAllowlist.get(personalityId) ?? [];
    },
  }).tools)
    tools.register(tool);

  // Cron tool — registered only when a CronScheduler was threaded through.
  if (opts.cronScheduler) {
    for (const tool of composeCron(wiringCtx, { scheduler: opts.cronScheduler }).tools)
      tools.register(tool);
  }

  // Watcher tools — registered only when a WatcherManager was threaded through.
  if (opts.watcherManager) {
    for (const tool of composeWatchers(wiringCtx, { manager: opts.watcherManager }).tools)
      tools.register(tool);
  }

  // TTS tool — registers as unavailable when provider is null (no TTS configured).
  for (const tool of createTtsTools({ provider: null })) tools.register(tool);

  // Voice tools — `voice_session` is the always-available capability marker that
  // makes a personality selectable for real-time voice (browser talk-mode /
  // telephony); the web talk-mode gate keys off its presence in the toolset. The
  // outbound `call` tool self-reports unavailable until a SIP trunk is wired
  // (the live LiveKit/SIP binding is app-layer/manual, not wired here).
  for (const tool of createVoiceTools()) tools.register(tool);

  // Meeting tool — `meet_join` self-reports unavailable until a MeetingClient is
  // wired (the Playwright/browser binding is app-layer/manual, not wired here).
  for (const tool of createMeetingTools()) tools.register(tool);

  // -------------------------------------------------------------------------
  // Phase B compose — skills (depends on personalities)
  // -------------------------------------------------------------------------

  const skillsCompose = await composeSkills(wiringCtx, {
    personalities,
    activePerson,
    hooks,
    platformPrompts,
    log,
    toolNamesForPersonality: createToolReachGetter(tools),
  });
  const { skillPool, injectors, scanner: skillScanner, skillsInjector } = skillsCompose;
  for (const tool of skillsCompose.tools) tools.register(tool);

  const bootToolNames = new Set(activePerson.toolset ?? []);
  const attachedServers = new Set(activePerson.mcp_servers ?? []);
  const skillPassthrough = deriveSkillPassthrough(skillPool, activePerson, bootToolNames);

  // Skill introspection tools — skills_list + skill_view.
  for (const tool of composeSkillsTools(wiringCtx, { skillPool }).tools) tools.register(tool);

  // skill_propose — lets the agent propose new skills from chat when asked,
  // gated by the 'skills' toolset so personalities opt in via toolset.yaml.
  tools.register(
    createSkillProposeTool({
      storage: wiringCtx.storage,
      pendingDir: join(wiringCtx.dataDir, 'skills', '.pending'),
      toolset: 'skills',
    }) as Tool,
  );

  // -------------------------------------------------------------------------
  // MCP tools
  // -------------------------------------------------------------------------

  const rawMcpConfig = await loadMcpConfig(wiringCtx.storage);
  const mcpConfig = applySkillPassthrough(
    rawMcpConfig,
    skillPassthrough,
    attachedServers,
  ) as Awaited<ReturnType<typeof loadMcpConfig>>;
  const mcpManager = new McpManager(mcpConfig, {
    logger: log,
    enableScopeProbe: process.env.ETHOS_MCP_SCOPE_PROBE === '1',
    innerSecrets: config.secretsResolver,
    onToolsChanged: (added, removedNames) => {
      for (const t of added) tools.register(t);
      for (const name of removedNames) tools.unregister(name);
    },
  });
  const mcpTools = await mcpManager.getToolsForPersonality(
    activePerson.id,
    activePerson.mcp_servers,
  );
  for (const tool of mcpTools) tools.register(tool);

  // Eagerly connect MCP servers for all other personalities so switching
  // personalities in a single `ethos serve` process has access to their tools.
  // (The boot personality's token is tried first above; others follow here.)
  for (const p of personalities.list()) {
    if (p.id === activePerson.id) continue;
    if (!p.mcp_servers?.length) continue;
    const pTools = await mcpManager.getToolsForPersonality(p.id, p.mcp_servers);
    for (const tool of pTools) tools.register(tool);
  }

  if (mcpConfig.length > 0) {
    const attached = activePerson.mcp_servers ?? [];
    if (attached.length === 0) {
      const names = mcpConfig.map((s) => s.name).join(', ');
      log.info(
        `MCP: 0 of ${mcpConfig.length} server(s) attached to "${activePerson.id}". ` +
          `Run 'ethos personality mcp ${activePerson.id} --attach <name>' to enable. ` +
          `Configured: ${names}`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Design storage + model catalog + personality design tools
  // -------------------------------------------------------------------------

  let designStorage: Storage = capabilityBackends.storage ?? new FsStorage();
  if (config.storage?.encryption) {
    const passphrase = process.env.ETHOS_STORAGE_KEY ?? '';
    designStorage = createCryptoStorage(designStorage, passphrase);
  }

  let resolvedModelCatalog = MODEL_CATALOG;
  if (config.modelCatalogConfig && config.modelCatalogConfig.enabled !== false) {
    try {
      const catalogUrl =
        config.modelCatalogConfig.url ?? 'https://ethos-agent.ai/api/model-catalog.json';
      const ttlMs = (config.modelCatalogConfig.ttlHours ?? 24) * 3_600_000;
      const cachePath = join(dataDir, 'cache', 'model-catalog.json');
      const manifest = await loadModelCatalog({
        url: catalogUrl,
        ttlMs,
        storage: designStorage,
        cachePath,
        logger: log,
      });
      if (config.modelCatalogConfig.providers) {
        for (const [providerId, providerCfg] of Object.entries(
          config.modelCatalogConfig.providers,
        )) {
          try {
            const providerManifest = await fetchManifest(providerCfg.url);
            if (providerManifest.providers[providerId]) {
              manifest.providers[providerId] = providerManifest.providers[providerId];
            }
          } catch {
            log.warn(
              `model catalog: per-provider override for '${providerId}' failed; using main catalog`,
            );
          }
        }
      }
      resolvedModelCatalog = manifestToEntries(manifest);
    } catch {
      log.warn('model catalog: remote load failed during wiring; using bundled snapshot');
    }
  }

  for (const tool of composePersonalityDesign(wiringCtx, {
    toolRegistry: tools,
    storage: designStorage,
    modelCatalog: resolvedModelCatalog,
    skills: [...skillPool.values()],
  }).tools) {
    tools.register(tool);
  }
  for (const tool of createTeamDesignTools({
    personalityRegistry: personalities,
    storage: designStorage,
  })) {
    tools.register(tool);
  }

  // -------------------------------------------------------------------------
  // Guard hooks
  // -------------------------------------------------------------------------

  // CLI/TUI/ACP get the synchronous block-and-explain guard.
  if (profile !== 'web') {
    hooks.registerModifying('before_tool_call', createTerminalGuardHook());
    hooks.registerModifying('before_tool_call', createProcessGuardHook());
  }

  // Plan B — kanban role gate hook.
  if (kanbanStore !== null && config.teamName !== undefined && config.role !== undefined) {
    hooks.registerModifying(
      'before_tool_call',
      createKanbanRoleGateHook({
        role: config.role,
        personalityId: activePerson.id,
        store: kanbanStore,
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Team memory (when teamName is set)
  // -------------------------------------------------------------------------

  if (config.teamName) {
    if (!isSafeTeamName(config.teamName)) {
      throw new Error(
        `Invalid teamName "${config.teamName}": must match [a-zA-Z0-9_-]+ (no path separators or traversal)`,
      );
    }
    const teamMemoryDir = join(dataDir, 'teams', config.teamName, 'memory');
    const teamMemory = new LazyOnDemandPolicy(
      new LastWriteWinsPolicy(
        new MarkdownFileMemoryProvider({ dir: teamMemoryDir, storage: wiringCtx.storage }),
      ),
    );

    await seedTeamMemory(teamMemory, config.teamName);

    for (const tool of createTeamMemoryTools(teamMemory)) tools.register(tool);

    if (config.postmortems !== false) {
      registerPostmortemHandler({ teamName: config.teamName, memory: teamMemory, hooks });
    }

    injectors.push(createTeamMemoryIndexInjector(teamMemory, config.teamName));
  }

  // -------------------------------------------------------------------------
  // Personality files injector
  // -------------------------------------------------------------------------

  injectors.push(createPersonalityFilesInjector(activePerson.id, homedir()));

  // -------------------------------------------------------------------------
  // Debug tools (debug sessions only)
  // -------------------------------------------------------------------------

  if (wiringCtx.isDebugSession) {
    const debugTools = buildDebugTools({
      sessionStore: infra.sessionCompose.sessionStore,
    });
    for (const tool of debugTools) tools.register(tool);
  }

  return {
    gatewaySendRef,
    goalRunnerRef,
    goalStore,
    skillPool,
    injectors,
    skillScanner,
    skillsInjector,
    mcpManager,
  };
}
