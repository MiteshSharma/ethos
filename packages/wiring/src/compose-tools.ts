import { dirname, join } from 'node:path';
import {
  createSpokenStyleInjector,
  type DefaultToolRegistry,
  LastWriteWinsPolicy,
  LazyOnDemandPolicy,
  personalityAssetDir,
  SessionManager,
} from '@ethosagent/core';
import type { GoalRunner } from '@ethosagent/goal-runner';
import { SQLiteGoalStore } from '@ethosagent/goal-store';
import { autonomyTier, KanbanStore } from '@ethosagent/kanban-store';
import { MarkdownFileMemoryProvider } from '@ethosagent/memory-markdown';
import type { PendingNotify, PendingNotifyQueue } from '@ethosagent/notify-queue';
import { SQLiteNotifyQueue } from '@ethosagent/notify-queue';
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
import {
  platformId as whatsappId,
  platformPrompt as whatsappPrompt,
} from '@ethosagent/platform-whatsapp/format';
import { createSkillProposeTool } from '@ethosagent/skill-evolver';
import { type SkillsInjector, SkillsLibrary, type UniversalScanner } from '@ethosagent/skills';
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
  createCheckProbe,
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
import { createProcessGuardHook, isAlive } from '@ethosagent/tools-process';
import { compose as composeProcess } from '@ethosagent/tools-process/compose';
import { createRedditSearchTool, createRedditThreadTool } from '@ethosagent/tools-reddit';
import { compose as composeSkillsTools } from '@ethosagent/tools-skills/compose';
import { createTerminalGuardHook, createTerminalTools } from '@ethosagent/tools-terminal';
import { createThinkDeeperTool } from '@ethosagent/tools-tier';
import { compose as composeTodo } from '@ethosagent/tools-todo/compose';
import { buildCardTools, buildUiTools, createUiGuidanceInjector } from '@ethosagent/tools-ui';
import { createVoiceTools } from '@ethosagent/tools-voice';
import { compose as composeWatchers } from '@ethosagent/tools-watchers/compose';
import { createXSearchTool } from '@ethosagent/tools-x-search';
import type {
  Constitution,
  ContextInjector,
  ExecutionBackend,
  ExecutionBackendConfig,
  ExecutionBackendRegistry,
  ExecutionPosture,
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
  TurnAuditor,
} from '@ethosagent/types';
import type { InfrastructureResult } from './build-infrastructure';
import { ensureFsReachDirs } from './fs-reach-dirs';
import {
  composeGrounding,
  createCheckRunExec,
  type GroundingMemoryConsult,
  kanbanChecksEnabled,
} from './grounding';
import type { CreateAgentLoopOptions, WiringConfig, WiringProfile } from './index';
import { resolveKanbanDbPath } from './kanban-path';
import { MODEL_CATALOG } from './model-catalog';
import { fetchManifest, loadModelCatalog, manifestToEntries } from './model-catalog-loader';
import {
  constitutionForbidsLocal,
  formatSshTarget,
  resolveExecutionPosture,
} from './resolve-execution-posture';
import { applySkillPassthrough, deriveSkillPassthrough } from './skill-passthrough';
import type { WiringContext } from './types';
import { resolveSipTrunkClient } from './voice-stack';

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
  [whatsappId, whatsappPrompt],
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
 * ContextInjector that surfaces passive `notify`-mode board deliveries (Lane
 * C, kanban-hooks-notify-parity, D6). A `notify`-mode `/notify` call does not
 * force a turn — it has nowhere else to land — so it is written to the
 * pending-notify queue instead, and this injector is what surfaces it: on
 * every turn it reads whatever is pending for `ctx.personalityId` on this
 * team's board and marks it consumed in the same call, so a row is delivered
 * exactly once, at the assignee's own next turn. Read-and-consume happens at
 * INJECT TIME per D6's resolution, not on a separate poll.
 *
 * Priority sits just above `team-memory-index`'s 70 so a pending notify reads
 * as the more time-sensitive of the two dynamic-tail sections.
 */
export function createPendingNotifyInjector(
  queue: PendingNotifyQueue,
  teamName: string,
): ContextInjector {
  return {
    id: `pending-notify:${teamName}`,
    priority: 71,

    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      if (!ctx.personalityId) return null;

      let rows: PendingNotify[];
      try {
        rows = await queue.readAndConsume(teamName, ctx.personalityId);
      } catch {
        return null;
      }
      if (rows.length === 0) return null;

      const lines = rows.map((r) => `- ${r.kind}${r.ref ? ` (${r.ref})` : ''}`).join('\n');
      const plural = rows.length === 1 ? 'notify' : 'notifies';
      return {
        content: `You have ${rows.length} unread board ${plural}:\n${lines}`,
        position: 'append',
      };
    },
  };
}

