import { join } from 'node:path';
import {
  type CharacterSheetModelFit,
  type CharacterSheetScriptSurface,
  type CreatePersonalityInput,
  type DescribedPersonality,
  type FilePersonalityRegistry,
  type PersonalityToolsConfig,
  renderCharacterSheet,
  SYSTEM_PERSONALITY_IDS,
  type UpdatePersonalityPatch,
} from '@ethosagent/personalities';
import { draftExpressionUpdate, draftSoulSplit } from '@ethosagent/skill-evolver';
import type { PersonalitySkillRecord, SkillsInjector, SkillsLibrary } from '@ethosagent/skills';
import { type McpJsonStore, mcpTokenSecretRef } from '@ethosagent/tools-mcp';
import {
  EthosError,
  type ExecutionPosture,
  type LearningLogEntry,
  type Storage,
} from '@ethosagent/types';
import type { McpPolicy, Personality, PersonalitySkill } from '@ethosagent/web-contracts';

/** Latest Personality-Judge alignment, mapped from `.judge-history/state.json`. */
interface JudgeWire {
  alignmentScore: number;
  signal: 'drift' | 'underspecified_soul' | null;
  lowStreak: number;
  at?: string;
  perDimension?: Array<{ dimension: string; score: number }>;
}

/** Latest nightly-pass status, mapped from `.nightly-state.json`. */
interface NightlyWire {
  windowEnd: string;
  completed: string[];
}

// Personalities service. Calls into FilePersonalityRegistry for the
// directory-level CRUD (create/update/delete/duplicate) and into
// SkillsLibrary for the per-personality skills/ subdir. Both extensions
// own their own Storage layer; the service is a thin wire-shape mapper.

export interface PersonalitiesServiceOptions {
  personalities: FilePersonalityRegistry;
  library: SkillsLibrary;
  secrets?: import('@ethosagent/types').SecretsResolver;
  mcpJsonStore?: McpJsonStore;
  /** Lazy LLM factory — drafts Expression updates and Soul splits (Phase 3a). */
  llm?: () => Promise<import('@ethosagent/types').LLMProvider>;
  /** Session store — supplies recent-interaction evidence for Expression drafts. */
  sessions?: import('@ethosagent/types').SessionStore;
  /** Storage — used to read the personality's Personality-Judge
   *  alignment sidecar. Omitted → `livingSoul` returns no `judge` block. */
  storage?: Storage;
  /**
   * Root data directory (`~/.ethos`). Used to read the Personality-Judge
   * alignment sidecar and to derive the `fs_reach` mount set for the character
   * sheet's `## Execution` section (Phase 2a, lane E1). When absent, the sheet
   * renders without the Execution block.
   */
  dataDir?: string;
  /**
   * Whether a Docker backend can be built in this process (F1). False for the
   * desktop in-process backend (`disableDocker: true`), so the character sheet
   * honestly shows a `local` (un-sandboxed) posture instead of claiming Docker.
   * Defaults to `true` (server deployments where Docker is available).
   */
  dockerBuildable?: boolean;
  /**
   * Optional refresh closure — reloads the personality registry from disk
   * before a read so a hot-dropped or edited personality is visible without a
   * server restart. Awaited at the top of `list`/`get`/`characterSheet`.
   * Absent → no refresh (registry state as of last mutation/boot).
   */
  refresh?: () => Promise<void>;
  /**
   * The live `SkillsInjector` from wiring — backs `renderers()`. It resolves
   * against the LOOP's personality registry (a different instance from
   * `personalities` above), which is why `refreshLoopPersonalities` exists.
   * Absent → `renderers()` returns `[]` (tests, onboarding, deployments with
   * no loop).
   */
  skillsInjector?: SkillsInjector;
  /**
   * `CreateAgentLoopResult.refreshPersonalities` — reloads the LOOP registry
   * the injector reads. Awaited in `renderers()` so a personality edited on
   * disk (e.g. a `skills/` dir just created) is seen without a restart.
   */
  refreshLoopPersonalities?: () => Promise<void>;
  /**
   * Lane 6 (D5) — compute the arithmetic model-fit verdict for a personality.
   * A closure over wiring's `resolvePersonalityModelFit` (the service never
   * sees the tool registry or provider config). Absent, resolving `null`, or
   * throwing → the sheet renders without the `## Model fit` section.
   */
  modelFit?: (personalityId: string) => Promise<CharacterSheetModelFit | null>;
  /**
   * tools-as-code-api Lane G — the script-callable surface for the sheet's
   * `Script-callable (run_code)` line. A closure over core's
   * `scriptCallableFor` against the live tool registry (same derivation the
   * ScriptToolBridge enforces). Absent, resolving `null`, or throwing → the
   * sheet renders without the line.
   */
  scriptSurface?: (personalityId: string) => Promise<CharacterSheetScriptSurface | null>;
}

