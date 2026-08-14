import { DEFAULT_VOICE_MODE, VOICE_MODES, type VoiceMode } from '@ethosagent/types';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Segmented, Tooltip } from 'antd';
import { rpc } from '../../rpc';

// The per-conversation voice-mode control in the chat header (voice-V2's UI
// visibility rule: the mode must be readable and editable here, not only
// through the `/voice` slash command).
//
// A SEGMENTED control, not a cycling button and not a dropdown: the plan's
// interaction table asks for "three states visible — `off` / `mirror_inbound` /
// `all`, mono labels". A dropdown shows one of the three and hides the rest
// behind a click; a button that cycles makes the user press it to find out what
// it does. Both are wrong for a persisted state whose whole job is to be READ
// at a glance. `Segmented` is already this app's vocabulary for a small
// mutually-exclusive choice (Cron, Communications, Personalities), so nothing
// new is introduced.
//
// The state words themselves are the config values, in Geist Mono — the same
// "name the thing exactly" rule as the `{provider} · {model}` labels beside
// them. They are not prettified into sentences, because `/voice mirror_inbound`
// is what the user types elsewhere for the same fact.

/**
 * What the header should draw right now.
 *
 * `inherited` is an INFERENCE, and deliberately so: `voice.laneMode.get`
 * returns the lane's effective mode plus the deployment default, with no third
 * "has an override" flag. When the two are equal the honest thing to say is
 * "this is the deployment default", which is true whether the lane never chose
 * or chose that same value — and false-looking only in a case the user cannot
 * observe. When they differ, the lane definitely chose.
 */
export interface VoiceModeView {
  mode: VoiceMode;
  /** The shown mode is the deployment default, not a choice this lane made. */
  inherited: boolean;
  /** Nothing to write to yet — no session, or the read is still in flight. */
  disabled: boolean;
  /** One concrete sentence: tooltip and accessible description. */
  hint: string;
}

export function voiceModeView(args: {
  sessionId: string | null;
  data: { mode: VoiceMode; default: VoiceMode } | undefined;
}): VoiceModeView {
  if (!args.sessionId) {
    return {
      mode: DEFAULT_VOICE_MODE,
      inherited: true,
      disabled: true,
      hint: 'A voice mode belongs to a conversation — send a message to start one, then set it here.',
    };
  }
  if (!args.data) {
    return {
      mode: DEFAULT_VOICE_MODE,
      inherited: true,
      disabled: true,
      hint: 'Reading this conversation’s voice mode…',
    };
  }
  const inherited = args.data.mode === args.data.default;
  return {
    mode: args.data.mode,
    inherited,
    disabled: false,
    hint: inherited
      ? `Following the deployment default, ${args.data.default}. Pick a mode to set one for this conversation alone.`
      : `Set for this conversation. The deployment default is ${args.data.default}.`,
  };
}

export interface VoiceModeControlProps {
  view: VoiceModeView;
  onChange: (mode: VoiceMode) => void;
  /** A write is in flight — held until the server agrees. */
  pending?: boolean;
}

/**
 * The control itself. Hook-free and prop-driven so the header's markup can be
 * asserted without a query client or a DOM — same precedent as
 * `callDetailItems` in `TalkMode.tsx`.
 */
export function VoiceModeControl({ view, onChange, pending }: VoiceModeControlProps) {
  return (
    <Tooltip title={view.hint}>
      {/* A `fieldset` rather than a `div role="group"`: same grouping, native
          semantics. Its chrome is reset in `styles.css`. */}
      <fieldset
        className={`voice-mode-toggle${view.inherited ? ' voice-mode-toggle-inherited' : ''}`}
        aria-label={`Voice replies in this conversation — ${view.mode}. ${view.hint}`}
      >
        {/* An inherited value is said in WORDS, not only drawn dimmer: colour
            and opacity alone cannot carry "nobody chose this". */}
        <span className="voice-mode-caption">{view.inherited ? 'voice · default' : 'voice'}</span>
        <Segmented<VoiceMode>
          size="small"
          disabled={view.disabled || Boolean(pending)}
          value={view.mode}
          onChange={onChange}
          options={VOICE_MODES.map((mode) => ({
            value: mode,
            label: <span className="voice-mode-opt">{mode}</span>,
          }))}
        />
      </fieldset>
    </Tooltip>
  );
}

/**
 * The header's control, bound to the durable lane mode. The mode is SHARED with
 * the gateway's channel lanes, so what is set here is the same fact `/voice`
 * sets on Telegram or Slack.
 */
export function VoiceModeToggle({ sessionId }: { sessionId: string | null }) {
  const queryClient = useQueryClient();
  const laneMode = useQuery({
    queryKey: ['voice', 'laneMode', sessionId],
    // Gated on `enabled` — a fresh chat has no lane to read, and asking for one
    // with an empty id is a request the contract's `min(1)` would reject.
    queryFn: () => rpc.voice.laneMode.get({ sessionId: sessionId ?? '' }),
    enabled: Boolean(sessionId),
  });
  const setMode = useMutation({
    mutationFn: (mode: VoiceMode) => rpc.voice.laneMode.set({ sessionId: sessionId ?? '', mode }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['voice', 'laneMode', sessionId] });
    },
  });

  return (
    <VoiceModeControl
      view={voiceModeView({ sessionId, data: laneMode.data })}
      pending={setMode.isPending}
      onChange={(mode) => setMode.mutate(mode)}
    />
  );
}