/**
 * Resolve any known personality's asset folder — the directory `files://`
 * addresses. Wiring owns this because it is the composition root: it holds the
 * personality registry, so `personalityAssetDir` (the one `fs_reach`
 * derivation) runs here and tools-ui is handed the answer instead of deriving
 * a path of its own.
 *
 * Resolved per call, never captured: the registry hot-reloads and a loop's
 * personality can change mid-session (`/personality`), so a `fs_reach.workdir`
 * edited on disk takes effect on the next turn.
 *
 * `undefined` when the personality is unknown, or when a declared workdir names
 * an unresolvable substitution variable (`EmptySubstitutionError` — turn setup
 * surfaces that; `files://` merely refuses).
 */
export function createAssetDirResolver(
  lookup: (personalityId: string) => PersonalityConfig | undefined,
  vars: { ethosHome: string; cwd: string },
): (personalityId: string) => string | undefined {
  return (personalityId) => {
    const personality = lookup(personalityId);
    if (!personality) return undefined;
    try {
      return personalityAssetDir(personality, {
        ethosHome: vars.ethosHome,
        self: personality.id,
        cwd: vars.cwd,
      });
    } catch {
      return undefined;
    }
  };
}

/**
 * Resolve any known personality's OWN directory — the one holding `SOUL.md`,
 * and beneath it the `ui/` Canvas templates `render_ui` reads.
 *
 * Distinct from the asset folder: assets follow `fs_reach` and may be
 * relocated anywhere, whereas templates are authored alongside the
 * personality's identity files and travel with it. `soulFile` is
 * `<dir>/SOUL.md`, populated by the loader for built-in and user
 * personalities alike, so `dirname` is the whole derivation.
 *
 * Resolved per call, never captured: the registry hot-reloads and a loop's
 * personality can change mid-session (`/personality`).
 *
 * `undefined` when the personality is unknown, or when it is config-only and
 * therefore has no `soulFile` — `render_ui` then refuses template mode rather
 * than guessing at a directory.
 */
export function createPersonalityDirResolver(
  lookup: (personalityId: string) => PersonalityConfig | undefined,
): (personalityId: string) => string | undefined {
  return (personalityId) => {
    const soulFile = lookup(personalityId)?.soulFile;
    return soulFile ? dirname(soulFile) : undefined;
  };
}

/**
 * Scan a personality's `ui/` folder once, at composition time, for the Canvas
 * template catalog the UI-guidance injector advertises. Per-turn listing is
 * forbidden here: the injector's content must stay byte-identical across turns
 * or it breaks the static prompt prefix.
 *
 * Descriptions are best-effort — the first HTML comment, else the `<title>`.
 * Any failure (missing folder, unreadable file) yields no catalog rather than
 * failing composition.
 */
async function scanUiTemplates(
  storage: Storage,
  personalityDir: string,
): Promise<Array<{ name: string; description?: string }>> {
  const dir = join(personalityDir, 'ui');
  try {
    const entries = await storage.listEntries(dir);
    const files = entries
      .filter((e) => !e.isDir && e.name.endsWith('.html'))
      .map((e) => e.name)
      .sort(); // deterministic order — the prompt prefix depends on it
    const catalog: Array<{ name: string; description?: string }> = [];
    for (const file of files) {
      const name = file.slice(0, -'.html'.length);
      let description: string | undefined;
      try {
        const html = await storage.read(join(dir, file));
        description = html ? templateDescription(html) : undefined;
      } catch {
        description = undefined;
      }
      catalog.push(description ? { name, description } : { name });
    }
    return catalog;
  } catch {
    return [];
  }
}

/** First HTML comment, else `<title>`; single line, trimmed, capped. */
function templateDescription(html: string): string | undefined {
  const comment = /<!--([\s\S]*?)-->/.exec(html)?.[1];
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1];
  for (const candidate of [comment, title]) {
    const line = candidate?.trim().split('\n')[0]?.trim();
    if (line) return line.slice(0, 160);
  }
  return undefined;
}

/**
 * ContextInjector that tells the agent about its personality asset folder —
 * the directory render tools reach through the `files://` URI scheme. The
 * advertised path is the one `createAssetDirResolver` yields, so the prompt
 * names the directory the tools actually resolve: the declared
 * `fs_reach.workdir` when there is one, else `<ethosHome>/personalities/<id>/files`.
 */
