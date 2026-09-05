import { resolveCallTreatment } from '@ethosagent/types';
import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { useQueryClient } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { TakeoverMode } from '../components/browser/TakeoverMode';
import { TakeoverUnavailableNote } from '../components/browser/TakeoverStage';
import { takeoverStageFits } from '../components/browser/useTakeoverSocket';
import { ApprovalModal } from '../components/chat/ApprovalModal';
import { ClarifyCard } from '../components/chat/ClarifyCard';
import { Composer } from '../components/chat/Composer';
import { GoalIntakeModal } from '../components/chat/GoalIntakeModal';
import { MessageList } from '../components/chat/MessageList';
import {
  PersonalityBar,
  type PersonalityBarCoordinatorOf,
  type PersonalityBarTeamContext,
} from '../components/chat/PersonalityBar';
import type { RunSurface } from '../components/chat/RunCard';
import { StatusLine } from '../components/chat/StatusLine';
import { useConfig } from '../features/config/api/queries';
import { useGoalCreate } from '../features/goals/api/mutations';
import { useGoalDetection } from '../features/goals/useGoalDetection';
import { usePersonalityGet } from '../features/personalities/api/queries';
import { useSessionRenameFromChat } from '../features/sessions/api/mutations';
import { useRecentSessions, useSessionGet } from '../features/sessions/api/queries';
import { useTeam } from '../features/teams/api/queries';
import { teamAccents } from '../features/teams/lib/membership';
import { CallStage } from '../features/voice/CallStage';
import {
  callStageMounted,
  callStageVisual,
  resolveCallAccent,
} from '../features/voice/call-motion';
import { runVoiceClarify } from '../features/voice/clarify-voice';
import { personalityCanTalk } from '../features/voice/gating';
import { createPushToTalkHandlers } from '../features/voice/push-to-talk';
import {
  providerSummary,
  STATUS_LABEL,
  TalkModeCallBar,
  TalkModeToggle,
} from '../features/voice/TalkMode';
import { createTalkModeClient, type RealtimeTokenAnswer } from '../features/voice/talk-mode-client';
import { useVoiceCall, type VoiceCallClientHooks } from '../features/voice/useVoiceCall';
import { VoiceModeToggle } from '../features/voice/VoiceModeToggle';
import type { VoiceCallClient } from '../features/voice/voice-call-client';
import {
  callStripVisible,
  chatMessagesWithVoice,
  voiceCaption,
} from '../features/voice/voice-call-reducer';
import { useActivePersonality } from '../hooks/useActivePersonality';
import { useChat } from '../hooks/useChat';
import { useNewSessionModal } from '../hooks/useNewSessionModal';
import { type AttachmentPreview, placeholderPreview, readPreviewData } from '../lib/attachments';
import { clearLastSessionId, setLastSessionId } from '../lib/lastSession';
import { buildNewSessionPath } from '../lib/newSessionPicker';
import { accentVars, personalityTheme } from '../lib/theme';
import { buildTeamPath } from '../lib/workspaceRoutes';
import { mostRecentSessionIdForPersonality } from '../lib/workspaceScope';
import { rpc } from '../rpc';

// The chat surface — daily-driver tab in v0. Composition:
//
//   ┌────────────────────────────────┐
//   │  PersonalityBar (accent stripe)│
//   ├────────────────────────────────┤
//   │  MessageList (scrollable)      │
//   │  ↳ ghost streaming bubble at   │
//   │    the tail while in-flight    │
//   ├────────────────────────────────┤
//   │  [error banner if present]     │
//   │  Composer (sticky bottom)      │
//   └────────────────────────────────┘
//
// While a call is carrying audio the page renders the Call Stage INSTEAD of
// that composition — a mode, not a layer over it (DESIGN.md § "Call Stage").
//
// The per-personality accent (`<ConfigProvider>` + `--accent`) lifted up to
// the workspace subtree in App.tsx (P1b, plan/phases/personality-first-ui.md)
// — it now wraps ScopeNav + StageHeader + this whole stage, not just Chat.
// The plain (non-call) branch below no longer wraps itself; it inherits
// `--accent` from that ancestor. The call-stage branch keeps its OWN
// `<ConfigProvider>` + `accentVars`, because `callAccent` can differ from the
// personality's own accent (an operator-pinned call hex) — a distinct scope,
// not the one P0 amended. The base theme + AntApp wrap higher up in
// `main.tsx`.
//
// `?session=<id>` in the URL is the deep-link handle — opening a session
// from the Sessions tab (W4) navigates here with the param set; sending
// a fresh message updates the URL to the server-assigned id so refresh
// stays on the same conversation.
//
// The active PERSONALITY, separately, is the route's `:personalityId` —
// `useActivePersonality()` reads it off the URL, not session-bound
// component state. App.tsx renders this component through a wrapper keyed
// on that param (`<Chat key={personalityId} />`), so switching agents
// (AltitudeRail, `sessionOpenPath`, a redirect) always remounts fresh rather
// than patching a live instance — the effects below run once per agent, not
// once ever.
//
// The team Chat pane (`/t/:teamId/chat`, plan/phases/teams-as-a-scope.md D4)
// renders this same page for the team's coordinator: `TeamChat` passes
// `personalityId` explicitly (the route carries no `/p/` segment for the URL
// lookup to find) plus `teamContext`, which swaps in the bar variant, the
// team empty state and the composer placeholder. Everything else — sessions,
// the loop the turn runs on — is the coordinator's by construction.