export class PersonalitiesService {
  constructor(private readonly opts: PersonalitiesServiceOptions) {}

  async list(): Promise<{ items: Personality[]; nextCursor: string | null; defaultId: string }> {
    await this.opts.refresh?.();
    return {
      items: this.opts.personalities.describeAll().map(toWire),
      nextCursor: null,
      defaultId: this.opts.personalities.getDefault().id,
    };
  }

  async get(
    id: string,
  ): Promise<{ personality: Personality; soulMd: string; mcpPolicy: McpPolicy | null }> {
    await this.opts.refresh?.();
    const described = this.opts.personalities.describe(id);
    if (!described) throw notFound(id);
    const soulMd = await this.opts.personalities.readSoulMd(id);
    return { personality: toWire(described), soulMd, mcpPolicy: described.mcpPolicy ?? null };
  }

  /** Generated Markdown character sheet — the same artifact `ethos personality
   *  show` prints, rendered for the Web Personalities tab. Also returns the
   *  structured `ExecutionPosture` (Phase 2a, lane E1) so the web Execution UI
   *  renders the posture the resolver produced rather than recomputing it. */
  async characterSheet(
    id: string,
  ): Promise<{ markdown: string; posture: ExecutionPosture | null }> {
    await this.opts.refresh?.();
    const described = this.opts.personalities.describe(id);
    if (!described) throw notFound(id);
    const soulMd = await this.opts.personalities.readSoulMd(id);
    // Lane 6 — same computed verdict, same single generator as the CLI
    // (D5: one generator, both surfaces). Fail-soft: a throwing seam renders
    // the sheet without the verdict — the sheet is the RPC's contract.
    let modelFit: CharacterSheetModelFit | undefined;
    if (this.opts.modelFit) {
      try {
        modelFit = (await this.opts.modelFit(id)) ?? undefined;
      } catch {
        modelFit = undefined;
      }
    }
    // Lane G — same fail-soft posture as modelFit: no seam, no line.
    let scriptSurface: CharacterSheetScriptSurface | undefined;
    if (this.opts.scriptSurface) {
      try {
        scriptSurface = (await this.opts.scriptSurface(id)) ?? undefined;
      } catch {
        scriptSurface = undefined;
      }
    }
    const dataDir = this.opts.dataDir;
    if (!dataDir) {
      return {
        markdown: renderCharacterSheet(
          described.config,
          soulMd,
          undefined,
          modelFit,
          scriptSurface,
        ),
        posture: null,
      };
    }
    // Same posture resolver + renderer the CLI `personality show` uses — one
    // artifact, no second renderer (Phase 2a, lane E1).
    const { buildExecutionPosture } = await import('@ethosagent/wiring');
    const posture = await buildExecutionPosture({
      personality: described.config,
      substitutionVars: { ethosHome: dataDir, cwd: process.cwd() },
      ...(this.opts.dockerBuildable === false ? { dockerBuildable: false } : {}),
    });
    return {
      markdown: renderCharacterSheet(
        described.config,
        soulMd,
        { posture },
        modelFit,
        scriptSurface,
      ),
      posture,
    };
  }

  async create(input: CreatePersonalityInput): Promise<{ personality: Personality }> {
    const created = await this.opts.personalities.create(input);
    return { personality: toWire(created) };
  }

  async update(id: string, patch: UpdatePersonalityPatch): Promise<{ personality: Personality }> {
    const updated = await this.opts.personalities.update(id, patch);
    return { personality: toWire(updated) };
  }