export function createPersonalityFilesInjector(
  personalityId: string,
  filesDir: string,
): ContextInjector {
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
 * D4 — the injector for an `ssh` posture that actually routes.
 *
 * A personality whose commands run on another machine is split down the middle,
 * and the model has to know exactly where the seam is: its shell is remote, its
 * files are local, and NOTHING confines the remote half. There is no remote
 * `fs_reach`, no denied-path floor, no mount set — the ssh backend provides
 * remote-host TRUST, not containment (review A3). That is a real property of
 * this deployment, so it is stated plainly rather than implied; an agent that
 * believes a path floor is protecting it will write commands as if one were.
 *
 * Static by construction (target and workdir come from operator config, not
 * from the turn), so the cached prompt prefix stays byte-identical.
 */
export function createRemoteExecutionInjector(opts: {
  personalityId: string;
  target: string;
  remoteWorkdir?: string;
}): ContextInjector {
  const where = opts.remoteWorkdir
    ? `\`${opts.remoteWorkdir}\` on the remote host`
    : 'the remote login directory';
  return {
    id: `remote-execution:${opts.personalityId}`,
    priority: 30,
    shouldInject(ctx: PromptContext): boolean {
      return ctx.personalityId === opts.personalityId;
    },
    inject(_ctx: PromptContext): Promise<InjectionResult | null> {
      return Promise.resolve({
        content: [
          '## Remote execution',
          `Your \`terminal\`, \`run_code\`, \`run_tests\` and \`lint\` tools run on the remote host \`${opts.target}\` over ssh. They do NOT run on this machine.`,
          'There is NO path floor on that host: the remote side has no fs_reach allowlist and no denied-path list, so a command you run there can read or write anything the ssh login user can. Treat every remote command as unconfined and say what you are about to do before you do it.',
          'Your file tools (`read_file`, `write_file`, `list_directory`, and the rest) stay on THIS machine. The two halves see different filesystems: a file you write with `write_file` does not exist on the remote host, and a file a remote command creates cannot be read with `read_file`. Move bytes between them with explicit commands, never by assuming a shared path.',
          `Commands run in ${where} unless you pass an explicit \`cwd\`, which is a path on the REMOTE host.`,
          '`process_*` (background processes) is not routed over ssh and will refuse.',
        ].join('\n'),
      });
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
  /** Ground-truth turn auditors (T4). Empty when `grounding.enabled: false`. */
  turnAuditors: TurnAuditor[];
  /** Ground-truth consult for `MemoryCaptureRunner` (R8). Absent when
   *  `grounding.enabled: false`, so capture behaves exactly as before. */
  memoryConsult?: GroundingMemoryConsult;
}

/**
 * Resolve the ssh execution backend for a personality whose posture routes
 * remotely (plan T5). `undefined` means "nothing is routed remotely" — the
 * caller then leaves execution where it already was: the host `ScopedProcess`
 * at a `local`/`none` posture, or a refusal at an `ssh` posture that reaches
 * `hostExecForbidden` with no backend.
 *
 * Three conditions, all load-bearing:
 *   - the posture is `ssh` — i.e. the personality declared `execution: remote`;
 *   - a target is actually configured — `execution.ssh.host` IS the switch.
 *     With no target the resolver has already marked the posture refused
 *     (`sshRefused.reason === 'unconfigured'`), and returning `undefined` here
 *     is what makes that refusal real: no backend, so exec tools answer
 *     `not_available` instead of running the work on this machine;
 *   - the constitution permits un-sandboxed execution (D7). ssh is remote-host
 *     TRUST, not mount-confinement, so `requireSandbox` / `forbidLocal` refuses
 *     it: no backend is built, and exec tools answer `not_available` rather
 *     than quietly running on this machine.
 *
 * `constitutionForbidsLocal` is CALLED, with the constitution. It is a
 * function: naming it without calling it yields a truthy object, `!fn` is a
 * constant `false`, and the whole gate becomes dead code that both `tsc` and
 * Biome accept — an ssh personality would then execute locally while its
 * character sheet named a remote host.
 *
 * No `SessionManager` wrap (D5): each ssh exec opens its own connection, so
 * there is no persistent session to keep alive and nothing for the wrapper's
 * lane bookkeeping to describe.
 */
export async function resolveSshExecutionBackend(input: {
  posture: ExecutionPosture;
  ssh?: NonNullable<ExecutionBackendConfig['ssh']>;
  constitution?: Constitution;
  substitutionVars: { ethosHome: string; cwd: string };
  registry: ExecutionBackendRegistry;
  secrets: SecretsResolver;
  logger: Logger;
}): Promise<ExecutionBackend | undefined> {
  const { posture, ssh, constitution } = input;
  if (posture.backend !== 'ssh') return undefined;
  if (ssh?.host === undefined) return undefined;
  if (constitutionForbidsLocal(constitution)) return undefined;

  try {
    return await input.registry.resolve('ssh', {
      config: {
        substitutionVars: input.substitutionVars,
        ...(constitution ? { constitution } : {}),
        ssh,
      },
      secrets: input.secrets,
      logger: input.logger,
    });
  } catch (err) {
    // Fail loud, exactly as docker does — and name the target, because the one
    // thing an operator needs from a boot failure here is WHICH machine could
    // not be reached and what ssh said about it.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `execution backend "ssh" (${formatSshTarget(ssh)}, required by this personality's posture) could not be resolved: ${detail}`,
      { cause: err },
    );
  }
}

/**
 * The refusal a `none` posture speaks with. Its own sentence, in the dialect the
 * other postures already use (`process tools are not routed over ssh in v1`, the
 * resolver's `sshRefused.message`) — never the tools' built-in Docker sentence,
 * which would blame a missing sandbox for a personality that declared it does
 * not run commands at all.
 */
const POSTURE_NONE_REFUSAL =
  'execution posture "none": this personality has no execution backend and does not run commands';

/**
 * What a personality's posture says about running commands on THIS host, and —
 * when the posture has its own words for a refusal — what to say. Exported so
 * the decision is testable on its own: `composeAllTools` needs a whole
 * `InfrastructureResult` to call, and this is the gate that decides whether a
 * shell opens.
 *
 * Three postures refuse:
 *   - `none` — the personality declares that it does not run commands at all.
 *     `execution: none` is loadable from a personality's `config.yaml` and
 *     documented as "execution refused", so falling through to the host
 *     `ScopedProcess` would make the field grant precisely what it denies. Every
 *     other reader of the posture already treats `none` as refusal
 *     (`createCheckRunExec` returns no route; the character sheet's G-EXEC row
 *     reads `n/a`) — this gate was the one that disagreed. It refuses
 *     unconditionally: no backend is ever resolved at this posture, so there is
 *     no wiring for a `backendWired` argument to excuse.
 *   - `docker` with no backend (disableDocker / daemon down) AND a constitution
 *     that forbids the `local` host fallback — the resolver leaves the posture
 *     `docker` with a `dockerAbsent` hard-fail.
 *   - `ssh` with no backend — the personality required `execution: remote` and
 *     this deployment could not honour it, either because nothing is configured
 *     or because the constitution forbids the un-sandboxed remote-host trust
 *     ssh provides. A `remote` requirement never resolves to the host, whatever
 *     the constitution permits, so an `ssh` posture arriving here unwired means
 *     refusal, never silent host.
 *
 * `message: undefined` means the posture has no wording of its own and the
 * tools’ built-in Docker sentence is the right one. The ssh refusals carry the
 * resolver’s own explanation (`sshRefused.message`), because the Docker sentence
 * names Docker, which under an ssh posture is simply false.
 */
export function resolveExecRefusal(
  posture: ExecutionPosture,
  backendWired: boolean,
): { forbidden: boolean; message?: string } {
  if (posture.backend === 'none') return { forbidden: true, message: POSTURE_NONE_REFUSAL };
  const forbidden = (posture.backend === 'docker' || posture.backend === 'ssh') && !backendWired;
  const message = posture.sshRefused?.message;
  return message !== undefined ? { forbidden, message } : { forbidden };
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

// ---------------------------------------------------------------------------
// Lane A Phase 2 (kanban-hooks-notify-parity) — auxiliary model for
// kanban_decompose. Resolved eagerly (composeAllTools is already async and
// runs once per AgentLoop construction) rather than lazily like the verifier
// getter above — there's no "only sometimes needed" argument once a team has
// kanban wired. Mirrors auxiliaryVision/auxiliaryWeb in build-agent-loop.ts:
// `provider`/`apiKey`/`baseUrl` default to the primary provider's values when
// unset, and an unregistered provider WARNS and degrades to `undefined`
// rather than throwing — kanban_decompose still registers as a tool, but
// returns a clear tool error at call time instead of crashing wiring for
// personalities that never call it. Exported for the wiring-level test.
// ---------------------------------------------------------------------------

export async function buildKanbanDecomposerProvider(
  registry: LLMProviderRegistry,
  config: WiringConfig,
  log: Logger,
): Promise<LLMProvider | undefined> {
  const aux = config.auxiliaryKanbanDecomposer;
  if (!aux) return undefined;
  const providerName = aux.provider ?? config.provider;
  const factory = registry.get(providerName);
  if (!factory) {
    log.warn(
      `auxiliary.kanban_decomposer provider "${providerName}" is not registered; ` +
        'kanban_decompose will return a tool error until it is',
    );
    return undefined;
  }
  const NOOP: SecretsResolver = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };
  const baseUrl = aux.baseUrl ?? config.baseUrl;
  return factory({
    config: {
      provider: providerName,
      model: aux.model,
      apiKey: aux.apiKey ?? config.apiKey,
      ...(baseUrl ? { baseUrl } : {}),
      ...(config.apiVersion ? { apiVersion: config.apiVersion } : {}),
    },
    secrets: config.secretsResolver ?? NOOP,
    logger: log,
  });
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
    // `execution.ssh.host`'s presence is the switch for the whole remote
    // posture. This is the call that decides what ACTUALLY executes, so it must
    // answer truthfully: claiming "not configured" here resolves an ssh
    // personality to `local` and runs its `terminal` / `run_code` / `run_tests`
    // / `lint` on this machine while the character sheet names a remote target.
    sshConfigured: config.execution?.ssh?.host !== undefined,
    ...(config.execution?.ssh ? { sshTarget: formatSshTarget(config.execution.ssh) } : {}),
  });

  const NOOP_SECRETS: SecretsResolver = {
    get: async () => null,
    set: async () => {},
    delete: async () => {},
    list: async () => [],
  };

  let executionBackend: ExecutionBackend | undefined;
  if (posture.backend === 'docker' && !opts.disableDocker && !posture.dockerAbsent) {
    const backendConfig: ExecutionBackendConfig = {
      substitutionVars: { ethosHome: dataDir, cwd: wiringCtx.workingDir },
      // `execution.docker.*` — container resource caps. Absent leaves the
      // backend on its `--cpus 2` default with no disk quota.
      ...(config.execution?.docker?.cpu !== undefined ? { cpu: config.execution.docker.cpu } : {}),
      ...(config.execution?.docker?.diskMb !== undefined
        ? { diskMb: config.execution.docker.diskMb }
        : {}),
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
  } else {
    // Remote routing (plan T5). Returns undefined unless the posture, the
    // operator config and the constitution ALL say route — which is the common
    // case here, since this arm also runs for `local` and `none` postures.
    executionBackend = await resolveSshExecutionBackend({
      posture,
      ...(config.execution?.ssh ? { ssh: config.execution.ssh } : {}),
      ...(infra.constitution ? { constitution: infra.constitution } : {}),
      substitutionVars: { ethosHome: dataDir, cwd: wiringCtx.workingDir },
      registry: infra.executionBackends,
      secrets: config.secretsResolver ?? NOOP_SECRETS,
      logger: log,
    });
  }

  // Whether host execution is forbidden, and in whose words. See
  // `resolveExecRefusal` for the three postures that refuse and why.
  const refusal = resolveExecRefusal(posture, executionBackend !== undefined);
  const hostExecForbidden = refusal.forbidden;
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

  // Execution is routed to ANOTHER machine. Two consequences the tools have to
  // know about: the host working directory is not a path that exists there
  // (D8), and the binary this process spawns is `ssh`, not `docker`.
  const remoteExec = posture.backend === 'ssh' && executionBackend !== undefined;

  // The refusal, in the posture's OWN words. The resolver already wrote the
  // truthful explanation onto `sshRefused` — a target nobody configured, or a
  // constitution that requires a sandbox — and the tools' built-in sentence
  // names Docker, which under a `remote` requirement is simply false. One
  // wording, from the component that made the decision.
  const execForbiddenMessage = refusal.message;

  // D4 — `process_*` is NOT routed over ssh in v1: a background process needs a
  // remote lifecycle (kill on stop, log capture, env delivery) that this
  // backend has no design for. It must not fall through to the host either —
  // that would put a detached process on the wrong machine while every other
  // exec tool is remote. So under an ssh posture these tools get NO backend and
  // an explicit refusal, whatever the constitution says.
  const processSshUnsupported = 'process tools are not routed over ssh in v1';
  const sshPosture = posture.backend === 'ssh';

  // -------------------------------------------------------------------------
  // Group A: inline tool factories
  // -------------------------------------------------------------------------

  for (const tool of createFileTools()) tools.register(tool);
  tools.register(createXSearchTool());
  tools.register(createRedditSearchTool());
  tools.register(createRedditThreadTool());
  for (const tool of createTerminalTools({
    backend: executionBackend,
    personality: activePerson,
    hostExecForbidden,
    ...(execForbiddenMessage !== undefined
      ? { hostExecForbiddenMessage: execForbiddenMessage }
      : {}),
  }))
    tools.register(tool);
  const assetDirFor = createAssetDirResolver((id) => personalities.get(id), {
    ethosHome: dataDir,
    cwd: wiringCtx.workingDir,
  });
  for (const tool of buildUiTools(assetDirFor)) tools.register(tool);
  const personalityDirFor = createPersonalityDirResolver((id) => personalities.get(id));
  for (const tool of buildCardTools({ personalityDir: personalityDirFor })) tools.register(tool);

  // One InMemoryTodoStore per process — lifetime tied to the AgentLoop.
  const { tools: todoTools } = composeTodo(wiringCtx);
  for (const tool of todoTools) tools.register(tool);
  tools.register(createThinkDeeperTool());

  for (const tool of composeInteractive(wiringCtx, { clarifyBridge }).tools) tools.register(tool);

  // Kanban tools — wired only when the active personality actually uses them.
  let kanbanStore: KanbanStore | null = null;
  if ((activePerson.toolset ?? []).some((name: string) => name.startsWith('kanban_'))) {
    const kanbanDbPath = resolveKanbanDbPath(config, dataDir);
    kanbanStore = new KanbanStore(kanbanDbPath, {
      ...(config.kanban?.maxInProgress !== undefined
        ? { maxInProgress: config.kanban.maxInProgress }
        : {}),
      ...(config.kanban?.maxInProgressPerProfile !== undefined
        ? { maxInProgressPerProfile: config.kanban.maxInProgressPerProfile }
        : {}),
    });
    const store = kanbanStore;
    const kanbanOpts: {
      store: KanbanStore;
      hooks?: typeof hooks;
      autonomyTierOf?: AutonomyTierOf;
      personalityLookup?: (id: string) => { name: string } | undefined;
      decomposerProvider?: LLMProvider;
    } = {
      store,
      hooks,
      personalityLookup: (id: string) => {
        const p = personalities.get(id);
        return p ? { name: p.name } : undefined;
      },
      decomposerProvider: await buildKanbanDecomposerProvider(infra.llmProviders, config, log),
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
    // the eval-harness verifier is default-wired, not opt-in.
    //
    // Ground-truth verification R8 — the verifier is now registered ALWAYS,
    // solo included. What changes with `teamName` is only whether the LLM
    // JUDGE runs: judging prose costs a model call and needs a team provider,
    // whereas a `check:` line states a fact a probe settles for free. A solo
    // deployment writing prose-only criteria therefore behaves exactly as it
    // did before — no provider, nothing to judge, completion proceeds.
    //
    // The probe roots relative check paths at the team's directory (R4), or at
    // the personality's own workdir when there is no team. Unresolvable →
    // omitted, and a ticket carrying checks then fails closed rather than
    // completing on a verification nobody ran.
    const verifyWorkdir =
      config.teamName !== undefined && isSafeTeamName(config.teamName)
        ? join(dataDir, 'teams', config.teamName)
        : assetDirFor(activePerson.id);
    // `check: run` executes THROUGH the personality's own execution posture —
    // the container when there is one, the host `ScopedProcess` at `local`, and
    // nothing at all when the personality may not run commands. Before this,
    // the probe spawned via `node:child_process` itself: a second execution
    // path with none of the controls attached to the first. `undefined` here
    // means `run` checks fail closed.
    const checkRunExec = createCheckRunExec({
      posture,
      ...(executionBackend !== undefined ? { backend: executionBackend } : {}),
      personality: activePerson,
      allowedCheckCommands: config.grounding?.kanban?.allowedCheckCommands ?? [],
      hostExecForbidden,
    });
    hooks.registerClaiming(
      'before_ticket_complete',
      createCompletionVerifier({
        ...(config.teamName !== undefined
          ? { getProvider: buildVerifierProviderGetter(infra.llmProviders, config, log) }
          : {}),
        ...(verifyWorkdir !== undefined
          ? {
              probe: createCheckProbe({
                storage: wiringCtx.storage,
                workdir: verifyWorkdir,
                ...(checkRunExec !== undefined ? { exec: checkRunExec } : {}),
              }),
            }
          : {}),
        // Empty by default, so `check: run …` executes nothing until an
        // operator names a command.
        allowedCheckCommands: config.grounding?.kanban?.allowedCheckCommands ?? [],
        // `grounding.enabled` is the MASTER switch over both halves of this
        // feature; `grounding.kanban.checks` is the per-feature one. Either
        // being false turns the deterministic pass off WHOLE — nothing parsed,
        // nothing probed, nothing spawned — because an off-switch that leaves
        // half the feature running is worse than no switch at all: the
        // operator believes they turned it off.
        checks: kanbanChecksEnabled(config.grounding),
      }),
    );
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
    // D4 — deliberately NOT `executionBackend`: under an ssh posture these
    // tools are excluded from remote routing and must refuse, not run.
    ...(sshPosture ? {} : { backend: executionBackend }),
    personality: activePerson,
    hostExecForbidden: sshPosture ? true : hostExecForbidden,
    ...(sshPosture
      ? { hostExecForbiddenMessage: processSshUnsupported }
      : execForbiddenMessage !== undefined
        ? { hostExecForbiddenMessage: execForbiddenMessage }
        : {}),
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
    ...(execForbiddenMessage !== undefined
      ? { hostExecForbiddenMessage: execForbiddenMessage }
      : {}),
  }).tools)
    tools.register(tool);

  if (!opts.disableDocker) {
    for (const tool of composeBrowser(wiringCtx, {
      visionApiKey: config.apiKey,
      visionProvider: config.provider,
      visionModel: config.model,
      ...(config.browser?.navigationTimeoutMs !== undefined
        ? { navigationTimeoutMs: config.browser.navigationTimeoutMs }
        : {}),
      ...(config.browser?.commandTimeoutMs !== undefined
        ? { commandTimeoutMs: config.browser.commandTimeoutMs }
        : {}),
      ...(config.browser?.headed !== undefined ? { headed: config.browser.headed } : {}),
      ...(config.browser?.idleTimeoutMs !== undefined
        ? { idleTimeoutMs: config.browser.idleTimeoutMs }
        : {}),
      ...(config.browser?.profiles?.enabled !== undefined
        ? { profilesEnabled: config.browser.profiles.enabled }
        : {}),
      ...(config.browser?.proxy ? { proxy: config.browser.proxy } : {}),
      // B1 — the bridge is what makes `browser_request_takeover` registrable,
      // and registering it is what lets the bot-wall hint name it.
      clarifyBridge,
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

  // Voice tools — `voice_session` is the always-available capability marker that
  // makes a personality selectable for real-time voice (browser talk-mode /
  // telephony); the web talk-mode gate keys off its presence in the toolset.
  //
  // The outbound `call` tool goes live exactly when a trunk is configured:
  // `resolveSipTrunkClient` is the SAME derivation `buildVoiceStack` uses
  // (`voice.trunk.*` + `voice.livekit.*`), so "the tool is advertised" and "the
  // deployment can dial" are one fact rather than two that can disagree. With
  // neither block configured it returns undefined and `call.isAvailable()` stays
  // false with its existing error. `call` is in APPROVAL_SURFACE_ALWAYS_ASK
  // (see `./danger-predicate`), so the approval gate was in place before the
  // capability went live.
  //
  // The call log is threaded through so an agent-PLACED call leaves a row, the
  // way an inbound one always has. Optional: a surface that wires none (chat,
  // one-shot CLI) dials exactly as before and writes nothing.
  const sipTrunk = resolveSipTrunkClient(config);
  for (const tool of createVoiceTools({
    ...(sipTrunk ? { trunk: sipTrunk } : {}),
    ...(config.voice?.trunk?.fromNumber ? { fromNumber: config.voice.trunk.fromNumber } : {}),
    ...(opts.callLog ? { callLog: opts.callLog } : {}),
    onError: (message) => log.warn(`voice: ${message}`),
  }))
    tools.register(tool);

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

  // Skill introspection tools — skills_list + skill_view, plus the pending-queue
  // review tools. The library handle is the same class the web Skills/Evolver
  // tab drives, so chat-side approve/reject is one path, not a second one.
  for (const tool of composeSkillsTools(wiringCtx, {
    skillPool,
    pendingSkills: new SkillsLibrary({
      dataDir: wiringCtx.dataDir,
      storage: wiringCtx.storage,
    }),
  }).tools) {
    tools.register(tool);
  }

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
    // stdio clients need a resolver to materialise `${secrets:...}` env refs
    // at spawn time. OAuth transports still get the per-personality scoped
    // resolver derived from `innerSecrets`.
    secrets: config.secretsResolver,
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

  // -------------------------------------------------------------------------
  // Ground-truth verification (T4) — evidence collector + per-turn ledger reset
  // + the claims auditor. Registered for solo AND team deployments, unlike the
  // kanban completion verifier above (R8). `isAlive` is the injected `pidAlive`
  // port; the layer crossing happens here, at the wiring seam, because the
  // groundtruth package may import nothing but `@ethosagent/types`.
  // -------------------------------------------------------------------------

  const grounding = composeGrounding({
    ...(config.grounding ? { config: config.grounding } : {}),
    hooks,
    pidAlive: isAlive,
  });
  injectors.push(...grounding.injectors);

  // Plan B — kanban role gate hook.
  if (kanbanStore !== null && config.teamName !== undefined && config.role !== undefined) {
    hooks.registerModifying(
      'before_tool_call',
      createKanbanRoleGateHook({
        role: config.role,
        personalityId: activePerson.id,
        store: kanbanStore,
        ...(config.coordinatorId !== undefined ? { coordinatorId: config.coordinatorId } : {}),
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

    // Lane C (kanban-hooks-notify-parity, Phase 2) — pending-notify queue.
    // One file per dataDir, same as goals.db: the ACP server (writer) opens
    // its own handle onto the same path independently, the same two-instance
    // pattern delivery-ledger.db already uses across the gateway and
    // web-api processes.
    const notifyQueue = new SQLiteNotifyQueue(join(dataDir, 'notify-queue.db'));
    injectors.push(createPendingNotifyInjector(notifyQueue, config.teamName));
  }

  // -------------------------------------------------------------------------
  // Remote execution injector (D4) — only when execution ACTUALLY routes over
  // ssh. A refused or fallen-back ssh posture must not tell the model its
  // commands run on another machine when they do not run at all, or run here.
  // -------------------------------------------------------------------------

  if (remoteExec) {
    const sshCfg = config.execution?.ssh;
    injectors.push(
      createRemoteExecutionInjector({
        personalityId: activePerson.id,
        target: posture.sshTarget ?? (sshCfg ? formatSshTarget(sshCfg) : 'the configured host'),
        ...(sshCfg?.remoteWorkdir !== undefined ? { remoteWorkdir: sshCfg.remoteWorkdir } : {}),
      }),
    );
  }

  // -------------------------------------------------------------------------
  // Personality files injector
  // -------------------------------------------------------------------------

  // The prompt must name the SAME directory `files://` resolves to, so it goes
  // through the one resolver. An unresolvable asset folder (declared workdir
  // with an empty substitution variable) advertises nothing rather than a path
  // the render tools would refuse.
  const activeAssetDir = assetDirFor(activePerson.id);
  if (activeAssetDir) {
    injectors.push(createPersonalityFilesInjector(activePerson.id, activeAssetDir));
  }

  // -------------------------------------------------------------------------
  // UI-guidance injector — cards + Canvas composition rules
  // -------------------------------------------------------------------------

  // Gated on reach, not on registration: the card tools are always registered
  // (the registry filters them per personality), but turn-composition rules are
  // dead prompt weight for a personality that cannot emit a card. An undefined
  // toolset means "all tools", so it qualifies.
  const activeToolset = activePerson.toolset;
  const reachesCards =
    activeToolset === undefined ||
    activeToolset.some((name: string) => name === 'emit_card' || name === 'render_ui');
  if (reachesCards) {
    const personalityDir = personalityDirFor(activePerson.id);
    const templates = personalityDir
      ? await scanUiTemplates(wiringCtx.storage, personalityDir)
      : [];
    injectors.push(createUiGuidanceInjector({ personalityId: activePerson.id, templates }));
  }

  // -------------------------------------------------------------------------
  // Spoken-style injector — how a voice personality talks (voice V1a §4)
  // -------------------------------------------------------------------------

  // Gated on DECLARED intent to be heard: a `voice` block, or `voice_session`
  // in the toolset. Unlike the card injector above, an undefined toolset
  // ("all tools") does NOT qualify — most personalities are text-only, and
  // ~900 chars of rules about speaking is dead weight on every one of them.
  //
  // The content is built from the personality id ALONE and never consults the
  // turn, so the static prompt prefix stays byte-identical across turns — a
  // session that mixes typed and spoken turns is exactly the case that would
  // break if the per-turn fact lived here instead of on the message
  // (`packages/core/src/__tests__/prompt-prefix-stability.test.ts`).
  const speaks =
    activePerson.voice !== undefined ||
    (activeToolset?.some((name: string) => name === 'voice_session') ?? false);
  if (speaks) {
    injectors.push(createSpokenStyleInjector({ personalityId: activePerson.id }));
  }

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
    turnAuditors: grounding.turnAuditors,
    ...(grounding.memoryConsult ? { memoryConsult: grounding.memoryConsult } : {}),
  };
}
