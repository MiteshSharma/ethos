import type { AgentEvent, Attachment, MemoryContext, PromptContext } from '@ethosagent/types';
import { buildAttachmentAnnotation } from '../../attachment-annotation';
import { classifyAttachment, unsupportedTypeError } from '../../attachment-classifier';
import {
  formatInlinedAttachment,
  resolveTextAttachment,
  sanitizeFilename,
} from '../../attachment-text-resolver';
import { estimateMessagesTokens, estimateTokens } from '../../context-engines/token-estimator';
import { buildVoiceOriginAnnotation } from '../../voice-origin';
import { maybeCompact } from '../compaction';
import { skillCallsFromMessages, usesSkillIndexMode } from '../ghost-skills';
import { dedupHistory, toLLMMessages } from '../history';
import {
  COMPACTION_TAIL_KEEP,
  computeKeptTailBoundary,
  reconstructFromWatermark,
  selectActiveWatermark,
} from '../manual-compact';
import { applyMicroToView } from '../micro-compaction';
import { loadMicroState } from '../micro-state';
import {
  type AgingState,
  advanceAgingState,
  applyAgingToView,
  DEFAULT_AGING_STATE,
} from '../tool-result-aging';
import type { AssembledContext, LoopDeps, TurnSetup } from '../turn-context';

