import { Tooltip } from 'antd';
import { useState } from 'react';
import { AudioBars } from '../../components/chat/VoiceButton';
import type { VoiceTurnLatency } from './useVoiceCall';
import type { VoiceCallStatus, VoiceDegradedNotice } from './voice-call-reducer';

// Talk-mode UI — the CallStrip (DESIGN.md § "In-call speaking indicator", plan
// DR1/DR3). A slim strip on the existing Chat surface; no new full-screen
// surface and no `Card` primitive, honoring "cards earn existence". Rows, not
// cards; existing tokens and the `status-dot-pulse` keyframe, no new color or
// motion primitives.
//
// The nine interaction states of DR1 are all rendered from one component:
// idle (the strip is absent), connecting, listening, thinking/consulting, agent
// speaking, barge-in acknowledged, reconnecting, degraded-to-text, and
// mic-permission denied. The last two collapse the strip into an inline notice
// — the conversation continues in text either way, so the strip gets out of the
// way rather than sitting there broken.
//
// `thinking` and `consulting` are one DR1 row (the accent dot steady) and two
// state words: both mean "the agent has the floor and is not talking", and the
// word is the only thing that says whether it is composing a reply or off
// checking something.

/** Geist Mono state word, in the connection-dot vocabulary. Lowercase mono. */
const STATUS_LABEL: Record<VoiceCallStatus, string> = {
  idle: '',
  connecting: 'connecting',
  reconnecting: 'reconnecting…',
  listening: 'listening',
  thinking: 'thinking',
  consulting: 'consulting',
  agent_speaking: 'speaking',
  interrupted: 'interrupted — go ahead',
  ended: 'call ended',
};

export interface TalkModeToggleProps {
  /** §3(e) gate — the active personality's toolset enables voice. */
  canTalk: boolean;
  personalityName: string;
  inCall: boolean;
  onToggle: () => void;
}

/** The phone affordance in the personality bar. Disabled + explained when the
 *  personality's toolset does not enable voice (§3(e)). */
export function TalkModeToggle({
  canTalk,
  personalityName,
  inCall,
  onToggle,
}: TalkModeToggleProps) {
  const tip = canTalk
    ? inCall
      ? 'In call'
      : `Talk to ${personalityName}`
    : `Voice not enabled for ${personalityName} — add the voice_session capability to its toolset`;

  return (
    <Tooltip title={tip}>
      <button
        type="button"
        className={`talk-toggle-btn${inCall ? ' talk-toggle-active' : ''}`}
        onClick={onToggle}
        disabled={!canTalk || inCall}
        aria-label={tip}
        aria-pressed={inCall}
      >
        <PhoneIcon />
      </button>
    </Tooltip>
  );
}

export interface TalkModeCallBarProps {
  status: VoiceCallStatus;
  micLevels: number[];
  muted: boolean;
  error: string | null;
  onToggleMute: () => void;
  onHangUp: () => void;
  /** Live caption of what the agent is saying right now. */
  caption?: string | null;
  /**
   * The call reached its spending limit: the caption is the spoken sign-off and
   * this puts a `budget reached` mono chip beside it (DR1 "★ Budget wind-down").
   * A chip in the existing label vocabulary — never a badge, never a banner.
   */
  windDown?: string | null;
  /** Voice fell back to text — the strip collapses to a dismissible notice. */
  degraded?: VoiceDegradedNotice | null;
  /**
   * Voice WORKS but not on the configured tier (realtime was refused or
   * unavailable). Renders as a dismissible line ABOVE a live strip, because the
   * call is still going — unlike `degraded`, which replaces the strip.
   */
  notice?: string | null;
  /** Which tier is serving this call, for the mono detail label. */
  tier?: 'pipeline' | 'realtime' | null;
  /** True while the user has explicitly chosen the private/offline pipeline. */
  privateMode?: boolean;
  /**
   * Choose the private/offline pipeline for this conversation. Offered only
   * while the realtime tier is running — the pipeline IS the private mode, so
   * there is nothing to offer once it is already what is serving.
   */
  onUsePrivateMode?: () => void;
  /**
   * Undo that choice. Offered only while the choice is in effect: on a call
   * that landed on the pipeline because realtime was REFUSED, a "use realtime"
   * control would be a button that cannot work.
   */
  onLeavePrivateMode?: () => void;
  /** The browser refused the mic — guidance, never a dead mic icon. */
  micDenied?: boolean;
  onDismissNotice?: () => void;
  /** Providers + models that ACTUALLY served this call, for the mono labels. */
  sttProvider?: string | null;
  sttModel?: string | null;
  /**
   * The realtime provider and model actually serving this call. Known exactly
   * (the mint answered with both), unlike the pipeline tier's model, which the
   * page still reads from the deployment default.
   */
  realtimeProvider?: string | null;
  realtimeModel?: string | null;
  ttsProvider?: string | null;
  ttsModel?: string | null;
  latency?: VoiceTurnLatency;
}

