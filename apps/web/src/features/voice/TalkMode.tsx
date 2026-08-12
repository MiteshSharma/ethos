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
// idle (the strip is absent), connecting, listening, thinking, agent speaking,
// barge-in acknowledged, reconnecting, degraded-to-text, and mic-permission
// denied. The last two collapse the strip into an inline notice — the
// conversation continues in text either way, so the strip gets out of the way
// rather than sitting there broken.

/** Geist Mono state word, in the connection-dot vocabulary. Lowercase mono. */
const STATUS_LABEL: Record<VoiceCallStatus, string> = {
  idle: '',
  connecting: 'connecting',
  reconnecting: 'reconnecting…',
  listening: 'listening',
  thinking: 'thinking',
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
  /** Voice fell back to text — the strip collapses to a dismissible notice. */
  degraded?: VoiceDegradedNotice | null;
  /** The browser refused the mic — guidance, never a dead mic icon. */
  micDenied?: boolean;
  onDismissNotice?: () => void;
  /** Providers + models that ACTUALLY served this call, for the mono labels. */
  sttProvider?: string | null;
  sttModel?: string | null;
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
  degraded,
  micDenied,
  onDismissNotice,
  sttProvider,
  sttModel,
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

  const summary = providerSummary({ status, sttProvider, sttModel, ttsProvider, ttsModel });
  const totalMs = latency?.totalMs ?? null;

  return (
    <section className="talk-call-bar" aria-label="Voice call controls">
      <div className="talk-call-row">
        <SpeakingIndicator status={status} micLevels={micLevels} muted={muted} />
        <span className="talk-status-label" role="status">
          {error ?? STATUS_LABEL[status]}
        </span>
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
          {sttProvider ? <span>{label('stt', sttProvider, sttModel)}</span> : null}
          {ttsProvider ? <span>{label('tts', ttsProvider, ttsModel)}</span> : null}
          <span>llm {formatMs(latency?.llmMs)}</span>
          <span>audio {formatMs(latency?.ttsMs)}</span>
          <span>total {formatMs(latency?.totalMs)}</span>
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
}): string {
  const speaking = opts.status === 'agent_speaking' || opts.status === 'interrupted';
  if (speaking && opts.ttsProvider) {
    return opts.ttsModel ? `${opts.ttsProvider} · ${opts.ttsModel}` : opts.ttsProvider;
  }
  if (opts.sttProvider) {
    return opts.sttModel ? `${opts.sttProvider} · ${opts.sttModel}` : opts.sttProvider;
  }
  return '';
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
  // Thinking — the accent dot STEADY: the personality has the floor but is not
  // yet talking. Speaking — the same dot, pulsing.
  if (status === 'thinking' || status === 'agent_speaking' || status === 'interrupted') {
    const speaking = status !== 'thinking';
    return (
      <div
        className={`talk-indicator${status === 'interrupted' ? ' talk-indicator-flash' : ''}`}
        role="img"
        aria-label={speaking ? 'Agent is speaking' : 'Agent is thinking'}
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