// Phase 1a — aging state is persisted per session so the batched-at-crossings
// invariant survives across turns. Best-effort: any storage error degrades to
// the default (no aging) rather than breaking the turn.
function agingStatePath(dataDir: string, sessionId: string): string {
  return `${dataDir}/aging/${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
}

function parseAgingState(raw: string): AgingState {
  try {
    const v = JSON.parse(raw) as Partial<AgingState>;
    const level = v.level === 'soft' || v.level === 'hard' ? v.level : 'none';
    const soft = Array.isArray(v.soft)
      ? v.soft.filter((s): s is string => typeof s === 'string')
      : [];
    const hard = Array.isArray(v.hard)
      ? v.hard.filter((s): s is string => typeof s === 'string')
      : [];
    return { level, soft, hard };
  } catch {
    return DEFAULT_AGING_STATE;
  }
}

async function loadAgingState(
  storage: LoopDeps['storage'],
  dataDir: string | undefined,
  sessionId: string,
): Promise<AgingState> {
  if (!storage || !dataDir) return DEFAULT_AGING_STATE;
  try {
    const raw = await storage.read(agingStatePath(dataDir, sessionId));
    return raw ? parseAgingState(raw) : DEFAULT_AGING_STATE;
  } catch {
    return DEFAULT_AGING_STATE;
  }
}

async function saveAgingState(
  storage: LoopDeps['storage'],
  dataDir: string | undefined,
  sessionId: string,
  state: AgingState,
): Promise<void> {
  if (!storage || !dataDir) return;
  try {
    await storage.mkdir(`${dataDir}/aging`);
    await storage.writeAtomic(agingStatePath(dataDir, sessionId), JSON.stringify(state));
  } catch {
    // Best-effort — a persistence miss just re-derives the state next turn.
  }
}

/**
 * Context-assembly stage: PII redaction, user message persistence, history
 * load, memory prefetch + sanitize, system prompt build (injectors, memory,
 * hooks, dry-run), context_meta event, history-to-LLM messages, compaction.
 *
 * Yields AgentEvent while running; returns AssembledContext.
 */
export async function* assembleContext(
  deps: LoopDeps,
  setup: TurnSetup,
  text: string,
  opts: {
    attachments?: Attachment[];
    userId?: string;
    dryRun?: boolean;
    /** T3 — max output tokens for the pending completion; reserved from the
     *  context window by compaction so the response can't overflow. */
    maxCompletionTokens?: number;
    /** Set when this turn's text is a transcript of speech. Rendered as a
     *  message-level annotation on the persisted user message. */
    voiceOrigin?: import('@ethosagent/types').VoiceTurnOrigin;
  },
): AsyncGenerator<AgentEvent, AssembledContext> {
  const {
    sessionId,
    sessionKey,
    personality,
    // The turn's workdir (see TurnSetup.workingDir). Assembly must read the
    // same value the tool contexts do, so `AGENTS.md`/`CLAUDE.md` discovery and
    // the injectors agree with where the agent's writes actually land.
    workingDir,
    turnNumber,
    lastCompactionTurn,
    allowedPlugins,
    memScopeId,
    traceId,
  } = setup;

  // Step 3: Persist the user message.
  //
  // Subagent task contract: the delegated task always lives in the child's
  // first user message (this `text`). It is NEVER copied into the system
  // prompt, NEVER injected via memory, and NEVER duplicated across both.
  // The regression test in
  // `extensions/tools-delegation/src/__tests__/task-contract.test.ts`
  // captures every `LLMProvider.complete()` request and asserts the marker
  // never appears in `opts.system` and appears exactly once across all
  // user-role messages.
  //
  // Attachment annotation: prepend an <attachments> block so the LLM sees
  // which files/images the user attached. Persisted with the message so
  // replay is faithful (plan risk #10).
  const piiConfig = personality.safety?.piiRedaction;

  // Classify and resolve text attachments
  const rawAttachments = opts.attachments ?? [];
  const inlineBlocks: string[] = [];
  const annotatedAttachments: Attachment[] = [];
  const attachmentErrors: string[] = [];

  for (const att of rawAttachments) {
    const cls = classifyAttachment(att);
    switch (cls) {
      case 'native':
        // Class A -- keep for annotation, existing vision path handles these
        annotatedAttachments.push(att);
        break;
      case 'text': {
        // Class B-text -- read, decode, inline
        try {
          const resolved = await resolveTextAttachment(att, deps.storage, deps.attachmentCache);
          // S6 -- inbound injection scan on inlined text
          const sanitized = deps.safety.injection.sanitize(resolved.text);
          const formatted = formatInlinedAttachment({
            ...resolved,
            text: sanitized,
          });
          inlineBlocks.push(formatted);
        } catch {
          attachmentErrors.push(
            `Failed to read "${att.filename ?? att.mimeType}": file could not be decoded as text`,
          );
        }
        break;
      }
      case 'extract': {
        const registry = deps.documentExtractors;
        const extractor = registry?.for(att.mimeType.toLowerCase());
        if (!extractor) {
          annotatedAttachments.push(att);
          break;
        }
        try {
          let fileBytes: Uint8Array;
          if (att.url.startsWith('file://') && deps.attachmentCache && deps.storage) {
            const localPath = deps.attachmentCache.resolveLocalPath(att.url);
            const raw = await deps.storage.readBytes(localPath);
            if (!raw) throw new Error('File not found');
            fileBytes = raw;
          } else if (att.url.startsWith('data:')) {
            const commaIdx = att.url.indexOf(',');
            if (commaIdx < 0) throw new Error('Invalid data: URL');
            fileBytes = Uint8Array.from(Buffer.from(att.url.slice(commaIdx + 1), 'base64'));
          } else {
            throw new Error('Unsupported URL scheme');
          }
          if (extractor.maxInputBytes && fileBytes.length > extractor.maxInputBytes) {
            attachmentErrors.push(
              `"${att.filename ?? att.mimeType}" is too large for extraction (${(fileBytes.length / (1024 * 1024)).toFixed(1)} MB, max ${(extractor.maxInputBytes / (1024 * 1024)).toFixed(0)} MB)`,
            );
            break;
          }
          const extracted = await extractor.extract(fileBytes, att.mimeType);
          const sanitized = deps.safety.injection.sanitize(extracted.text);
          const name = sanitizeFilename(att.filename ?? 'unnamed');
          const truncNote = extracted.truncatedFromChars
            ? ` [truncated to ${sanitized.length.toLocaleString('en-US')} chars from ${extracted.truncatedFromChars.toLocaleString('en-US')}]`
            : '';
          inlineBlocks.push(`=== file: ${name}${truncNote} ===\n${sanitized}\n=== end file ===`);
        } catch {
          attachmentErrors.push(`Failed to extract text from "${att.filename ?? att.mimeType}"`);
        }
        break;
      }
      case 'unsupported':
        attachmentErrors.push(unsupportedTypeError(att.mimeType, att.filename));
        break;
    }
  }

  // Build annotation only for Class A + Class B-extract attachments
  const attachmentAnnotation = buildAttachmentAnnotation(annotatedAttachments);

  // Build inline prefix: errors first (so user sees them), then inlined file content
  // Aggregate inline budget — cap total inlined text to prevent prompt explosion
  const INLINE_BUDGET_CHARS = 100_000;
  let totalInlinedChars = 0;
  const budgetedBlocks: string[] = [];
  for (const block of inlineBlocks) {
    totalInlinedChars += block.length;
    if (totalInlinedChars > INLINE_BUDGET_CHARS) {
      const remaining = inlineBlocks.length - budgetedBlocks.length;
      budgetedBlocks.push(`[${remaining} more file(s) omitted — inline budget exceeded]`);
      break;
    }
    budgetedBlocks.push(block);
  }

  const inlinePrefix = [...attachmentErrors, ...budgetedBlocks].join('\n\n');

  // Voice-origin annotation (voice V1a, eng-review D16). It sits BESIDE the
  // attachment annotation, never in place of it: the audio marker and the
  // transcript both survive on the same message, which is the whole point —
  // a transcript that replaces the media marker is how the model forgets it is
  // in a voice conversation and answers with a markdown table.
  //
  // It is on the MESSAGE, not in the system prompt. A session mixes typed and
  // spoken turns, so a per-turn system section would break the byte-identical
  // static prefix (`__tests__/prompt-prefix-stability.test.ts`).
  const voiceOriginAnnotation = opts.voiceOrigin
    ? buildVoiceOriginAnnotation(opts.voiceOrigin)
    : '';

  const fullPrefix = [attachmentAnnotation, voiceOriginAnnotation, inlinePrefix]
    .filter(Boolean)
    .join('\n\n');
  const rawAnnotatedText = fullPrefix ? `${fullPrefix}\n\n${text}` : text;
  const annotatedText = piiConfig?.enabled
    ? deps.safety.redaction.redactPii(rawAnnotatedText, piiConfig.extraPatterns)
    : rawAnnotatedText;

  await deps.session.appendMessage({
    sessionId,
    role: 'user',
    content: annotatedText,
    traceId,
  });

  // Step 4: Load history (trimmed to most-recent limit)
  const allMessages = await deps.session.getMessages(sessionId, { limit: deps.historyLimit });
  const history = allMessages.filter((m) => m.role !== 'system');

  // Phase 2 — compaction watermark read-back. When a prior compaction persisted
  // a boundary, reconstruct the LLM-facing history from it (summary + verbatim
  // tail) instead of shipping the raw prefix again. This is what makes the
  // cooldown ship the COMPACTED view and `/compact` durable across turns. The
  // raw `history` still drives injectors/hooks; only the LLM view is compacted.
  //
  // Item 7 — ghost-skill defense. In `skills.injection_mode: 'index'` (the
  // default) a skill's BODY arrives as a `get_skill` tool_result in the message
  // array while only a stub sits in the prompt, so every pruner below can strip
  // the instructions and leave the advertisement. Under `'full'` the body is in
  // the static prefix and no pruner touches it — the markers are gated off.
  const skillMarkers = usesSkillIndexMode(personality.skills?.injection_mode);
  const ghostOpts = skillMarkers ? { skillMarkers: true } : undefined;
  const activeWatermark = selectActiveWatermark(await deps.session.listCompressions(sessionId));
  const reconstructed = activeWatermark
    ? reconstructFromWatermark(history, activeWatermark, ghostOpts)
    : { history, applied: false };
  const replayHistory = reconstructed.history;
  const watermarkApplied = reconstructed.applied;

  // Step 5: Prefetch memory.
  //
  // Per-personality memory backend: if the personality declares a `memory.provider`,
  // resolve it from the registry. Otherwise fall back to the global provider.
  const activeMemory = personality.memory?.provider
    ? ((await deps.memoryProviders.get(personality.memory.provider)?.(
        personality.memory.options,
      )) ?? deps.memory)
    : deps.memory;

  const memCtx: MemoryContext = {
    scopeId: memScopeId,
    sessionId,
    sessionKey,
    platform: deps.platform,
    workingDir,
  };
  let memSnapshot = await activeMemory.prefetch(memCtx);

  // Providers that don't support bulk prefetch (e.g. VectorMemoryProvider)
  // return null. Fall back to a semantic search on the current user text so
  // those backends still inject relevant context into the system prompt —
  // restoring the query-driven retrieval the old two-method contract did
  // internally inside prefetch().
  if (!memSnapshot && text.trim()) {
    const hits = await activeMemory.search(text, memCtx, { limit: 5 });
    if (hits.length > 0) {
      memSnapshot = { entries: hits.map((h) => ({ key: h.key, content: h.content })) };
    }
  }

  // Per-user profile prefetch
  const userScopeId = opts.userId ? `user:${opts.userId}` : undefined;
  if (userScopeId) {
    const userCtx: MemoryContext = {
      scopeId: userScopeId,
      sessionId,
      sessionKey,
      platform: deps.platform,
      workingDir,
    };
    const userEntry = await activeMemory.read('USER.md', userCtx);
    if (userEntry?.content.trim()) {
      const userSnapshot = {
        entries: [{ key: 'USER.md', content: userEntry.content }],
      };
      if (memSnapshot) {
        // Phase 1b — USER.md double-injection fix. The personality-scope
        // prefetch above may ALSO have returned a USER.md entry; the user-scope
        // read is the canonical per-user profile, so drop the prefetched copy
        // and keep exactly one "About You" block in the built prompt.
        const withoutUser = memSnapshot.entries.filter((e) => e.key !== 'USER.md');
        memSnapshot = { entries: [...userSnapshot.entries, ...withoutUser] };
      } else {
        memSnapshot = userSnapshot;
      }
    }
  }

  // Backstop: sanitize memory content for prompt-injection patterns before
  // injecting into the system prompt (same defense context files get).
  if (memSnapshot) {
    memSnapshot = {
      entries: memSnapshot.entries.map((e) => ({
        key: e.key,
        content: deps.safety.injection.sanitize(e.content),
      })),
    };
  }

  // Step 6: Build system prompt from injectors
  const promptCtx: PromptContext = {
    sessionId,
    sessionKey,
    platform: deps.platform,
    model: deps.llm.model,
    history,
    workingDir,
    isDm: true,
    turnNumber: allMessages.length,
    personalityId: personality.id,
    // Phase 4 — small-window mode forces skills into index form. Derived from
    // static inputs (resolved once at wiring), constant across turns.
    ...(deps.promptBudget?.skillsIndexMode ? { skillsIndexMode: true } : {}),
  };

  const systemParts: string[] = [];

  // Ch.3a — prepend the injection-defense prelude so the model knows how to
  // read `<untrusted>` blocks before any personality content sets the tone.
  // §V S6: unconditional — no personality, channel, or tool can opt out.
  // §2 — a lean model's `promptBudget.compactPrelude` swaps in the short
  // prelude variant; fall back to the full prelude when none is wired.
  systemParts.push(
    deps.promptBudget?.compactPrelude
      ? (deps.safety.injection.preludeCompact ?? deps.safety.injection.prelude)
      : deps.safety.injection.prelude,
  );

  // SOUL.md / personality identity — routes through Storage so ScopedStorage
  // and InMemoryStorage fixtures work correctly. Only runs when storage is
  // wired (production always provides it; tests without a real soulFile skip).
  if (personality.soulFile && deps.storage) {
    const identity = await deps.storage.read(personality.soulFile);
    if (identity) systemParts.push(identity.trim());
  }

  // Context injectors sorted by priority (already sorted in constructor)
  for (const injector of deps.injectors) {
    // §2 — a lean model's `promptBudget.suppressMemoryGuidance` drops the
    // memory-usage guidance block (the MemoryGuidanceInjector).
    if (deps.promptBudget?.suppressMemoryGuidance && injector.id === 'memory-guidance') continue;
    // Plugin-registered injectors only fire when the plugin is permitted.
    const injPluginId = deps.injectorPluginIds.get(injector);
    if (injPluginId !== undefined && !allowedPlugins.includes(injPluginId)) continue;
    if (injector.shouldInject && !injector.shouldInject(promptCtx)) continue;
    const result = await injector.inject(promptCtx);
    if (result) {
      if (result.position === 'prepend') {
        systemParts.unshift(result.content);
      } else {
        systemParts.push(result.content);
      }
    }
  }

  // Emit injector metadata (e.g. skill_files_used) so eval harness can capture it.
  if (promptCtx.meta && Object.keys(promptCtx.meta).length > 0) {
    yield { type: 'context_meta', data: promptCtx.meta };
  }
  const rawSkills = promptCtx.meta?.skillFilesUsed;
  const activeSkillFiles =
    Array.isArray(rawSkills) && rawSkills.every((s) => typeof s === 'string')
      ? (rawSkills as string[])
      : undefined;

  // Memory injected last, as context about the user. The snapshot is a
  // list of (key, content) pairs; render USER.md as "About You" first,
  // MEMORY.md as "Memory" second, anything else as its own section.
  //
  // Hard cap on the total memory block at 20k chars — same budget the
  // old MarkdownFileMemoryProvider enforced internally. Without this,
  // a long-running session's MEMORY.md grows unbounded and silently
  // explodes the system prompt token bill.
  if (memSnapshot && memSnapshot.entries.length > 0 && deps.promptBudget?.memoryIndexMode) {
    // Phase 4 small-window — index-not-content. Only the names of the stored
    // memory notes ship in the prompt; the agent loads their content on demand
    // via `memory_read`. Mirrors the team-memory index injector pattern. The
    // index is byte-stable across turns while the key set is unchanged, so
    // prefix caching still holds; the (large) content stays out of the prompt.
    const labels: Record<string, string> = { 'USER.md': 'About You', 'MEMORY.md': 'Memory' };
    const names = [...memSnapshot.entries]
      .filter((e) => e.content.trim().length > 0)
      .sort((a, b) => {
        const rank = (k: string) => (k === 'USER.md' ? 0 : k === 'MEMORY.md' ? 1 : 2);
        return rank(a.key) - rank(b.key);
      })
      .map((e) => `- ${labels[e.key] ?? e.key} (\`${e.key}\`)`);
    if (names.length > 0) {
      systemParts.push(
        `## Memory\n\nStored notes are available on demand — call \`memory_read\` to load them:\n${names.join('\n')}`,
      );
    }
  } else if (memSnapshot && memSnapshot.entries.length > 0) {
    const blocks: string[] = [];
    const orderHints: Record<string, string> = {
      'USER.md': 'About You',
      'MEMORY.md': 'Memory',
    };
    const sorted = [...memSnapshot.entries].sort((a, b) => {
      const rank = (k: string) => (k === 'USER.md' ? 0 : k === 'MEMORY.md' ? 1 : 2);
      return rank(a.key) - rank(b.key);
    });
    for (const e of sorted) {
      const heading = orderHints[e.key] ?? e.key;
      const redact = deps.safety.redaction.redactString;
      blocks.push(`## ${heading}\n\n${redact(e.content.trim())}`);
    }
    if (blocks.length > 0) {
      let rendered = `## Memory\n\n${blocks.join('\n\n')}`;
      // §2 — a lean model's `promptBudget.memorySnapshotCap` overrides the
      // default 20k char cap on the memory block.
      const MEMORY_MAX_CHARS = deps.promptBudget?.memorySnapshotCap ?? 20_000;
      if (rendered.length > MEMORY_MAX_CHARS) {
        // Tail-keep — newer memory lives at the end; the prelude carries
        // less per-token signal than the freshest facts.
        rendered = `[...truncated]\n\n${rendered.slice(-MEMORY_MAX_CHARS)}`;
      }
      systemParts.push(rendered);
    }
  }

  // Step 7: Before-prompt-build modifying hooks (plugins can prepend/append/override)
  const buildResult = await deps.hooks.fireModifying(
    'before_prompt_build',
    {
      sessionId,
      personalityId: personality.id,
      history,
    },
    allowedPlugins,
  );

  if (buildResult.overrideSystem) {
    systemParts.length = 0;
    systemParts.push(buildResult.overrideSystem);
  } else {
    if (buildResult.prependSystem) systemParts.unshift(buildResult.prependSystem);
    if (buildResult.appendSystem) systemParts.push(buildResult.appendSystem);
  }

  if (opts.dryRun) {
    systemParts.push(
      'IMPORTANT: You are in DRY-RUN mode. Every tool call will be intercepted and return a stub ' +
        'result — no tool actually executes. Plan your tool calls as normal but do NOT retry or ' +
        'loop when you see "[dry-run]" in the result. After your first batch of tool calls, ' +
        'summarize what you would have done and stop.',
    );
  }

  const systemPrompt = systemParts.join('\n\n').trim() || undefined;

  // Step 8: Agentic loop — LLM call → tool use → LLM call → ...
  // Q1 — collapse exact-duplicate tool results before building the
  // LLM-facing history, so re-reads of the same file don't burn tokens.
  // `replayHistory` carries any active compaction watermark (summary + tail).
  let llmMessages = toLLMMessages(dedupHistory(replayHistory, ghostOpts));
  // Phase 1c — actuals-first gate signal. The most recent assistant turn's
  // real input tokens (+ measured static sections system+tools) were persisted
  // by Phase 0; prefer them over the chars/4 estimate. Absent on the first
  // turn → the gate falls back to the estimator.
  let lastActualInputTokens: number | undefined;
  let staticTokens: number | undefined;
  for (let i = allMessages.length - 1; i >= 0; i--) {
    const m = allMessages[i];
    if (m?.role === 'assistant' && m.usage?.inputTokens) {
      lastActualInputTokens = m.usage.inputTokens;
      const rt = m.usage.requestTokens;
      if (rt) staticTokens = rt.system + rt.tools;
      break;
    }
  }
  // Phase 1a — tool-result aging (assembled view only). Recompute the aged set
  // ONLY when context pressure crosses 0.3 / 0.5; between crossings the persisted
  // state is reused so the aged prefix stays byte-identical (cache holds).
  let agingCacheBreakpoint: number | undefined;
  {
    const window = deps.llm.maxContextTokens || 200_000;
    const prevState = await loadAgingState(deps.storage, deps.dataDir, sessionId);
    const usageEstimate =
      lastActualInputTokens ??
      estimateTokens(systemPrompt ?? '') + estimateMessagesTokens(llmMessages);
    const ratio = window > 0 ? usageEstimate / window : 0;
    const advanced = advanceAgingState(prevState, llmMessages, ratio);
    if (advanced.changed) {
      await saveAgingState(deps.storage, deps.dataDir, sessionId, advanced.state);
    }
    // Item 7 — micro-compaction is applied FIRST, then aging on top. Both are
    // content-only rewrites of the same tool_result blocks, and aging's soft
    // trim is a no-op on content it cannot shrink further, so the order is
    // stable and the composition is idempotent. The state itself was advanced
    // and persisted at the previous turn's end (agent-loop/turn-complete.ts);
    // assembly only READS it, so nothing here varies within a turn.
    const skillNames = skillMarkers ? skillCallsFromMessages(llmMessages) : undefined;
    const rewriteOpts = skillNames?.size ? { skillNames } : undefined;
    const micro = applyMicroToView(
      llmMessages,
      await loadMicroState(deps.storage, deps.dataDir, sessionId),
      rewriteOpts,
    );
    const aged = applyAgingToView(micro.messages, advanced.state, rewriteOpts);
    llmMessages = aged.messages;
    agingCacheBreakpoint = Math.max(aged.cacheBreakpoint ?? -1, micro.cacheBreakpoint ?? -1);
    if (agingCacheBreakpoint < 0) agingCacheBreakpoint = undefined;
  }
  // E4 — pre-LLM compaction. If estimated context usage already exceeds
  // the personality's pressure threshold (80% of the model's window by
  // default), the resolved context engine compacts before we hand the
  // history to the provider.
  //
  // Phase 2 — when the auto gate fires, persist a watermark boundary so the
  // compaction survives into later turns (and the cooldown ships the compacted
  // view, not raw history). The boundary keeps the newest stored messages of the
  // replay history verbatim; older messages are represented by the summary.
  // Item 7 — the boundary also guarantees N verbatim USER messages in the tail.
  const autoBoundary = computeKeptTailBoundary(
    replayHistory,
    COMPACTION_TAIL_KEEP,
    deps.compaction?.minTailUserMessages,
  );
  const compacted = await maybeCompact(
    {
      llm: deps.llm,
      contextEngines: deps.contextEngines,
      session: deps.session,
      observability: deps.observability,
      llmHandle: deps.llmHandle,
      storage: deps.storage,
      dataDir: deps.dataDir,
      countTokens: deps.llm.countTokens.bind(deps.llm),
      ...(opts.maxCompletionTokens !== undefined
        ? { reservedOutputTokens: opts.maxCompletionTokens }
        : {}),
      ...(deps.compaction?.pressure !== undefined ? { pressure: deps.compaction.pressure } : {}),
      ...(deps.compaction?.target !== undefined ? { target: deps.compaction.target } : {}),
      ...(deps.compaction?.charsPerToken !== undefined
        ? { charsPerToken: deps.compaction.charsPerToken }
        : {}),
      ...(deps.compaction?.gateDelta !== undefined ? { gateDelta: deps.compaction.gateDelta } : {}),
      ...(deps.compaction?.maxContextTokens !== undefined
        ? { maxContextTokens: deps.compaction.maxContextTokens }
        : {}),
      ...(deps.compaction?.maxSingleToolResultTokens !== undefined
        ? { maxSingleToolResultTokens: deps.compaction.maxSingleToolResultTokens }
        : {}),
      ...(deps.compaction?.defaultEngine !== undefined
        ? { defaultEngine: deps.compaction.defaultEngine }
        : {}),
      ...(lastActualInputTokens !== undefined ? { lastActualInputTokens } : {}),
      ...(staticTokens !== undefined ? { staticTokens } : {}),
    },
    llmMessages,
    systemPrompt ?? '',
    personality,
    {
      sessionId,
      sessionKey,
      turnNumber,
      lastCompactionTurn,
      ...(autoBoundary.index > 0 && autoBoundary.keptFromMessageId
        ? { keptFromMessageId: autoBoundary.keptFromMessageId }
        : {}),
    },
  );
  llmMessages = compacted.messages;
  // F2 — cache breakpoints from the compaction, forwarded to every provider
  // call this turn so the prompt cache survives the compacted prefix. When no
  // compaction ran, fall back to the aging boundary (Phase 1a) so the prompt
  // cache re-anchors just after the batched aged region. Compaction reshapes the
  // array (shifting indices), so its breakpoints take precedence when present.
  // Phase 2 — when a watermark was replayed (no fresh compaction this turn), the
  // summary sits at index 0 as a stable prefix, so re-anchor the cache there.
  const cacheBreakpoints =
    compacted.cacheBreakpoints ??
    (watermarkApplied && !compacted.notice
      ? [0]
      : agingCacheBreakpoint !== undefined
        ? [agingCacheBreakpoint]
        : undefined);
  // V1 — surface a one-line in-chat compaction notice. Emitted once, before
  // any response text, via the `tool_progress` + `audience: 'user'` channel
  // the framework already uses for `_budget` / `_watcher` notices.
  if (compacted.notice) {
    const n = compacted.notice;
    const tok = n.summaryTokens > 0 ? `, ${n.summaryTokens} tok` : '';
    yield {
      type: 'tool_progress',
      toolName: '_compaction',
      message: `compressed ${n.droppedCount} earlier message(s) (${n.engineName}${tok})`,
      audience: 'user',
    };
  }

  return {
    systemPrompt,
    llmMessages,
    cacheBreakpoints,
    activeSkillFiles,
    baseMessageCount: allMessages.length,
    userScopeId,
    compactedThisTurn: compacted.notice !== undefined,
  };
}