/**
 * The CallStrip. One slim row: speaking indicator, state, live caption, the
 * mono `{provider} · {model}` label, mute and hang-up.
 */
export function TalkModeCallBar({
  status,
  micLevels,
  muted,
  error,
  onToggleMute,
  onHangUp,
  caption,
  windDown,
  degraded,
  notice,
  tier,
  privateMode,
  onUsePrivateMode,
  onLeavePrivateMode,
  micDenied,
  onDismissNotice,
  sttProvider,
  sttModel,
  realtimeProvider,
  realtimeModel,
  ttsProvider,
  ttsModel,
  latency,
}: TalkModeCallBarProps) {
  const [detailOpen, setDetailOpen] = useState(false);

  // Degraded / mic-denied replace the strip: there is nothing to control, and
  // the honest thing to render is what happened and what to do next.
  if (degraded) {
    return (
      <InlineNotice
        className="talk-notice-degraded"
        text={`Voice unavailable — ${degraded.provider ? `provider ${degraded.provider} failed` : 'the voice provider failed'}; continuing in text.`}
        onDismiss={onDismissNotice}
      />
    );
  }
  if (micDenied) {
    return (
      <InlineNotice
        className="talk-notice-mic"
        text={
          error ??
          'Ethos needs your microphone to talk. Allow it in your browser’s site settings, then start the call again.'
        }
        onDismiss={onDismissNotice}
      />
    );
  }

  const summary = providerSummary({
    status,
    sttProvider,
    sttModel,
    ttsProvider,
    ttsModel,
    realtimeProvider,
    realtimeModel,
  });
  const totalMs = latency?.totalMs ?? null;

  return (
    <section className="talk-call-bar" aria-label="Voice call controls">
      {/* The tier fell back. The call is LIVE underneath, so this is a line
          above the strip rather than the strip collapsing into it. */}
      {notice ? (
        <InlineNotice className="talk-notice-tier" text={notice} onDismiss={onDismissNotice} />
      ) : null}
      <div className="talk-call-row">
        <SpeakingIndicator status={status} micLevels={micLevels} muted={muted} />
        <span className="talk-status-label" role="status">
          {error ?? STATUS_LABEL[status]}
        </span>
        {windDown ? <span className="talk-mono talk-budget-chip">budget reached</span> : null}
        {caption ? (
          <span className="talk-caption" aria-live="polite">
            {caption}
          </span>
        ) : null}
        <div className="talk-call-actions">
          {summary || totalMs !== null ? (
            <button
              type="button"
              className="talk-btn talk-detail-btn"
              onClick={() => setDetailOpen((open) => !open)}
              aria-expanded={detailOpen}
              aria-label="Voice turn detail"
            >
              <span className="talk-mono">{summary}</span>
              {totalMs !== null ? (
                <span className="talk-mono talk-latency">{totalMs}ms</span>
              ) : null}
              {!summary && totalMs === null ? <span className="talk-mono">·</span> : null}
            </button>
          ) : null}
          <button
            type="button"
            className={`talk-btn${muted ? ' talk-btn-active' : ''}`}
            onClick={onToggleMute}
            aria-pressed={muted}
            aria-label={muted ? 'Unmute microphone' : 'Mute microphone'}
          >
            {muted ? <MicOffIcon /> : <MicIcon />}
          </button>
          <button
            type="button"
            className="talk-btn talk-hangup-btn"
            onClick={onHangUp}
            aria-label="End call"
          >
            <PhoneDownIcon />
          </button>
        </div>
      </div>
      {detailOpen ? (
        <div className="talk-call-detail talk-mono">
          {callDetailItems({
            tier,
            realtimeProvider,
            realtimeModel,
            sttProvider,
            sttModel,
            ttsProvider,
            ttsModel,
            latency,
          }).map((item) => (
            <span key={item}>{item}</span>
          ))}
          {/* The private/offline mode IS the pipeline tier, so it is only worth
              offering while something else is serving — and only worth undoing
              while the user's own choice is what is holding the call there. */}
          {privateMode && onLeavePrivateMode ? (
            <button
              type="button"
              className="talk-mono talk-private-btn"
              onClick={onLeavePrivateMode}
            >
              leave private mode
            </button>
          ) : tier === 'realtime' && onUsePrivateMode ? (
            <button type="button" className="talk-mono talk-private-btn" onClick={onUsePrivateMode}>
              use private mode
            </button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/**
 * The inline notice the strip collapses into. A row with a dismiss control —
 * not a Card, not a modal: chat keeps working underneath it.
 */
function InlineNotice({
  className,
  text,
  onDismiss,
}: {
  className: string;
  text: string;
  onDismiss?: (() => void) | undefined;
}) {
  return (
    <section className={`talk-inline-notice ${className}`} role="status">
      <span className="talk-notice-text">{text}</span>
      {onDismiss ? (
        <button type="button" className="talk-btn" onClick={onDismiss} aria-label="Dismiss">
          <CloseIcon />
        </button>
      ) : null}
    </section>
  );
}

/**
 * The expandable detail row's mono labels, in order.
 *
 * Pure and exported so the label vocabulary is testable without a DOM: the row
 * only exists while the toggle is open, and a `renderToStaticMarkup` harness
 * always renders it closed.
 */
export function callDetailItems(opts: {
  tier?: 'pipeline' | 'realtime' | null;
  realtimeProvider?: string | null;
  realtimeModel?: string | null;
  sttProvider?: string | null;
  sttModel?: string | null;
  ttsProvider?: string | null;
  ttsModel?: string | null;
  latency?: VoiceTurnLatency | undefined;
}): string[] {
  return [
    // Which engine is talking, in the same mono label vocabulary as the
    // providers beside it — never a badge, never a debug panel.
    ...(opts.tier ? [`tier ${opts.tier}`] : []),
    ...(opts.realtimeProvider
      ? [label('realtime', opts.realtimeProvider, opts.realtimeModel)]
      : []),
    ...(opts.sttProvider ? [label('stt', opts.sttProvider, opts.sttModel)] : []),
    ...(opts.ttsProvider ? [label('tts', opts.ttsProvider, opts.ttsModel)] : []),
    `llm ${formatMs(opts.latency?.llmMs)}`,
    `audio ${formatMs(opts.latency?.ttsMs)}`,
    `total ${formatMs(opts.latency?.totalMs)}`,
  ];
}

/** `{provider} · {model}` in the existing vocabulary — never a badge. */
function label(kind: string, provider: string, model: string | null | undefined): string {
  return model ? `${kind} ${provider} · ${model}` : `${kind} ${provider}`;
}

function formatMs(ms: number | null | undefined): string {
  return ms === null || ms === undefined ? '—' : `${ms}ms`;
}

/** Which provider is worth naming right now: the one currently doing the work. */
function providerSummary(opts: {
  status: VoiceCallStatus;
  sttProvider?: string | null;
  sttModel?: string | null;
  ttsProvider?: string | null;
  ttsModel?: string | null;
  realtimeProvider?: string | null;
  realtimeModel?: string | null;
}): string {
  // On the realtime tier ONE provider both hears and speaks, so there is no
  // listening/speaking split to pick between.
  if (opts.realtimeProvider) {
    return opts.realtimeModel
      ? `${opts.realtimeProvider} · ${opts.realtimeModel}`
      : opts.realtimeProvider;
  }
  const speaking = opts.status === 'agent_speaking' || opts.status === 'interrupted';
  if (speaking && opts.ttsProvider) {
    return opts.ttsModel ? `${opts.ttsProvider} · ${opts.ttsModel}` : opts.ttsProvider;
  }
  if (opts.sttProvider) {
    return opts.sttModel ? `${opts.sttProvider} · ${opts.sttModel}` : opts.sttProvider;
  }
  return '';
}

/** Screen-reader wording for the accent dot's three meanings. */
function agentActivityLabel(status: VoiceCallStatus): string {
  if (status === 'consulting') return 'Agent is checking something';
  if (status === 'thinking') return 'Agent is thinking';
  return 'Agent is speaking';
}

function SpeakingIndicator({
  status,
  micLevels,
  muted,
}: {
  status: VoiceCallStatus;
  micLevels: number[];
  muted: boolean;
}) {
  // Connecting / reconnecting — amber dot, the connection-dot vocabulary.
  if (status === 'connecting' || status === 'reconnecting') {
    return (
      <div className="talk-indicator" role="img" aria-label={STATUS_LABEL[status]}>
        <span className="talk-link-pulse" />
      </div>
    );
  }
  // Thinking / consulting — the accent dot STEADY: the personality has the
  // floor but is not talking. Speaking — the same dot, pulsing. A consult is
  // the steady one even while its filler line is being said, because what the
  // listener is waiting through is the round trip, not the sentence.
  if (
    status === 'thinking' ||
    status === 'consulting' ||
    status === 'agent_speaking' ||
    status === 'interrupted'
  ) {
    const speaking = status === 'agent_speaking' || status === 'interrupted';
    return (
      <div
        className={`talk-indicator${status === 'interrupted' ? ' talk-indicator-flash' : ''}`}
        role="img"
        aria-label={agentActivityLabel(status)}
      >
        <span className={`talk-agent-dot${speaking ? ' talk-agent-pulse' : ''}`} />
      </div>
    );
  }
  // Listening — the live mic meter (red AudioBars). Muted renders flat.
  return (
    <div className={`talk-indicator${muted ? ' talk-indicator-muted' : ''}`}>
      <AudioBars levels={micLevels} />
    </div>
  );
}

function CloseIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      aria-hidden="true"
    >
      <path d="M4 4l8 8M12 4l-8 8" />
    </svg>
  );
}

function PhoneIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 3.5c0 5.25 4.25 9.5 9.5 9.5 .55 0 1-.45 1-1v-1.8a1 1 0 0 0-.76-.97l-2.1-.53a1 1 0 0 0-1 .35l-.5.63A7.5 7.5 0 0 1 5.3 5.86l.63-.5a1 1 0 0 0 .35-1L5.75 2.26A1 1 0 0 0 4.78 1.5H3c-.55 0-1 .45-1 1z" />
    </svg>
  );
}

function PhoneDownIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 9.5c3.6-3.6 9.4-3.6 13 0l-1.6 1.6a1 1 0 0 1-1.2.16l-1.5-.85a1 1 0 0 1-.5-.87V8.3a7.7 7.7 0 0 0-3.4 0v1.24a1 1 0 0 1-.5.87l-1.5.85a1 1 0 0 1-1.2-.16z" />
    </svg>
  );
}

/**
 * Talk-mode entry glyph for the composer card (DR2): a mic with speech arcs, so
 * it reads as "converse", not as the dictation mic beside it. Same vocabulary as
 * the sidebar icons — 16px, stroke, `strokeWidth 1.5`, no fill.
 */
export function TalkMicIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="5.25" y="1.75" width="3.5" height="7" rx="1.75" />
      <path d="M3.5 7.5a3.5 3.5 0 0 0 7 0" />
      <path d="M7 12v2.25" />
      <path d="M12.5 4.5a4.5 4.5 0 0 1 0 5" />
    </svg>
  );
}

function MicIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="6" y="2" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 8a4 4 0 0 0 8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line
        x1="8"
        y1="13"
        x2="8"
        y2="15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}

function MicOffIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="6" y="2" width="4" height="8" rx="2" stroke="currentColor" strokeWidth="1.5" />
      <path d="M4 8a4 4 0 0 0 8 0" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      <line
        x1="8"
        y1="13"
        x2="8"
        y2="15"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <line
        x1="2"
        y1="2"
        x2="14"
        y2="14"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