  /**
   * Write per-server MCP tool subsets into the personality's `mcp.yaml`.
   * `subsets` maps a server name to either an explicit bare-tool-name list
   * (a strict subset) or `null` to clear any prior subset (all tools
   * allowed). Delegates to the registry, which preserves `reject_args`.
   */
  async writeMcpToolSubsets(id: string, subsets: Record<string, string[] | null>): Promise<void> {
    await this.opts.personalities.writeMcpToolSubsets(id, subsets);
  }

  /**
   * Build per-server tool subsets from the editor's `mcp_tools` map and write
   * them. A server with every tool selected is omitted from `mcpTools` by the
   * UI → `null` clears any prior subset back to default-allow.
   */
  async writeMcpToolSubsetsFor(
    id: string,
    servers: string[],
    mcpTools: Record<string, string[]>,
  ): Promise<void> {
    const subsets: Record<string, string[] | null> = {};
    for (const server of servers) {
      subsets[server] = mcpTools[server] ?? null;
    }
    await this.opts.personalities.writeMcpToolSubsets(id, subsets);
  }

  /** Whether a personality's files are read-only built-ins (its tool bindings
   *  must go to the global `toolSettings` fallback, not a `tools.yaml`). */
  isBuiltin(id: string): boolean {
    return this.opts.personalities.describe(id)?.builtin ?? false;
  }

  /** Read a custom personality's own `tools.yaml` bindings (source of truth).
   *  Undefined when the personality has no `tools.yaml`. */
  getToolsConfig(id: string): PersonalityToolsConfig | undefined {
    this.requirePersonality(id);
    return this.opts.personalities.getToolsConfig(id);
  }

  /** Write a custom personality's `tools.yaml` (only a secret NAME, never a
   *  value). Throws for built-ins — their bindings live in the global
   *  `toolSettings` fallback. */
  async writeToolsConfig(id: string, config: PersonalityToolsConfig): Promise<void> {
    this.requirePersonality(id);
    await this.opts.personalities.writeToolsConfig(id, config);
  }

  async delete(id: string): Promise<void> {
    await this.opts.personalities.deletePersonality(id);
  }

  async duplicate(id: string, newId: string): Promise<{ personality: Personality }> {
    const created = await this.opts.personalities.duplicate(id, newId);
    return { personality: toWire(created) };
  }

  /**
   * Renderer capabilities the personality's resolved skill set declares
   * (`ethos.renders`). Derived by the live `SkillsInjector` — the same
   * eligibility decision that builds the prompt, so what a personality is
   * TAUGHT and what it may RENDER cannot drift apart.
   *
   * Fail-closed by construction: no injector wired, an unknown personality, or
   * a throwing derivation all yield `[]`, which every surface renders as a
   * plain code block. A chart that appears a beat late is fine; a chart that
   * appears for a personality without the skill is not.
   */
  async renderers(id: string): Promise<{ renderers: string[] }> {
    const injector = this.opts.skillsInjector;
    if (!injector) return { renderers: [] };
    try {
      // Two registries, both refreshed: this service reads its own (to reject an
      // unknown id — `resolveSkills` would otherwise silently fall back to the
      // DEFAULT personality's skills), while the injector closes over the LOOP's.
      // Refreshing the loop's is what makes a freshly installed skills/ dir
      // visible without a restart.
      await this.opts.refresh?.();
      await this.opts.refreshLoopPersonalities?.();
      if (!this.opts.personalities.describe(id)) return { renderers: [] };
      return { renderers: await injector.resolveRenderers(id) };
    } catch {
      return { renderers: [] };
    }
  }

  // ---------------------------------------------------------------------------
  // Per-personality skills (gate 19)
  // ---------------------------------------------------------------------------

  async skillsList(personalityId: string): Promise<{ skills: PersonalitySkill[] }> {
    this.requirePersonality(personalityId);
    const records = await this.opts.library.listPersonalitySkills(personalityId);
    return { skills: records.map(toWirePersonalitySkill) };
  }