/** The team whose chat this is (D4). `accents` are the members' in manifest order. */
// The page resolves the coordinator's display name itself (it already loads
// the personality), so the pane passes everything but that.
export type ChatTeamContext = Omit<PersonalityBarTeamContext, 'coordinatorName'>;

export interface ChatProps {
  /** Overrides the URL-derived active personality. Set by the team Chat pane. */
  personalityId?: string;
  teamContext?: ChatTeamContext;
}

export function Chat({ personalityId: personalityIdProp, teamContext }: ChatProps = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionParam = searchParams.get('session') ?? undefined;
  const active = useActivePersonality();
  const personalityId = personalityIdProp ?? active.id;
  const { model, isLoading } = active;
  const { notification } = AntApp.useApp();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const createGoal = useGoalCreate();
  const { openNewSessionModal } = useNewSessionModal();

  // Pre-fetch the session key from the URL param so we can thread it into
  // useChat. React Query deduplicates this with the sessionQuery below when
  // currentSessionId matches sessionParam.
  const sessionParamQuery = useSessionGet(sessionParam ?? null);

  const {
    state,
    currentSessionId,
    sendMessage,
    steerMessage,
    abortTurn,
    switchSession,
    resetSession,
    compact,
    noteClarifyAnswer,
  } = useChat({
    ...(sessionParam ? { initialSessionId: sessionParam } : {}),
    personalityId,
    sessionKey: sessionParamQuery.data?.session.key,
    onSessionCreated: (id) => {
      setSearchParams({ session: id }, { replace: true });
      setLastSessionId(id);
      void queryClient.invalidateQueries({ queryKey: ['sessions', 'list'] });
    },
    onSessionNotFound: () => {
      clearLastSessionId();
      setSearchParams({}, { replace: true });
    },
  });

  const sessionQuery = useSessionGet(currentSessionId);
  // undefined = no session; null = session without title; string = titled session
  const sessionTitle = currentSessionId ? (sessionQuery.data?.session.title ?? null) : undefined;

  const renameMut = useSessionRenameFromChat(currentSessionId);

  const handleRenameSession = (title: string | null) => {
    if (!currentSessionId) return;
    renameMut.mutate({ id: currentSessionId, title });
  };

  // `?new=1` from the New Session picker / architect flow (`buildNewSessionPath`,
  // which already routes to THIS agent's own `/p/:id/chat` — no `?personality=`
  // param to consume here anymore). It means "start fresh, don't restore the
  // last session below" — read early so both effects that follow can see it.
  const newSessionParam = searchParams.get('new');

  // Restore this agent's own last session on mount when the URL has neither
  // `?session=` nor `?new=1`. Sourced from `sessions.list` (the same RPC and
  // cache ScopeNav's session block already fills), not localStorage: Chat
  // fully remounts on a personality switch (`key={personalityId}` on its
  // route wrapper in App.tsx), so this is one fresh, agent-scoped lookup per
  // switch rather than a single cross-agent pointer — the plan's "Done when"
  // for Chat specifically ("restore that agent's last session, or land on an
  // empty Chat — never a foreign `?session=`"). Falls through to an empty
  // Chat when this agent has no sessions yet. Lives at the page level (not
  // inside useChat) because it interacts with routing.
  const recentSessionsQuery = useRecentSessions(20);
  useEffect(() => {
    if (sessionParam || currentSessionId || newSessionParam) return;
    if (!recentSessionsQuery.data) return;
    const restored = mostRecentSessionIdForPersonality(
      recentSessionsQuery.data.items,
      personalityId,
    );
    if (restored) setSearchParams({ session: restored }, { replace: true });
  }, [
    sessionParam,
    currentSessionId,
    newSessionParam,
    recentSessionsQuery.data,
    personalityId,
    setSearchParams,
  ]);

  // Mirror every URL session change into localStorage so cross-agent chrome
  // (CommandPalette, StatusBar, the right drawer's SSE toasts) that isn't
  // itself personality-scoped still finds "the session I was just in".
  useEffect(() => {
    if (sessionParam) setLastSessionId(sessionParam);
  }, [sessionParam]);

  const initialMount = useRef(true);
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally session-key only
  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false;
      return;
    }
    if (sessionParam && sessionParam !== currentSessionId) {
      switchSession(sessionParam);
    } else if (!sessionParam && currentSessionId) {
      resetSession();
      clearLastSessionId();
    }
  }, [sessionParam]);

  // Consume `?new=1`: force a fresh session instead of the restore above.
  // The param is stripped either way so Back doesn't re-trigger it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetSession/clearLastSessionId are stable; deps intentionally key on the param only
  useEffect(() => {
    if (!newSessionParam) return;
    resetSession();
    clearLastSessionId();
    const next = new URLSearchParams(searchParams);
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [newSessionParam, searchParams, setSearchParams]);

  // Periodically re-render while a turn is in flight so the stall indicator can
  // compare the last activity to the current wall clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (state.phase === null) return;
    const id = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(id);
  }, [state.phase]);

  // 20 s with no event → `⚠ still working` inside the status line (contract
  // §2). Before the first SSE event there is no `lastStreamEventAt`, so the
  // send itself is the last thing that happened — a request the server never
  // answers has to stall too.
  const lastActivityAt = state.lastStreamEventAt ?? state.turnStartedAt;
  const isStalled =
    state.phase !== null && lastActivityAt !== null && Date.now() - lastActivityAt > 20_000;

  const [pendingAttachments, setPendingAttachments] = useState<AttachmentPreview[]>([]);

  // Suggestion pills (empty state + `recommend_actions` cards) fill the
  // composer draft. `seq` makes a repeat pick a distinct event.
  const [suggestion, setSuggestion] = useState<{ text: string; seq: number } | undefined>();
  const handleSuggestPrompt = useCallback((text: string) => {
    setSuggestion((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

  // `?draft=` — a prompt handed over from another surface (today: the recipe
  // post-install panel's "Open chat with …"). It fills the composer through the
  // same suggestion path a pill uses, so it is never sent on the user's behalf.
  // Stripped once consumed so Back doesn't re-fill it.
  const draftParam = searchParams.get('draft');
  useEffect(() => {
    if (!draftParam) return;
    handleSuggestPrompt(draftParam);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete('draft');
        return next;
      },
      { replace: true },
    );
  }, [draftParam, handleSuggestPrompt, setSearchParams]);

  const { intakeOpen, setIntakeOpen, detectedMessage, restatedGoal, openIntake } =
    useGoalDetection();

  const handleAttach = useCallback((files: File[]) => {
    const placeholders = files.map((file) => ({ file, preview: placeholderPreview(file) }));
    setPendingAttachments((prev) => [...prev, ...placeholders.map((p) => p.preview)]);
    for (const { file, preview } of placeholders) {
      readPreviewData(file)
        .then((data) => {
          setPendingAttachments((prev) =>
            prev.map((a) => (a.localId === preview.localId ? { ...a, state: 'ready', data } : a)),
          );
        })
        .catch(() => {
          setPendingAttachments((prev) =>
            prev.map((a) => (a.localId === preview.localId ? { ...a, state: 'error' } : a)),
          );
        });
    }
  }, []);

  const handleRemoveAttachment = useCallback((localId: string) => {
    setPendingAttachments((prev) => {
      const a = prev.find((x) => x.localId === localId);
      if (a?.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return prev.filter((x) => x.localId !== localId);
    });
  }, []);

  const [elapsedMs, setElapsedMs] = useState(0);
  useEffect(() => {
    if (!state.turnStartedAt) {
      setElapsedMs(0);
      return;
    }
    const id = setInterval(() => {
      setElapsedMs(Date.now() - (state.turnStartedAt ?? Date.now()));
    }, 1000);
    return () => clearInterval(id);
  }, [state.turnStartedAt]);

  const handleSend = async (text: string) => {
    // Phase 2 — `/compact [focus]` is handled client-side: it forces a
    // server-side compaction instead of sending a turn. `/compact status`
    // points to the Activity tab (persisted context anatomy lives there).
    const trimmed = text.trim();
    if (/^\/compact(\s|$)/i.test(trimmed)) {
      const focus = trimmed.replace(/^\/compact\s*/i, '').trim();
      if (focus.toLowerCase() === 'status') {
        notification.info({
          message: 'Context anatomy',
          description: 'See the Activity tab for this session’s context breakdown.',
        });
        return;
      }
      const result = await compact(focus || undefined);
      if (!result?.ok) {
        notification.info({
          message: 'Compaction',
          description: 'Not enough history to compact yet.',
        });
        return;
      }
      const saved = Math.max(0, result.preTotalTokens - result.postTotalTokens);
      notification.success({
        message: `Compacted ${result.droppedCount} earlier message(s)`,
        description:
          `${result.engineName}: ${result.preTotalTokens.toLocaleString()} → ` +
          `${result.postTotalTokens.toLocaleString()} tok (−${saved.toLocaleString()})` +
          (result.summariesEnabled
            ? ''
            : '. Summaries disabled — set auxiliary.compression.model to enable.'),
      });
      return;
    }

    if (state.isStreaming) {
      const ok = await steerMessage(text);
      if (ok) return;
    }
    const atts = pendingAttachments.filter((a) => a.state === 'ready');
    await sendMessage(text, atts.length > 0 ? atts : undefined);
    for (const a of pendingAttachments) {
      if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
    }
    setPendingAttachments([]);
  };

  const handleGoalQuickStart = async (goalText: string) => {
    setIntakeOpen(false);
    const { goal } = await createGoal.mutateAsync({ personalityId, goalText });
    navigate(`/goals/${goal.id}`);
  };

  const handleGoalConfiguredRun = async (config: {
    goalText: string;
    checks: Array<{ description: string }>;
    rubric: Array<{ description: string; weight: number }>;
    boundaries: string;
    costLimit: number;
    trials: number;
    maxToolCallsPerTurn: number;
    maxIdenticalToolCalls: number;
    maxRecoveryAttempts: number;
    allowDangerousToolCalls: boolean;
  }) => {
    setIntakeOpen(false);
    const goalText = config.boundaries.trim()
      ? `${config.goalText}\n\nBoundaries: ${config.boundaries.trim()}`
      : config.goalText;
    const { goal } = await createGoal.mutateAsync({
      personalityId,
      goalText,
      acceptanceCriteria: { checks: config.checks, rubric: config.rubric },
      maxAttempts: config.trials,
      maxCostUsd: config.costLimit,
      maxToolCallsPerTurn: config.maxToolCallsPerTurn,
      maxIdenticalToolCalls: config.maxIdenticalToolCalls,
      maxRecoveryAttempts: config.maxRecoveryAttempts,
      allowDangerousToolCalls: config.allowDangerousToolCalls,
    });
    navigate(`/goals/${goal.id}`);
  };

  const handleGoalRunDirect = () => {
    // Open intake modal directly with current composer text, skipping detection
    const composerText = document.querySelector<HTMLTextAreaElement>('.composer-card textarea');
    const text = composerText?.value?.trim() ?? '';
    openIntake(text);
  };

  // Render the head of the queue. Multiple back-to-back approvals are
  // rare in practice (the agent loop awaits each tool sequentially), but
  // the queue model means we don't have to special-case "second approval
  // arrived while the first modal was open."
  const pendingApproval = state.pendingApprovals[0];
  // D3 — a `browser_takeover` is not a question and must not be drawn as one:
  // it has its own panel below, the composer is locked while it is open, and
  // it must never be routed to the voice ask path.
  const pendingClarify = state.pendingClarifies.find(
    (c) => (c.kind ?? 'question') !== 'browser_takeover',
  );
  const pendingTakeover = state.pendingClarifies.find(
    (c) => (c.kind ?? 'question') === 'browser_takeover',
  );
  // The takeover panel outlives its pending row: once the request resolves it
  // leaves `pendingClarifies`, and the panel has to stay put and flip to its
  // resolved line rather than vanish (the Call Stage lesson). So the request is
  // remembered here and the settled row is read out of the resolved queue.
  const [takeoverRequest, setTakeoverRequest] = useState<ClarifyRequestEvent | null>(null);
  useEffect(() => {
    if (pendingTakeover) setTakeoverRequest(pendingTakeover);
  }, [pendingTakeover]);
  const takeoverResolution = takeoverRequest
    ? (state.clarifyQueue.resolved.find((r) => r.requestId === takeoverRequest.requestId) ?? null)
    : null;
  const takeoverActive = takeoverRequest !== null && takeoverResolution === null;
  // B3 — the screencast stage is a MODE, entered by an explicit click, never
  // automatically. A takeover on a headed desktop already has a real window and
  // the card is the whole interaction there; opening a full-surface canvas over
  // it uninvited would be the wrong surface for the common case.
  const [takeoverStageOpen, setTakeoverStageOpen] = useState(false);
  const [takeoverStartedAt, setTakeoverStartedAt] = useState(() => Date.now());
  useEffect(() => {
    if (pendingTakeover) setTakeoverStartedAt(Date.now());
  }, [pendingTakeover]);
  // Resolved, cancelled or timed out — the mode has nothing left to drive, and
  // the settled row in the transcript is what the user needs to see next.
  useEffect(() => {
    if (!takeoverActive) setTakeoverStageOpen(false);
  }, [takeoverActive]);
  const takeoverVisible = takeoverActive && takeoverStageOpen;

  // Live state for the delegated-run cards anchored in the transcript (§4.1).
  // Fed by the `run.update` digest already riding this session's SSE stream —
  // the card needs no connection of its own (G9/D11).
  const runSurface: RunSurface = useMemo(
    () => ({
      runs: state.runs,
      clarifyQueue: state.clarifyQueue,
      onAnswered: noteClarifyAnswer,
    }),
    [state.runs, state.clarifyQueue, noteClarifyAnswer],
  );

  // Talk-mode (Phase B). The call affordance is gated on the active
  // personality's toolset (§3(e)) — voice availability is a personality
  // capability, not a config field. The live-call client is injected — this page
  // supplies `createTalkModeClient` below (see features/voice/README.md), which
  // picks the realtime or pipeline tier at call time.
  const personalityQuery = usePersonalityGet(personalityId);
  const canTalk = personalityCanTalk(personalityQuery.data?.personality.toolset);

  // The reverse label (D4): inside a team, the coordinator's OWN workspace
  // chat says it is the team's chat. Read off the route's `:teamId` — the
  // team Chat pane already knows (`teamContext`), so it skips the query.
  const { teamId: routeTeamId } = useParams<{ teamId?: string }>();
  const routeTeamQuery = useTeam(routeTeamId ?? '', {
    enabled: Boolean(routeTeamId) && !teamContext,
  });
  const routeTeam = routeTeamQuery.data;
  const coordinatorOf: PersonalityBarCoordinatorOf | undefined =
    !teamContext && routeTeamId && routeTeam && routeTeam.coordinator === personalityId
      ? { teamId: routeTeamId, teamName: routeTeam.name, accents: teamAccents(routeTeam) }
      : undefined;
  const coordinatorName = personalityQuery.data?.personality.name ?? capitalize(personalityId);

  // Voice config gates the live call. STT is required; TTS is optional (no TTS →
  // the reply is surfaced as text only, synthesis skipped).
  const configQuery = useConfig();
  const sttConfigured = Boolean(configQuery.data?.voiceProvider);
  const ttsConfigured = Boolean(configQuery.data?.voiceTtsProvider);
  const ttsVoice = configQuery.data?.voiceTtsVoice ?? undefined;
  // Talk-mode "thinking" chime — on unless explicitly disabled in Settings.
  const voiceChime = configQuery.data?.voiceChime ?? true;
  // Live VAD / barge-in tuning from Settings → Voice → Advanced. Each field is a
  // resolved number (default when unset); the driver falls back per-field.
  const voiceEndpointSilenceMs = configQuery.data?.voiceEndpointSilenceMs;
  const voiceBargeThreshold = configQuery.data?.voiceBargeThreshold;
  const voiceBargeSustainMs = configQuery.data?.voiceBargeSustainMs;
  const voiceSpeechThreshold = configQuery.data?.voiceSpeechThreshold;
  const voiceSpeechMinMs = configQuery.data?.voiceSpeechMinMs;

  // The active session id read lazily by the voice runner — it can change
  // between turns (fork, new session) without rebuilding the client.
  const sessionIdRef = useRef(currentSessionId);
  sessionIdRef.current = currentSessionId;

  // The user's explicit private/offline choice. Held in a ref because the
  // client factory reads it at CONNECT time — flipping it must change what the
  // next call dials, not rebuild a client mid-call — and mirrored into state so
  // the strip can offer the way back out.
  const [privateVoice, setPrivateVoice] = useState(false);
  const privateVoiceRef = useRef(false);
  privateVoiceRef.current = privateVoice;
  // Which realtime provider/model actually served the call. Reported by the
  // transport once the mint answered, so the strip's `{provider} · {model}`
  // names what ran instead of what config defaults to.
  const [realtimeRan, setRealtimeRan] = useState<{ provider: string; model: string | null } | null>(
    null,
  );

  const createVoiceClient = useCallback(
    (hooks: VoiceCallClientHooks): VoiceCallClient =>
      // Streaming (binary PCM over one persistent WebSocket, WebAudio playout)
      // where the browser supports it; the batch RPC path otherwise. Same
      // events either way, so nothing below this line changes.
      createTalkModeClient({
        sessionId: () => sessionIdRef.current,
        // The realtime tier is decided SERVER-side: this asks for a credential
        // and gets either one or a typed reason, and the transport degrades to
        // the local pipeline with that reason on screen.
        mintRealtimeToken: (): Promise<RealtimeTokenAnswer> =>
          rpc.voice.realtimeToken({ ...(personalityId ? { personalityId } : {}) }),
        forcePipeline: privateVoiceRef.current,
        onTier: (tier, detail) => {
          hooks.onTier(tier);
          setRealtimeRan(
            tier === 'realtime' && detail.provider
              ? { provider: detail.provider, model: detail.model ?? null }
              : null,
          );
        },
        // `personalityId` picks the STT entry the same way it picks the voice,
        // so the batch fallback hears through the same engine the streaming
        // lane does rather than silently reverting to the global default.
        transcribe: (audioBase64, mimeType) =>
          rpc.voice
            .transcribe({
              audio: audioBase64,
              mimeType,
              ...(personalityId ? { personalityId } : {}),
            })
            .then((r) => r.transcript),
        // No `runAgentTurn` override here: `createTalkModeClient`'s batch
        // fallback default (`runBrowserVoiceTurn`) drives the turn on the
        // browser voice lane itself, not the chat session — see Bug 4 /
        // Conflict 1 in `plan/phases/voice-live-personality.md` §7.
        ...(ttsConfigured
          ? {
              synthesize: (text, voice) =>
                rpc.voice
                  .synthesize({
                    text,
                    ...(voice ? { voice } : {}),
                    ...(personalityId ? { personalityId } : {}),
                  })
                  .then((r) => ({ audioBase64: r.audio, mimeType: r.mimeType })),
            }
          : {}),
        // `voice` is the GLOBAL default from Settings; `personalityId` is what
        // lets the server prefer the active personality's declared voice over
        // it. Precedence is resolved server-side in one place
        // (`resolveVoicePreferences`) so every surface agrees.
        ...(ttsVoice ? { voice: ttsVoice } : {}),
        ...(personalityId ? { personalityId } : {}),
        chime: voiceChime,
        tuning: {
          ...(voiceEndpointSilenceMs !== undefined
            ? { endpointSilenceMs: voiceEndpointSilenceMs }
            : {}),
          ...(voiceBargeThreshold !== undefined ? { bargeThreshold: voiceBargeThreshold } : {}),
          ...(voiceBargeSustainMs !== undefined ? { bargeSustainMs: voiceBargeSustainMs } : {}),
          ...(voiceSpeechThreshold !== undefined ? { speechThreshold: voiceSpeechThreshold } : {}),
          ...(voiceSpeechMinMs !== undefined ? { speechMinMs: voiceSpeechMinMs } : {}),
        },
      }),
    [
      ttsConfigured,
      ttsVoice,
      voiceChime,
      voiceEndpointSilenceMs,
      voiceBargeThreshold,
      voiceBargeSustainMs,
      voiceSpeechThreshold,
      voiceSpeechMinMs,
      personalityId,
    ],
  );

  const voice = useVoiceCall({ createClient: createVoiceClient });
  const inCall = voice.status !== 'idle' && voice.status !== 'ended';

  // The Call Stage (DESIGN.md § "Call Stage"). Starting a call switches this
  // page INTO the stage; ending it returns to normal chat. The stage's "Back to
  // chat" control collapses it back to the strip without hanging up — that is
  // what keeps the composer reachable while a call is reconnecting.
  const [stageOpen, setStageOpen] = useState(true);
  useEffect(() => {
    if (inCall) setStageOpen(true);
  }, [inCall]);
  const callVisual = callStageVisual(voice.status);
  const callAccent = resolveCallAccent(configQuery.data?.callAccent, personalityId);
  // Which shape the stage draws. One precedence rule, in contracts, shared with
  // the character sheet: the personality's own `voice.call_style` first, then a
  // concrete `display.call_style` pin, then a treatment derived from the id.
  const callTreatment = resolveCallTreatment({
    personalityId,
    ...(personalityQuery.data?.personality.voice?.call_style
      ? { personalityCallStyle: personalityQuery.data.personality.voice.call_style }
      : {}),
    ...(configQuery.data?.callStyle ? { operatorCallStyle: configQuery.data.callStyle } : {}),
  });
  const callProviderLabel = providerSummary({
    status: voice.status,
    sttProvider: voice.sttProvider ?? configQuery.data?.voiceProvider ?? null,
    sttModel: configQuery.data?.voiceModel ?? null,
    ttsProvider: voice.ttsProvider ?? configQuery.data?.voiceTtsProvider ?? null,
    ttsModel: configQuery.data?.voiceTtsModel ?? null,
    realtimeProvider: realtimeRan?.provider ?? null,
    realtimeModel: realtimeRan?.model ?? null,
  });
  // The stage is mounted by the CALL, not by the drawn state: connecting and
  // reconnecting render INSIDE it (see `callStageVisual`), because unmounting
  // for a transient status restarts the enter animation and the canvas, and that
  // reads as the mode flickering out and back mid-sentence. Degraded / mic-denied
  // still hand over to the strip — that is where the explanation lives.
  // `available` and `visible` differ only in the collapse, so the strip offers to
  // restore a stage exactly when there is one to restore.
  const stageMount = {
    status: voice.status,
    degraded: voice.degraded !== null,
    micDenied: voice.micDenied,
  };
  const stageAvailable = callStageMounted({ ...stageMount, minimized: false });
  const stageVisible = callStageMounted({ ...stageMount, minimized: !stageOpen });

  // DR5's persistent transcript. On the realtime tier the provider owns the
  // conversation and nothing ever reaches `sendMessage`, so the spoken turns
  // land in the SAME message list only because they are projected here — the
  // strip's captions are not a record, they scroll away with the call.
  const { tier: voiceTier, transcript: voiceTranscript } = voice;
  const messages = useMemo(
    () => chatMessagesWithVoice(state.messages, { tier: voiceTier, transcript: voiceTranscript }),
    [state.messages, voiceTier, voiceTranscript],
  );

  // A real toggle: the composer glyph both starts the call and ends it. The
  // strip's hang-up button and Esc stay the primary way out — this is the
  // second affordance for the control that claims `aria-pressed`.
  const handleTalkToggle = useCallback(() => {
    if (inCall) {
      voice.hangUp();
      return;
    }
    if (!sttConfigured) {
      notification.info({
        message: 'Voice',
        description: 'Configure STT/TTS in Settings → Voice to talk.',
        placement: 'topRight',
      });
      return;
    }
    voice.start();
  }, [inCall, sttConfigured, voice.start, voice.hangUp, notification]);

  /**
   * Turn on the private/offline mode for the NEXT call.
   *
   * It cannot switch mid-call: the two tiers hold different sockets and
   * different audio graphs, so "switching" is hanging up and dialling again.
   * Saying that plainly beats silently reconnecting under the user.
   */
  const handleUsePrivateMode = useCallback(() => {
    setPrivateVoice(true);
    voice.hangUp();
    notification.info({
      message: 'Private mode',
      description:
        'Voice will run entirely on the local pipeline. Start the call again to talk privately.',
      placement: 'topRight',
    });
  }, [voice.hangUp, notification]);

  /** Undo the private/offline choice. Takes effect on the next call, same as on. */
  const handleLeavePrivateMode = useCallback(() => {
    setPrivateVoice(false);
    voice.hangUp();
    notification.info({
      message: 'Private mode off',
      description: 'Start the call again to use the realtime voice tier.',
      placement: 'topRight',
    });
  }, [voice.hangUp, notification]);

  useEffect(() => {
    // The strip owns the mic-denied and degraded-to-text stories — a toast on
    // top of them would say the same thing twice, in a place the user cannot
    // act on.
    if (voice.error && !voice.micDenied && !voice.degraded && !voice.notice) {
      notification.info({ message: 'Voice', description: voice.error, placement: 'topRight' });
    }
  }, [voice.error, voice.micDenied, voice.degraded, voice.notice, notification]);

  // Keyboard push-to-talk: hold Space to talk, Esc ends the call. Bound only
  // while a call is up, and never while the user is typing (Space is a
  // character before it is a control).
  useEffect(() => {
    if (!inCall) return;
    const handlers = createPushToTalkHandlers({
      onHold: () => voice.pressToTalk(true),
      onRelease: () => voice.pressToTalk(false),
      onEnd: voice.hangUp,
    });
    const down = (event: KeyboardEvent) => handlers.keyDown(event);
    const up = (event: KeyboardEvent) => handlers.keyUp(event);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [inCall, voice.pressToTalk, voice.hangUp]);

  // Voice-native clarify. While a call is up, the agent's mid-turn question is
  // SPOKEN and the next thing the user says answers it — routed to
  // `clarify.respond`, not sent as a new chat turn. Without a call this effect
  // does nothing at all and the card behaves exactly as it always has.
  //
  // The card renders throughout either way (below), non-blocking: the visual
  // record of what was asked, the fallback when the tier cannot speak or
  // synthesis fails, and still clickable — whichever answer lands first wins.
  // Cleanup runs when the request leaves `pendingClarifies`, which is the
  // existing `clarify.resolved` path (answered here, answered on the card,
  // timed out, cancelled); aborting the ask there is what takes voice back out
  // of "the next thing you say answers this".
  const askByVoice = voice.ask;
  useEffect(() => {
    if (!pendingClarify || !inCall) return;
    const controller = new AbortController();
    void runVoiceClarify({
      request: pendingClarify,
      ask: askByVoice,
      respond: (answer) =>
        rpc.clarify
          .respond({ requestId: pendingClarify.requestId, answer, source: 'user' })
          .then(() => undefined),
      signal: controller.signal,
    });
    return () => controller.abort();
  }, [pendingClarify, inCall, askByVoice]);

  const handleNewSession = () => {
    // Team Chat pane (teams-as-a-scope T4): there is nothing to pick — the
    // team has one coordinator — and the picker's `/p/<id>/chat?new=1` would
    // be bounced into the coordinator's workspace. Stay in the pane.
    if (teamContext) {
      navigate(
        buildNewSessionPath(teamContext.coordinatorId, buildTeamPath(teamContext.teamId, 'chat')),
      );
      return;
    }
    openNewSessionModal();
  };

  // Call Stage is a MODE: while it is up it IS the chat surface, so the normal
  // chat chrome (personality bar, message list, composer) is not also on screen
  // behind it — including the PersonalityBar, whose rename/new-session are the
  // wrong things to offer mid-call. The way back to text is the stage's own
  // "Back to chat" control, which collapses the mode WITHOUT ending the call and
  // hands over to the strip.
  // B3 — the screencast takeover is a mode on the Call Stage template: while
  // it is up it IS the chat surface, so no rail and no PersonalityBar. The way
  // out that does NOT hand back is the stage's own "Back to chat".
  if (takeoverVisible && takeoverRequest) {
    return (
      <ConfigProvider theme={personalityTheme(personalityId)}>
        <div className="chat-tab chat-tab-call">
          <TakeoverMode
            key={takeoverRequest.requestId}
            request={takeoverRequest}
            startedAt={takeoverStartedAt}
            onBackToChat={() => setTakeoverStageOpen(false)}
          />
          {pendingApproval ? (
            <ApprovalModal key={pendingApproval.approvalId} request={pendingApproval} />
          ) : null}
        </div>
      </ConfigProvider>
    );
  }

  if (stageVisible) {
    return (
      <ConfigProvider theme={personalityTheme(personalityId)}>
        {/* `--accent` for the mode is the CALL's accent, which is the
            personality's unless the operator pinned an explicit hex. The stage
            used to stamp it on itself; defining it here instead keeps one
            definition per subtree and lets the strip-era rules (turn label,
            focus rings) resolve to the same colour the canvas is drawn in. */}
        <div className="chat-tab chat-tab-call" style={accentVars(callAccent)}>
          <CallStage
            state={callVisual}
            treatment={callTreatment}
            accent={callAccent}
            personalityId={personalityId}
            personalityName={capitalize(personalityId)}
            micLevels={voice.micLevels}
            agentLevel={voice.agentLevel}
            statusLabel={STATUS_LABEL[voice.status]}
            providerLabel={callProviderLabel}
            latencyMs={voice.latency?.totalMs ?? null}
            transcript={voice.transcript}
            clarify={pendingClarify ?? null}
            muted={voice.muted}
            onToggleMute={voice.toggleMute}
            onExpandChat={() => setStageOpen(false)}
            onHangUp={voice.hangUp}
          />
          {/* An approval is a hard gate on a running turn — it outranks the
              mode and keeps its own surface, exactly as it does off-call. */}
          {pendingApproval ? (
            <ApprovalModal key={pendingApproval.approvalId} request={pendingApproval} />
          ) : null}
        </div>
      </ConfigProvider>
    );
  }

  return (
    <div className="chat-tab">
      <PersonalityBar
        personalityId={personalityId}
        avatarUrl={personalityQuery.data?.personality.display?.avatar_url}
        model={isLoading ? '' : model}
        onNewSession={handleNewSession}
        sessionTitle={sessionTitle}
        onRenameSession={handleRenameSession}
        {...(teamContext ? { teamContext: { ...teamContext, coordinatorName } } : {})}
        {...(coordinatorOf ? { coordinatorOf } : {})}
        actionsSlot={
          <>
            {/* Whether replies are SPOKEN in this conversation, and whether
                  the phone is up, are two different questions — so they are two
                  controls, side by side, not one overloaded affordance. */}
            <VoiceModeToggle sessionId={currentSessionId} />
            <TalkModeToggle
              canTalk={canTalk}
              personalityName={capitalize(personalityId)}
              inCall={inCall}
              onToggle={handleTalkToggle}
            />
          </>
        }
      />
      {/* Not `inCall`: a finished call can still be the only thing on screen
            explaining why it finished. `callStripVisible` owns that rule. This
            branch only runs when the stage is down — the strip is what the stage
            collapses TO, so the two are never up together. Nothing is lost by
            that: every state the strip alone can explain (degraded, mic-denied,
            ended) already forces `stageVisible` false, and the transient ones the
            stage carries itself. */}
      {callStripVisible(voice) ? (
        <TalkModeCallBar
          status={voice.status}
          micLevels={voice.micLevels}
          muted={voice.muted}
          error={voice.error}
          onToggleMute={voice.toggleMute}
          onHangUp={voice.hangUp}
          caption={voiceCaption(voice)}
          windDown={voice.windDown}
          degraded={voice.degraded}
          micDenied={voice.micDenied}
          onDismissNotice={voice.dismissNotice}
          notice={voice.notice}
          tier={voice.tier}
          privateMode={privateVoice}
          onUsePrivateMode={handleUsePrivateMode}
          onLeavePrivateMode={handleLeavePrivateMode}
          sttProvider={voice.sttProvider ?? configQuery.data?.voiceProvider ?? null}
          sttModel={configQuery.data?.voiceModel ?? null}
          ttsProvider={voice.ttsProvider ?? configQuery.data?.voiceTtsProvider ?? null}
          ttsModel={configQuery.data?.voiceTtsModel ?? null}
          realtimeProvider={realtimeRan?.provider ?? null}
          realtimeModel={realtimeRan?.model ?? null}
          latency={voice.latency}
          {...(stageAvailable && !stageOpen ? { onExpand: () => setStageOpen(true) } : {})}
        />
      ) : null}
      <GoalIntakeModal
        open={intakeOpen}
        onClose={() => setIntakeOpen(false)}
        userMessage={detectedMessage}
        restatedGoal={restatedGoal}
        onQuickStart={(g) => void handleGoalQuickStart(g)}
        onConfiguredRun={(c) => void handleGoalConfiguredRun(c)}
      />
      {pendingApproval ? (
        <ApprovalModal key={pendingApproval.approvalId} request={pendingApproval} />
      ) : null}
      {pendingClarify ? (
        <ClarifyCard key={pendingClarify.requestId} request={pendingClarify} />
      ) : null}
      {takeoverRequest ? (
        <ClarifyCard
          key={takeoverRequest.requestId}
          request={takeoverRequest}
          resolution={takeoverResolution}
        />
      ) : null}
      {/* B3 — the way INTO the screencast mode, offered only while a takeover
          is actually live and only where a pointer and a viewport exist.
          Below 760px the note says where the driving happens instead; the
          card above still holds the hand-back, which is the whole of what a
          phone can usefully do here. */}
      {takeoverActive ? (
        takeoverStageFits() ? (
          <div className="takeover-enter">
            <button
              type="button"
              className="takeover-enter-btn"
              onClick={() => setTakeoverStageOpen(true)}
            >
              Take over on screen
            </button>
          </div>
        ) : (
          <TakeoverUnavailableNote reason="narrow" />
        )
      ) : null}
      <MessageList
        messages={messages}
        currentTurn={state.currentTurn}
        runSurface={runSurface}
        trail={state.trail}
        stoppedTurnIds={state.stoppedTurnIds}
        personalityId={personalityId}
        model={model}
        sessionId={currentSessionId ?? undefined}
        onSuggestPrompt={handleSuggestPrompt}
        {...(canTalk && !inCall ? { onTryVoice: handleTalkToggle } : {})}
        {...(teamContext
          ? {
              teamContext: {
                teamName: teamContext.teamName,
                accents: teamContext.accents,
                coordinatorName,
              },
            }
          : {})}
      />
      <StatusLine
        phase={state.phase}
        label={state.currentOp}
        elapsedMs={elapsedMs}
        stalled={isStalled}
      />
      <div>
        {state.error ? (
          <div className="chat-error" role="alert">
            {state.error}
          </div>
        ) : null}
        <Composer
          personalityId={personalityId}
          disabled={takeoverActive}
          onSend={handleSend}
          placeholder={
            takeoverActive
              ? 'Agent paused — hand back to continue'
              : state.isStreaming
                ? 'Steer the agent…'
                : teamContext
                  ? `Message ${teamContext.teamName}… (${coordinatorName} answers)`
                  : 'Send a message…'
          }
          isStreaming={state.isStreaming}
          onAbort={() => void abortTurn()}
          attachments={pendingAttachments}
          onAttach={handleAttach}
          onRemoveAttachment={handleRemoveAttachment}
          onGoalRun={handleGoalRunDirect}
          contextTokens={state.contextTokens}
          suggestion={suggestion}
          {...(canTalk
            ? {
                onTalkMode: handleTalkToggle,
                talkModeActive: inCall,
                talkModeHint: inCall ? 'End call' : `Talk to ${capitalize(personalityId)}`,
              }
            : {})}
        />
      </div>
    </div>
  );
}

function capitalize(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : '';
}
