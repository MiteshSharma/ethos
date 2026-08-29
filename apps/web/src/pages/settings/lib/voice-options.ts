// Voice option tables and the "empty select → null" coercions the patch builder
// uses. Moved verbatim out of `Settings.tsx` (Phase 1). No form dependency, so
// both the voice pane and `buildConfigPatch` can read them.

export const AUDIO_FORMATS = ['opus', 'mp3', 'wav', 'pcm'] as const;
export const VOICE_MODES = ['off', 'mirror_inbound', 'all'] as const;
export const VOICE_TIERS = ['pipeline', 'realtime'] as const;

/** Empty select → null, which clears the key back to its built-in default. */
export function audioFormatOrNull(value: string): (typeof AUDIO_FORMATS)[number] | null {
  return AUDIO_FORMATS.find((f) => f === value) ?? null;
}

export function voiceModeOrNull(value: string): (typeof VOICE_MODES)[number] | null {
  return VOICE_MODES.find((m) => m === value) ?? null;
}

export function voiceTierOrNull(value: string): (typeof VOICE_TIERS)[number] | null {
  return VOICE_TIERS.find((t) => t === value) ?? null;
}

/**
 * Channels that can carry a `voice.channels.<platform>.ttsOut` override — the
 * ones with an adapter able to act on it. Mirrors `VOICE_CHANNEL_PLATFORMS` in
 * `@ethosagent/config`, which the browser cannot import (node-only package);
 * an id outside the list is dropped server-side either way.
 */
export const VOICE_CHANNELS = ['telegram', 'slack', 'discord', 'whatsapp', 'email'] as const;

export const VOICE_CHANNEL_LABELS: Record<(typeof VOICE_CHANNELS)[number], string> = {
  telegram: 'Telegram',
  slack: 'Slack',
  discord: 'Discord',
  whatsapp: 'WhatsApp',
  email: 'Email',
};

/**
 * Per-channel TTS-out, hydrated for the switch row.
 *
 * Only `false` is load-bearing in the gateway (`channelVoiceOut[platform] ===
 * false` silences the channel outright); `true` and "absent" behave the same,
 * which is what lets a binary switch stand in for a tri-state key. On = the
 * channel follows the conversation's own mode.
 */
export function voiceChannelTtsOutFromConfig(
  map: Record<string, boolean>,
): Record<string, boolean> {
  return Object.fromEntries(VOICE_CHANNELS.map((c) => [c, map[c] !== false]));
}

/**
 * The inverse. Only the silenced channels are written, so a channel switched
 * back on returns to inheriting rather than carrying a redundant `true` in
 * config.yaml. `config.update` replaces the whole map, so omission IS the
 * clear.
 */
export function voiceChannelTtsOutPatch(form: Record<string, boolean>): Record<string, boolean> {
  return Object.fromEntries(VOICE_CHANNELS.filter((c) => form[c] === false).map((c) => [c, false]));
}

/**
 * Call-overlay color presets: the personality default plus DESIGN.md's five
 * personality accents. Anything else is a hand-entered hex.
 */
export const CALL_ACCENT_PRESETS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'personality', label: 'Personality — follow the active agent' },
  { value: '#4A9EFF', label: 'Researcher blue · #4A9EFF' },
  { value: '#4ADE80', label: 'Engineer green · #4ADE80' },
  { value: '#F59E0B', label: 'Reviewer amber · #F59E0B' },
  { value: '#E879F9', label: 'Coach magenta · #E879F9' },
  { value: '#94A3B8', label: 'Operator grey · #94A3B8' },
];

export const CALL_ACCENT_CUSTOM = 'custom';

export function isCallAccentPreset(value: string): boolean {
  return CALL_ACCENT_PRESETS.some((preset) => preset.value === value);
}

export const CALL_STYLE_OPTIONS = [
  { value: 'personality', label: 'Personality — each agent draws its own shape' },
  { value: 'liquid', label: 'Liquid — the circle fills as it speaks' },
  { value: 'orb', label: 'Orb — a body that deforms with the voice' },
  { value: 'rings', label: 'Rings — concentric rings breathing outward' },
];