  async skillsGet(personalityId: string, skillId: string): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.getPersonalitySkill(personalityId, skillId);
    if (!skill) {
      throw new EthosError({
        code: 'SKILL_NOT_FOUND',
        cause: `Skill "${skillId}" not found for personality "${personalityId}".`,
        action: 'Use personalities.skillsList to see installed skills.',
      });
    }
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsCreate(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.createPersonalitySkill(personalityId, skillId, body);
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsUpdate(
    personalityId: string,
    skillId: string,
    body: string,
  ): Promise<{ skill: PersonalitySkill }> {
    this.requirePersonality(personalityId);
    const skill = await this.opts.library.updatePersonalitySkill(personalityId, skillId, body);
    return { skill: toWirePersonalitySkill(skill) };
  }

  async skillsDelete(personalityId: string, skillId: string): Promise<void> {
    this.requirePersonality(personalityId);
    await this.opts.library.deletePersonalitySkill(personalityId, skillId);
  }

  async skillsImportGlobal(
    personalityId: string,
    skillIds: string[],
  ): Promise<{ imported: PersonalitySkill[] }> {
    this.requirePersonality(personalityId);
    const records = await this.opts.library.importGlobalIntoPersonality(personalityId, skillIds);
    return { imported: records.map(toWirePersonalitySkill) };
  }

  // ---------------------------------------------------------------------------
  // Pending skill-candidate review queue. The nightly skill-evolver (manual
  // mode) drafts candidates into `<dataDir>/skills/.pending/<id>/<file>.md`
  // and leaves them for a human. Approving promotes the file into the live
  // skills dir (`<dataDir>/skills/<file>.md`); rejecting deletes it. Paths
  // mirror `proposeSkillFromEvidence` in @ethosagent/skill-evolver exactly.
  // ---------------------------------------------------------------------------

  async skillCandidatesList(
    personalityId: string,
  ): Promise<{ candidates: Array<{ fileName: string; content: string }> }> {
    this.requirePersonality(personalityId);
    const { storage, dataDir } = this.opts;
    if (!storage || !dataDir) return { candidates: [] };
    const pendingDir = join(dataDir, 'skills', '.pending', personalityId);
    const names = (await storage.list(pendingDir)).filter((n) => n.endsWith('.md'));
    const candidates: Array<{ fileName: string; content: string }> = [];
    for (const fileName of names) {
      const content = await storage.read(join(pendingDir, fileName));
      if (content !== null) candidates.push({ fileName, content });
    }
    return { candidates };
  }

  async skillCandidateApprove(
    personalityId: string,
    fileName: string,
  ): Promise<{ ok: true; promotedTo: string }> {
    this.requirePersonality(personalityId);
    const { storage, dataDir } = this.opts;
    if (!storage || !dataDir) throw storageNotConfigured();
    this.assertCandidateFileName(fileName);
    const pendingPath = join(dataDir, 'skills', '.pending', personalityId, fileName);
    const liveDir = join(dataDir, 'skills');
    const livePath = join(liveDir, fileName);
    const body = await storage.read(pendingPath);
    if (body === null) throw candidateNotFound(personalityId, fileName);
    // If the live file already exists, treat the candidate as already promoted:
    // skip the (re)write but still clear the pending file so the queue drains.
    if (!(await storage.exists(livePath))) {
      await storage.mkdir(liveDir);
      await storage.writeAtomic(livePath, body);
    }
    await storage.remove(pendingPath);
    return { ok: true, promotedTo: livePath };
  }

  async skillCandidateReject(personalityId: string, fileName: string): Promise<void> {
    this.requirePersonality(personalityId);
    const { storage, dataDir } = this.opts;
    if (!storage || !dataDir) throw storageNotConfigured();
    this.assertCandidateFileName(fileName);
    const pendingPath = join(dataDir, 'skills', '.pending', personalityId, fileName);
    // Idempotent: a missing file is already in the desired state.
    if (await storage.exists(pendingPath)) await storage.remove(pendingPath);
  }

  /** Reject anything that is not a bare `<name>.md` (no path separators, no
   *  `..`) so a candidate name can never escape the pending dir. */
  private assertCandidateFileName(fileName: string): void {
    if (!/^[a-zA-Z0-9_-]+\.md$/.test(fileName)) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: `Invalid skill-candidate file name "${fileName}".`,
        action: 'Pass a bare "<name>.md" file name with no path separators.',
      });
    }
  }

  async mcpSetToken(personalityId: string, server: string, token: string): Promise<void> {
    this.requirePersonality(personalityId);
    const described = this.opts.personalities.describe(personalityId);
    if (!described || !(described.config.mcp_servers ?? []).includes(server)) {
      throw new EthosError({
        code: 'MCP_SERVER_NOT_FOUND',
        cause: `Server "${server}" is not attached to personality "${personalityId}".`,
        action: 'Attach the server first via personalities.update, then set the token.',
      });
    }
    if (!this.opts.secrets) {
      throw new EthosError({
        code: 'SECRETS_UNAVAILABLE',
        cause: 'No secrets resolver configured',
        action: 'Configure secrets in web-api startup.',
      });
    }
    const { PersonalityScopedSecrets } = await import('@ethosagent/storage-fs');
    const scoped = new PersonalityScopedSecrets(this.opts.secrets, personalityId);
    await scoped.set(mcpTokenSecretRef(server), token);
    // If the server entry in mcp.json has no bearer auth block, add one now so
    // the McpClient actually sends the Authorization header.
    if (this.opts.mcpJsonStore) {
      const config = await this.opts.mcpJsonStore.get(server);
      if (config && config.auth?.type !== 'bearer') {
        await this.opts.mcpJsonStore.upsert(server, {
          ...config,
          auth: { type: 'bearer' as const },
        });
      }
    }
  }

  async mcpDeleteToken(personalityId: string, server: string): Promise<void> {
    this.requirePersonality(personalityId);
    const described = this.opts.personalities.describe(personalityId);
    if (!described || !(described.config.mcp_servers ?? []).includes(server)) {
      throw new EthosError({
        code: 'MCP_SERVER_NOT_FOUND',
        cause: `Server "${server}" is not attached to personality "${personalityId}".`,
        action: 'Attach the server first via personalities.update, then set the token.',
      });
    }
    if (!this.opts.secrets) {
      throw new EthosError({
        code: 'SECRETS_UNAVAILABLE',
        cause: 'No secrets resolver configured',
        action: 'Configure secrets in web-api startup.',
      });
    }
    const { PersonalityScopedSecrets } = await import('@ethosagent/storage-fs');
    const scoped = new PersonalityScopedSecrets(this.opts.secrets, personalityId);
    await scoped.delete(mcpTokenSecretRef(server));
  }

  // ---------------------------------------------------------------------------
  // Governed learning — Living Soul Expression evolution (Phase 3a)
  // ---------------------------------------------------------------------------

  async livingSoul(id: string): Promise<{
    core: string;
    expression: string;
    learningLog: LearningLogEntry[];
    judge?: JudgeWire;
    nightly?: NightlyWire;
  }> {
    const soul = await this.opts.personalities.readLivingSoul(id);
    const judge = await this.readJudge(id);
    const nightly = await this.readNightly(id);
    return {
      ...soul,
      ...(judge ? { judge } : {}),
      ...(nightly ? { nightly } : {}),
    };
  }

  /**
   * Read the latest Personality-Judge alignment from
   * `<dataDir>/personalities/<id>/.judge-history/state.json`. Tolerant — a
   * missing dir/file, malformed JSON, or an unexpected shape returns null
   * (the `judge` block is then omitted). Never throws; never `as`-casts the
   * untrusted JSON (validates field-by-field, mirroring the digest readers).
   */
  private async readJudge(id: string): Promise<JudgeWire | null> {
    const { storage, dataDir } = this.opts;
    if (!storage || !dataDir) return null;
    const path = join(dataDir, 'personalities', id, '.judge-history', 'state.json');
    const raw = await storage.read(path);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const obj = parsed as Record<string, unknown>;
      const lastResult = obj.lastResult;
      if (!lastResult || typeof lastResult !== 'object') return null;
      const result = lastResult as Record<string, unknown>;
      const alignmentScore = result.alignmentScore;
      if (typeof alignmentScore !== 'number') return null;
      const signal = result.signal;
      const perDimension = Array.isArray(result.perDimension)
        ? result.perDimension.flatMap((d) => {
            if (!d || typeof d !== 'object') return [];
            const dim = d as Record<string, unknown>;
            const score = dim.score;
            // On disk the field is `id` (the dimension key). Surface it as
            // `dimension` for the wire shape.
            const dimension = dim.id ?? dim.dimension;
            if (typeof dimension !== 'string' || typeof score !== 'number') return [];
            return [{ dimension, score }];
          })
        : undefined;
      return {
        alignmentScore,
        signal: signal === 'drift' || signal === 'underspecified_soul' ? signal : null,
        lowStreak: typeof obj.lowStreak === 'number' ? obj.lowStreak : 0,
        ...(typeof obj.at === 'string' ? { at: obj.at } : {}),
        ...(perDimension && perDimension.length > 0 ? { perDimension } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Read the latest nightly-pass status from
   * `<dataDir>/personalities/<id>/.nightly-state.json`. Tolerant — a missing
   * file, malformed JSON, or an unexpected shape returns null (the `nightly`
   * block is then omitted). Never throws; never `as`-casts the untrusted JSON
   * (validates field-by-field, mirroring `readNightlyState` in @ethosagent/digest).
   */
  private async readNightly(id: string): Promise<NightlyWire | null> {
    const { storage, dataDir } = this.opts;
    if (!storage || !dataDir) return null;
    const path = join(dataDir, 'personalities', id, '.nightly-state.json');
    const raw = await storage.read(path);
    if (!raw) return null;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return null;
      const obj = parsed as Record<string, unknown>;
      const windowEnd = obj.windowEnd;
      const completed = obj.completed;
      if (typeof windowEnd !== 'string' || !Array.isArray(completed)) return null;
      const steps: string[] = [];
      for (const c of completed) {
        if (typeof c !== 'string') return null;
        steps.push(c);
      }
      return { windowEnd, completed: steps };
    } catch {
      return null;
    }
  }

  async proposeExpression(id: string): Promise<{
    currentExpression: string;
    newExpression: string;
    rationale: string;
    evidence: string;
  }> {
    if (!this.opts.llm) throw llmNotConfigured();
    const evidence = await this.gatherEvidence(id);
    const soul = await this.opts.personalities.readLivingSoul(id);
    const llm = await this.opts.llm();
    const draft = await draftExpressionUpdate(
      { core: soul.core, currentExpression: soul.expression, evidence },
      llm,
    );
    return {
      currentExpression: soul.expression,
      newExpression: draft.newExpression,
      rationale: draft.rationale,
      evidence,
    };
  }

  async applyExpression(
    id: string,
    newExpression: string,
    summary: string,
    evidenceRef: string,
  ): Promise<{ revisionId: string }> {
    const { entry } = await this.opts.personalities.evolveExpression(id, newExpression, {
      summary,
      evidenceRef,
    });
    return { revisionId: entry.revisionId };
  }

  async revertExpression(id: string): Promise<{ ok: true; revertedTo: string }> {
    const soul = await this.opts.personalities.readLivingSoul(id);
    if (soul.learningLog.length === 0) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'Nothing to revert',
        action: 'Evolve the Expression at least once before reverting.',
      });
    }
    const last = soul.learningLog[soul.learningLog.length - 1];
    if (!last) {
      throw new EthosError({
        code: 'INVALID_INPUT',
        cause: 'Nothing to revert',
        action: 'Evolve the Expression at least once before reverting.',
      });
    }
    await this.opts.personalities.revertExpression(id, last.prevExpressionRef);
    return { ok: true, revertedTo: last.prevExpressionRef };
  }

  async proposeSoulSplit(
    soulMd: string,
  ): Promise<{ core: string; expression: string; rationale: string }> {
    if (!this.opts.llm) throw llmNotConfigured();
    const llm = await this.opts.llm();
    return draftSoulSplit(soulMd, llm);
  }

  /**
   * Build a newest-first digest of recent session interactions for a
   * personality, capped at 20 messages / 4000 chars. Mirrors the CLI's
   * `ethos personality evolve` evidence logic. Returns '' when no session
   * store is wired.
   */
  private async gatherEvidence(id: string): Promise<string> {
    const store = this.opts.sessions;
    if (!store) return '';
    let sessions = await store.listSessions({ personalityId: id });
    if (sessions.length === 0) sessions = await store.listSessions();
    if (sessions.length === 0) return '';
    sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());

    const MAX_MSGS = 20;
    const MAX_CHARS = 4000;
    const digestLines: string[] = [];
    let totalChars = 0;
    let capped = false;
    for (const s of sessions) {
      if (capped) break;
      const msgs = await store.getMessages(s.id, { limit: 20 });
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i];
        if (!m) continue;
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const line = `${m.role}: ${oneLine(m.content)}`;
        if (digestLines.length >= MAX_MSGS || totalChars + line.length > MAX_CHARS) {
          digestLines.push('… [evidence truncated]');
          capped = true;
          break;
        }
        digestLines.push(line);
        totalChars += line.length;
      }
    }
    return digestLines.join('\n');
  }

  private requirePersonality(id: string): void {
    if (!this.opts.personalities.describe(id)) {
      throw new EthosError({
        code: 'PERSONALITY_NOT_FOUND',
        cause: `Personality "${id}" not found.`,
        action: 'Use personalities.list to see available ids.',
      });
    }
  }
}

