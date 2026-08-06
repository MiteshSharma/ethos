import type { AgentEvent, ModelTierName, ToolFilterOpts } from '@ethosagent/types';
import { parseSmallWindowToolset } from '../small-window-toolset';
import type { LoopDeps, TurnSetupResult } from '../turn-context';
import { resolveModelWithTier } from '../turn-context';

/**
 * Turn-setup stage: session resolve/create, personality, trace, budget-cap
 * check, turn counter, tier resolution, run_start event, tool filters,
 * session_start hook, credential gate.
 *
 * Yields AgentEvent while running; returns TurnSetupResult.
 */
export async function* setupTurn(
  deps: LoopDeps,
  text: string,
  opts: {
    sessionKey?: string;
    personalityId?: string;
    abortSignal?: AbortSignal;
    tierOverride?: ModelTierName;
    toolsetOverride?: string[];
    toolsetNarrow?: string[];
  },
): AsyncGenerator<AgentEvent, TurnSetupResult> {
  const sessionKey = opts.sessionKey ?? `${deps.platform}:default`;

  // Step 1: Resolve or create session
  const ethosSession =
    (await deps.session.getSessionByKey(sessionKey)) ??
    (await deps.session.createSession({
      key: sessionKey,
      platform: deps.platform,
      model: deps.llm.model,
      provider: deps.llm.name,
      personalityId: opts.personalityId,
      workingDir: deps.workingDir,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        estimatedCostUsd: 0,
        apiCallCount: 0,
        compactionCount: 0,
      },
    }));

  const sessionId = ethosSession.id;
  const personality =
    (opts.personalityId ? deps.personalities.get(opts.personalityId) : null) ??
    deps.personalities.getDefault();

  const obsConfig = personality?.safety?.observability;

  const traceId = deps.observability?.startTurnTrace({
    sessionId,
    personalityId: personality?.id,
    obsConfig,
  });

  // Budget cap check — refuse before any LLM work when the session has already
  // exceeded the personality's per-session spending limit.
  const currentSpend = deps.sessionCosts.get(sessionKey) ?? 0;
  if (personality.budgetCapUsd != null && currentSpend >= personality.budgetCapUsd) {
    if (traceId) deps.observability?.endTrace(traceId, 'error');
    deps.observability?.flush();
    yield {
      type: 'error',
      error: `Budget cap of $${personality.budgetCapUsd.toFixed(2)} exceeded for this session ($${currentSpend.toFixed(4)} spent). Use /budget reset to start a new budget window.`,
      code: 'BUDGET_EXCEEDED',
    };
    yield { type: 'done', text: '', turnCount: 0 };
    return { kind: 'refused' };
  }

  // Q2 — advance the per-session turn counter. `turnNumber` drives the
  // anti-thrashing compaction cooldown; `lastCompactionTurn` is the turn the
  // previous compaction fired (0 = never).
  const { turnNumber, lastCompactionTurn } = await deps.session.recordTurnStart(sessionId);

  // Resolve effective model with tier support.
  // Priority: modelRouting[id] > personality tier config > llm.model.
  // User tier override (from /tier command via RunOptions) applies for this entire turn.
  const turnTierOverride = opts.tierOverride;
  if (turnTierOverride) {
    deps.observability?.recordTierOverride({
      traceId: traceId ?? '',
      actor: 'user',
      tier: turnTierOverride,
      personalityId: personality.id,
    });
  }

  const activeTier = turnTierOverride ?? 'default';
  const { model: effectiveModel, source: modelSource } = resolveModelWithTier(
    personality,
    activeTier,
    deps.modelRouting,
    deps.llm.name,
    deps.llm.model,
  );
  const modelOverride = effectiveModel !== deps.llm.model ? effectiveModel : undefined;

  // Phase 5: emit run_start trace so consumers (TUI, CLI verbose, telemetry)
  // can surface the resolved provider/model and routing source.
  yield {
    type: 'run_start',
    provider: deps.llm.name,
    model: effectiveModel,
    source: modelSource,
  };

  // Allowed tool names for this personality (undefined = no restriction)
  const baseToolset = opts.toolsetOverride ?? personality.toolset ?? undefined;
  const narrow = opts.toolsetNarrow;
  let allowedTools =
    narrow && baseToolset ? baseToolset.filter((t) => narrow.includes(t)) : (narrow ?? baseToolset);

  // Lane 3(b) / D20 — declared small-window toolset narrowing. When wiring
  // resolved small-window mode AND this turn's personality declares
  // `context_engine_options.small_window_toolset`, the effective toolset is
  // the declared set (intersected — a declaration can never escalate beyond
  // the allowlist computed above). `allowedTools` gates BOTH toDefinitions()
  // and executeParallel downstream, so a narrowed-out tool is rejected exactly
  // like a disallowed one. Static per loop + personality — never per turn —
  // so the tool payload in the request prefix stays byte-stable.
  if (deps.smallWindow) {
    const declared = parseSmallWindowToolset(
      personality.context_engine_options?.small_window_toolset,
    );
    if (declared) {
      allowedTools = allowedTools ? allowedTools.filter((t) => declared.includes(t)) : declared;
    }
  }
  // Per-personality plugin + MCP gate (default-deny: missing field = no access)
  const allowedPlugins = personality.plugins ?? [];

  // Build per-tool MCP allowlist from mcp.yaml policy (if present).
  const mcpServers = deps.mcpPolicy?.servers;
  const allowedMcpTools: Record<string, string[]> | undefined = mcpServers
    ? Object.fromEntries(
        Object.entries(mcpServers)
          .filter(([, v]) => v.tools !== undefined || v.enabled === false)
          .map(([k, v]) => {
            if (v.enabled === false) return [k, []];
            const tools = v.tools;
            return [k, tools ?? []];
          }),
      )
    : undefined;

  const filterOpts: ToolFilterOpts = {
    allowedMcpServers: personality.mcp_servers ?? [],
    allowedPlugins,
    ...(allowedMcpTools && Object.keys(allowedMcpTools).length > 0 ? { allowedMcpTools } : {}),
  };

  // Step 2: Fire session_start hooks
  await deps.hooks.fireVoid(
    'session_start',
    {
      sessionId,
      sessionKey,
      platform: deps.platform,
      personalityId: personality.id,
    },
    allowedPlugins,
  );

  // v2.2: Pre-turn credential check — surface a credential_required event
  // before the LLM call so the host can prompt the user for auth.
  if (deps.credentialCheck) {
    const missing = await deps.credentialCheck(sessionKey, text);
    if (missing) {
      if (traceId) deps.observability?.endTrace(traceId, 'error');
      deps.observability?.flush();
      yield {
        type: 'credential_required',
        pluginId: missing.pluginId,
        credentialKey: missing.credentialKey,
        kind: missing.kind,
        label: missing.label,
        description: missing.description,
        authUrl: missing.authUrl,
        sessionKey,
        pendingUserMessage: text,
      };
      yield { type: 'done', text: '', turnCount: 0 };
      return { kind: 'refused' };
    }
  }

  const memScopeId = `personality:${personality.id}`;

  return {
    kind: 'ready',
    setup: {
      sessionId,
      sessionKey,
      personality,
      obsConfig,
      traceId,
      turnNumber,
      lastCompactionTurn,
      activeTier,
      effectiveModel,
      modelOverride,
      allowedTools,
      allowedPlugins,
      filterOpts,
      memScopeId,
    },
  };
}
