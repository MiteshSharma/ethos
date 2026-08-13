import { TurnStatusBar } from '@ethosagent/ui-components';
import { useQueryClient } from '@tanstack/react-query';
import { App as AntApp, ConfigProvider } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ApprovalModal } from '../components/chat/ApprovalModal';
import { ClarifyCard } from '../components/chat/ClarifyCard';
import { Composer } from '../components/chat/Composer';
import { GoalIntakeModal } from '../components/chat/GoalIntakeModal';
import { MessageList } from '../components/chat/MessageList';
import { PersonalityBar } from '../components/chat/PersonalityBar';
import { useConfig } from '../features/config/api/queries';
import { useGoalCreate } from '../features/goals/api/mutations';
import { useGoalDetection } from '../features/goals/useGoalDetection';
import { usePersonalityGet } from '../features/personalities/api/queries';
import { useSessionRenameFromChat } from '../features/sessions/api/mutations';
import { useSessionGet } from '../features/sessions/api/queries';
import { CallOverlay } from '../features/voice/CallOverlay';
import {
  callOverlayMounted,
  callOverlayVisual,
  resolveCallAccent,
} from '../features/voice/call-motion';
import { runVoiceAgentTurn } from '../features/voice/chat-voice-runner';
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
import { clearLastSessionId, getLastSessionId, setLastSessionId } from '../lib/lastSession';
import { personalityTheme } from '../lib/theme';
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
// The whole subtree is wrapped in a per-personality `<ConfigProvider>`
// so Antd primitives inherit the active accent (Send button background,
// caret, focus ring, link colors). The base theme + AntApp wrap higher
// up in `main.tsx`.
//
// `?session=<id>` in the URL is the deep-link handle — opening a session
// from the Sessions tab (W4) navigates here with the param set; sending
// a fresh message updates the URL to the server-assigned id so refresh
// stays on the same conversation.