function toWirePersonalitySkill(record: PersonalitySkillRecord): PersonalitySkill {
  return {
    id: record.id,
    name: record.name,
    description: record.description,
    body: record.body,
    modifiedAt: record.modifiedAt,
  };
}

function toWire(d: DescribedPersonality): Personality {
  const c = d.config;
  return {
    id: c.id,
    name: c.name,
    description: c.description ?? null,
    model: c.model ?? null,
    provider: c.provider ?? null,
    toolset: c.toolset ?? null,
    capabilities: c.capabilities ?? null,
    streamingTimeoutMs: c.streamingTimeoutMs ?? null,
    mcp_servers: c.mcp_servers ?? null,
    plugins: c.plugins ?? null,
    fs_reach: c.fs_reach
      ? { read: c.fs_reach.read ?? null, write: c.fs_reach.write ?? null }
      : null,
    ...(c.dreaming
      ? {
          dreaming: {
            enable: c.dreaming.enable,
            idleMinutes: c.dreaming.idleMinutes,
            maxPerDay: c.dreaming.maxPerDay,
          },
        }
      : {}),
    ...(c.evolution_approval_mode !== undefined
      ? { evolution_approval_mode: c.evolution_approval_mode }
      : {}),
    ...(c.skill_evolution !== undefined ? { skill_evolution: c.skill_evolution } : {}),
    ...(c.safety?.approvalMode !== undefined
      ? { safety: { approvalMode: c.safety.approvalMode } }
      : {}),
    ...(c.memory?.provider !== undefined ? { memory: { provider: c.memory.provider } } : {}),
    ...(c.nightly !== undefined ? { nightly: c.nightly } : {}),
    system: d.builtin && SYSTEM_PERSONALITY_IDS.has(c.id),
    builtin: d.builtin,
    version: 1,
  };
}

function oneLine(content: string): string {
  const collapsed = content.replace(/\s+/g, ' ').trim();
  return collapsed.length > 400 ? `${collapsed.slice(0, 400)}…` : collapsed;
}

function llmNotConfigured(): EthosError {
  return new EthosError({
    code: 'NOT_CONFIGURED',
    cause: 'LLM not configured for this server',
    action: 'Start the server with a provider configured in ~/.ethos/config.yaml.',
  });
}

function storageNotConfigured(): EthosError {
  return new EthosError({
    code: 'NOT_CONFIGURED',
    cause: 'Storage not configured for this server',
    action: 'Start the server with a data dir + storage wired in.',
  });
}

function candidateNotFound(personalityId: string, fileName: string): EthosError {
  return new EthosError({
    code: 'SKILL_NOT_FOUND',
    cause: `Skill candidate "${fileName}" not found for personality "${personalityId}".`,
    action: 'Use personalities.skillCandidatesList to see pending candidates.',
  });
}

function notFound(id: string): EthosError {
  return new EthosError({
    code: 'PERSONALITY_NOT_FOUND',
    cause: `Personality "${id}" not found`,
    action: 'Call `personalities.list` to see available IDs.',
  });
}