export function Chat() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionParam = searchParams.get('session') ?? undefined;
  const { id: personalityId, model, isLoading, setOverride } = useActivePersonality();
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

  // Restore last session on first mount when no `?session=` is in the URL.
  // Lives at the page level (not inside useChat) because it interacts with
  // routing — restoring means navigating, which is a Chat-page concern.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberately mount-only — once we know there's no URL param we look up storage exactly once
  useEffect(() => {
    if (sessionParam) return;
    const stored = getLastSessionId();
    if (stored) setSearchParams({ session: stored }, { replace: true });
  }, []);

  // Mirror every URL session change into localStorage so a refresh after
  // landing here from the Sessions tab (or a deep-link paste) sticks.
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
    setOverride(null);
    if (sessionParam && sessionParam !== currentSessionId) {
      switchSession(sessionParam);
    } else if (!sessionParam && currentSessionId) {
      resetSession();
      clearLastSessionId();
    }
  }, [sessionParam]);

  // Restore the personality that was last used with this session.
  // biome-ignore lint/correctness/useExhaustiveDependencies: setOverride is a stable useState setter
  useEffect(() => {
    const stored = sessionQuery.data?.session.personalityId;
    if (stored) setOverride(stored);
  }, [sessionQuery.data?.session.personalityId]);

  // Consume `?personality=<id>` deep-links from the command palette.
  // Sets the per-session override and strips the param so Back doesn't
  // re-trigger the switch. The override state owns this flow — we
  // intentionally don't fork the session here because the user picked
  // the personality from the palette before sending anything; if they
  // *had* an active conversation, the bar's switcher is the right path
  // (it forks). Treat the deep-link as a "configure-then-chat" intent.
  const personalityParam = searchParams.get('personality');
  const newSessionParam = searchParams.get('new');
  // biome-ignore lint/correctness/useExhaustiveDependencies: resetSession/clearLastSessionId are stable; deps intentionally key on the params only
  useEffect(() => {
    if (!personalityParam) return;
    setOverride(personalityParam);
    if (newSessionParam === '1') {
      // New Session flow: start fresh under the chosen personality.
      resetSession();
      clearLastSessionId();
    }
    const next = new URLSearchParams(searchParams);
    next.delete('personality');
    next.delete('new');
    setSearchParams(next, { replace: true });
  }, [personalityParam, newSessionParam, searchParams, setSearchParams, setOverride]);

  // Periodically re-render while streaming so the stall indicator can
  // compare lastStreamEventAt to the current wall clock.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!state.isStreaming) return;
    const id = setInterval(() => setTick((n) => n + 1), 5_000);
    return () => clearInterval(id);
  }, [state.isStreaming]);

  const isStalled =
    state.isStreaming &&
    state.lastStreamEventAt !== null &&
    Date.now() - state.lastStreamEventAt > 30_000;

  const [pendingAttachments, setPendingAttachments] = useState<AttachmentPreview[]>([]);

  // Suggestion pills (empty state + `recommend_actions` cards) fill the
  // composer draft. `seq` makes a repeat pick a distinct event.
  const [suggestion, setSuggestion] = useState<{ text: string; seq: number } | undefined>();
  const handleSuggestPrompt = useCallback((text: string) => {
    setSuggestion((prev) => ({ text, seq: (prev?.seq ?? 0) + 1 }));
  }, []);

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
  const pendingClarify = state.pendingClarifies[0];

  // Talk-mode (Phase B). The call affordance is gated on the active
  // personality's toolset (§3(e)) — voice availability is a personality
  // capability, not a config field. The live-call client is injected — this page
  // supplies `createTalkModeClient` below (see features/voice/README.md), which
  // picks the realtime or pipeline tier at call time.
  const personalityQuery = usePersonalityGet(personalityId);
  const canTalk = personalityCanTalk(personalityQuery.data?.personality.toolset);

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
        // Reuse the existing chat send + stream so the spoken turn shares the
        // active chat session (same personality, same persisted history).
        runAgentTurn: (text, signal) =>
          runVoiceAgentTurn(text, signal, {
            sessionId: () => sessionIdRef.current,
            sendMessage,
            abortTurn,
          }),
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
      sendMessage,
      abortTurn,
      personalityId,
    ],
  );

  const voice = useVoiceCall({ createClient: createVoiceClient });
  const inCall = voice.status !== 'idle' && voice.status !== 'ended';

  // The call overlay (DESIGN.md § "Call overlay"). It opens with the call and
  // MINIMIZES to the strip — dismissing it never hangs up, because the strip
  // below it is what keeps the composer honest while a call is reconnecting.
  const [overlayOpen, setOverlayOpen] = useState(true);
  useEffect(() => {
    if (inCall) setOverlayOpen(true);
  }, [inCall]);
  const callVisual = callOverlayVisual(voice.status);
  const callAccent = resolveCallAccent(configQuery.data?.callAccent, personalityId);
  const callProviderLabel = providerSummary({
    status: voice.status,
    sttProvider: voice.sttProvider ?? configQuery.data?.voiceProvider ?? null,
    sttModel: configQuery.data?.voiceModel ?? null,
    ttsProvider: voice.ttsProvider ?? configQuery.data?.voiceTtsProvider ?? null,
    ttsModel: configQuery.data?.voiceTtsModel ?? null,
    realtimeProvider: realtimeRan?.provider ?? null,
    realtimeModel: realtimeRan?.model ?? null,
  });
  // The overlay is mounted by the CALL, not by the drawn state: connecting and
  // reconnecting render INSIDE it (see `callOverlayVisual`), because unmounting
  // for a transient status restarts the enter animation and the canvas, and that
  // reads as the dialog closing and reopening mid-sentence. Degraded / mic-denied
  // still hand over to the strip — that is where the explanation lives.
  // `available` and `visible` differ only in the minimize, so the strip offers to
  // restore an overlay exactly when there is one to restore.
  const overlayMount = {
    status: voice.status,
    degraded: voice.degraded !== null,
    micDenied: voice.micDenied,
  };
  const overlayAvailable = callOverlayMounted({ ...overlayMount, minimized: false });
  const overlayVisible = callOverlayMounted({ ...overlayMount, minimized: !overlayOpen });

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

  const handleSwitchPersonality = async (newId: string) => {
    // No-op: same personality clicked.
    if (newId === personalityId) return;

    // Empty session — no fork needed; the next chat.send creates a fresh
    // session under the new personality.
    if (!currentSessionId || state.messages.length === 0) {
      setOverride(newId);
      return;
    }

    // Active conversation — auto-fork per DESIGN.md to avoid tool-history
    // mismatch when the new personality's toolset doesn't cover the prior
    // calls. Old session stays available in Sessions tab; fork starts
    // clean (well, with the same history copied) under the new accent.
    try {
      const result = await rpc.sessions.fork({ id: currentSessionId, personalityId: newId });
      switchSession(result.session.id);
      setSearchParams({ session: result.session.id }, { replace: true });
      setLastSessionId(result.session.id);
      setOverride(newId);
      notification.info({
        message: `Forked to ${capitalize(newId)}`,
        description: 'Previous conversation is in the Sessions tab.',
        placement: 'topRight',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notification.error({
        message: 'Could not fork session',
        description: message,
        placement: 'topRight',
      });
    }
  };

  const handleNewSession = () => {
    openNewSessionModal();
  };

  return (
    <ConfigProvider theme={personalityTheme(personalityId)}>
      <div className="chat-tab">
        <PersonalityBar
          personalityId={personalityId}
          model={isLoading ? '' : model}
          onSwitchPersonality={(id) => void handleSwitchPersonality(id)}
          onNewSession={handleNewSession}
          sessionTitle={sessionTitle}
          onRenameSession={handleRenameSession}
          actionsSlot={
            <TalkModeToggle
              canTalk={canTalk}
              personalityName={capitalize(personalityId)}
              inCall={inCall}
              onToggle={handleTalkToggle}
            />
          }
        />
        {/* Not `inCall`: a finished call can still be the only thing on screen
            explaining why it finished. `callStripVisible` owns that rule.
            `!overlayVisible` is the minimize relationship: the strip is what the
            overlay minimizes TO, so the two are never up together. Nothing is
            lost by the gate — every state the strip alone can explain (degraded,
            mic-denied, ended) already forces `overlayVisible` false, and the
            transient ones the overlay now carries itself. */}
        {callStripVisible(voice) && !overlayVisible ? (
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
            {...(overlayAvailable && !overlayOpen ? { onExpand: () => setOverlayOpen(true) } : {})}
          />
        ) : null}
        {overlayVisible ? (
          <CallOverlay
            state={callVisual}
            treatment={configQuery.data?.callStyle ?? 'liquid'}
            accent={callAccent}
            personalityId={personalityId}
            personalityName={capitalize(personalityId)}
            micLevels={voice.micLevels}
            agentLevel={voice.agentLevel}
            statusLabel={STATUS_LABEL[voice.status]}
            providerLabel={callProviderLabel}
            muted={voice.muted}
            onToggleMute={voice.toggleMute}
            onMinimize={() => setOverlayOpen(false)}
            onHangUp={voice.hangUp}
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
        <MessageList
          messages={messages}
          currentTurn={state.currentTurn}
          personalityId={personalityId}
          model={model}
          sessionId={currentSessionId ?? undefined}
          onSuggestPrompt={handleSuggestPrompt}
          {...(canTalk && !inCall ? { onTryVoice: handleTalkToggle } : {})}
        />
        <TurnStatusBar
          isStreaming={state.isStreaming}
          currentOp={state.currentOp}
          elapsedMs={elapsedMs}
        />
        <div>
          {state.error ? (
            <div className="chat-error" role="alert">
              {state.error}
            </div>
          ) : null}
          {isStalled ? (
            <div className="chat-stall-notice" role="status">
              Still working — this is taking longer than usual…
            </div>
          ) : null}
          <Composer
            personalityId={personalityId}
            disabled={false}
            onSend={handleSend}
            placeholder={state.isStreaming ? 'Steer the agent…' : 'Send a message…'}
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
    </ConfigProvider>
  );
}

function capitalize(s: string): string {
  return s ? s[0]?.toUpperCase() + s.slice(1) : '';
}
