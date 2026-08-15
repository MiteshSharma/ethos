// The three named voice rosters (`voice.<stt|tts|realtime>.providers.<name>.*`):
// one row shape, one kind spec, and the config↔row↔patch round trip for each
// kind. Moved verbatim out of `Settings.tsx` (Phase 1).

import {
  COMMAND_STT_EXAMPLE,
  COMMAND_STT_PLACEHOLDERS,
  COMMAND_TTS_EXAMPLE,
  COMMAND_TTS_PLACEHOLDERS,
} from '../../../lib/voice-command-template';
import type {
  ConfigGetData,
  VoiceRealtimeProviderPatch,
  VoiceSttProviderPatch,
  VoiceTtsProviderPatch,
} from './config-types';
import { nextRowId } from './row-id';
import { audioFormatOrNull } from './voice-options';

/**
 * One row of a named voice roster (`voice.<tts|stt|realtime>.providers.<name>.*`).
 * For STT and TTS these are the same fields as the Default provider above them,
 * because a roster entry IS a default entry — the one a personality gets when it
 * names this row instead.
 *
 * ONE row shape serves all three kinds, carrying the union of the field sets;
 * the row component renders only the fields its kind has. Three row types would
 * be three editors, and the whole point of this section is that the ear, the
 * voice and the live session are configured the same way.
 *
 * `apiKey` is the freshly typed key (write-only, blank on load);
 * `apiKeyPreview` is the redacted view of what is stored.
 */
export interface VoiceProviderRow {
  _id: number;
  name: string;
  provider: string;
  model: string;
  apiKey: string;
  apiKeyPreview: string | null;
  /** TTS and realtime. */
  voice: string;
  baseUrl: string;
  /** STT / TTS only. */
  command: string;
  /** TTS only. */
  outputFormat: string;
  /** STT / TTS only. Seconds. */
  timeout: number | null;
  /** TTS only. */
  maxTextLength: number | null;
  /** Realtime only. USD per minute of audio. */
  costPerMinuteUsd: number | null;
}

/** What differs between the three rosters — everything else is shared. */
export interface VoiceRosterKindSpec {
  kind: 'stt' | 'tts' | 'realtime';
  label: string;
  /** Config key the row's name becomes, shown in copy and in the name error. */
  configKey: string;
  /** Heading over the rows. For STT/TTS they are additions to a separate
   *  default entry; for realtime they ARE the entries, one of which the default
   *  select names — so the two cannot share one word. */
  rosterHeading: string;
  blurb: string;
  addLabel: string;
  providerOptions: { label: string; value: string }[];
  /** Provider id whose row renders a command template instead of a base URL.
   *  Absent for a kind with no shell-backed provider (realtime). */
  commandProvider?: string;
  commandPlaceholders?: string;
  commandExample?: string;
  defaultProvider: string;
  modelPlaceholder: string;
  baseUrlPlaceholder: string;
  /** TTS-only controls: default voice, audio format, max text length. */
  audioOutputFields: boolean;
  /** Per-request timeout. Meaningless for a duplex session, so realtime is out. */
  timeoutField: boolean;
  /** Realtime-only: the voice id and the per-minute rate. */
  realtimeFields: boolean;
}

/**
 * config → rows, and rows → patch: one pair per roster kind, at module scope so
 * both directions of the round trip are testable without mounting the form.
 *
 * The `apiKey` rule is the same in all three: blank means "keep the stored key",
 * because the browser is never handed it to type back, so a blank field cannot
 * mean "clear it".
 */
export function voiceTtsProviderRowsFromConfig(
  map: ConfigGetData['voiceTtsProviders'],
): VoiceProviderRow[] {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      _id: nextRowId(),
      name,
      provider: entry.provider,
      model: entry.model ?? '',
      apiKey: '',
      apiKeyPreview: entry.apiKeyPreview,
      voice: entry.voice ?? '',
      baseUrl: entry.baseUrl ?? '',
      command: entry.command ?? '',
      outputFormat: entry.outputFormat ?? '',
      timeout: entry.timeout,
      maxTextLength: entry.maxTextLength,
      costPerMinuteUsd: null,
    }));
}

export function voiceSttProviderRowsFromConfig(
  map: ConfigGetData['voiceSttProviders'],
): VoiceProviderRow[] {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      _id: nextRowId(),
      name,
      provider: entry.provider,
      model: entry.model ?? '',
      apiKey: '',
      apiKeyPreview: entry.apiKeyPreview,
      voice: '',
      baseUrl: entry.baseUrl ?? '',
      command: entry.command ?? '',
      outputFormat: '',
      timeout: entry.timeout,
      maxTextLength: null,
      costPerMinuteUsd: null,
    }));
}

export function voiceRealtimeProviderRowsFromConfig(
  map: ConfigGetData['voiceRealtimeProviders'],
): VoiceProviderRow[] {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, entry]) => ({
      _id: nextRowId(),
      name,
      provider: entry.provider,
      model: entry.model ?? '',
      apiKey: '',
      apiKeyPreview: entry.apiKeyPreview,
      voice: entry.voice ?? '',
      baseUrl: entry.baseUrl ?? '',
      command: '',
      outputFormat: '',
      timeout: null,
      maxTextLength: null,
      costPerMinuteUsd: entry.costPerMinuteUsd,
    }));
}

export function voiceTtsProviderPatchFromRow(row: VoiceProviderRow): VoiceTtsProviderPatch {
  const outputFormat = audioFormatOrNull(row.outputFormat);
  return {
    provider: row.provider,
    ...(row.model.trim() ? { model: row.model.trim() } : {}),
    ...(row.apiKey ? { apiKey: row.apiKey } : {}),
    ...(row.voice.trim() ? { voice: row.voice.trim() } : {}),
    ...(row.baseUrl.trim() ? { baseUrl: row.baseUrl.trim() } : {}),
    ...(row.command.trim() ? { command: row.command.trim() } : {}),
    ...(outputFormat ? { outputFormat } : {}),
    ...(row.timeout ? { timeout: row.timeout } : {}),
    ...(row.maxTextLength ? { maxTextLength: row.maxTextLength } : {}),
  };
}

export function voiceSttProviderPatchFromRow(row: VoiceProviderRow): VoiceSttProviderPatch {
  return {
    provider: row.provider,
    ...(row.model.trim() ? { model: row.model.trim() } : {}),
    ...(row.apiKey ? { apiKey: row.apiKey } : {}),
    ...(row.baseUrl.trim() ? { baseUrl: row.baseUrl.trim() } : {}),
    ...(row.command.trim() ? { command: row.command.trim() } : {}),
    ...(row.timeout ? { timeout: row.timeout } : {}),
  };
}

export function voiceRealtimeProviderPatchFromRow(
  row: VoiceProviderRow,
): VoiceRealtimeProviderPatch {
  return {
    provider: row.provider,
    ...(row.model.trim() ? { model: row.model.trim() } : {}),
    ...(row.apiKey ? { apiKey: row.apiKey } : {}),
    ...(row.baseUrl.trim() ? { baseUrl: row.baseUrl.trim() } : {}),
    ...(row.voice.trim() ? { voice: row.voice.trim() } : {}),
    ...(row.costPerMinuteUsd ? { costPerMinuteUsd: row.costPerMinuteUsd } : {}),
  };
}

/** The provider menus, shared by each kind's Default entry and its roster rows. */
export const STT_PROVIDER_OPTIONS = [
  { label: 'OpenAI Whisper', value: 'openai-stt' },
  { label: 'Groq Whisper (free tier)', value: 'groq-stt' },
  { label: 'Local (Whisper / OpenAI-compatible)', value: 'local-stt' },
  { label: 'Custom command (whisper.cpp / any CLI)', value: 'command-stt' },
];
export const TTS_PROVIDER_OPTIONS = [
  { label: 'OpenAI TTS', value: 'openai-tts' },
  { label: 'Local (Kokoro / OpenAI-compatible)', value: 'local-tts' },
  { label: 'Custom command (macOS say / Piper / any CLI)', value: 'command-tts' },
];
export const REALTIME_PROVIDER_OPTIONS = [
  { label: 'OpenAI Realtime', value: 'openai-realtime' },
  { label: 'Gemini Live', value: 'gemini-live' },
];

export const STT_ROSTER_SPEC: VoiceRosterKindSpec = {
  kind: 'stt',
  label: 'STT',
  configKey: 'voice.stt.providers',
  rosterHeading: 'Additional providers',
  blurb:
    'Extra speech-to-text engines a personality can pick by name. A personality that names one is transcribed through it; one that names nothing, or a name this machine does not have, uses the default above.',
  addLabel: 'Add STT provider',
  providerOptions: STT_PROVIDER_OPTIONS,
  commandProvider: 'command-stt',
  commandPlaceholders: COMMAND_STT_PLACEHOLDERS,
  commandExample: COMMAND_STT_EXAMPLE,
  defaultProvider: 'local-stt',
  modelPlaceholder: 'whisper-large-v3',
  baseUrlPlaceholder: 'http://localhost:8000/v1',
  audioOutputFields: false,
  timeoutField: true,
  realtimeFields: false,
};

export const TTS_ROSTER_SPEC: VoiceRosterKindSpec = {
  kind: 'tts',
  label: 'TTS',
  configKey: 'voice.tts.providers',
  rosterHeading: 'Additional providers',
  blurb:
    'Extra text-to-speech providers a personality can pick by name. A personality that names one speaks through it; one that names nothing, or a name this machine does not have, uses the default above.',
  addLabel: 'Add TTS provider',
  providerOptions: TTS_PROVIDER_OPTIONS,
  commandProvider: 'command-tts',
  commandPlaceholders: COMMAND_TTS_PLACEHOLDERS,
  commandExample: COMMAND_TTS_EXAMPLE,
  defaultProvider: 'local-tts',
  modelPlaceholder: 'kokoro',
  baseUrlPlaceholder: 'http://localhost:8880/v1',
  audioOutputFields: true,
  timeoutField: true,
  realtimeFields: false,
};

export const REALTIME_ROSTER_SPEC: VoiceRosterKindSpec = {
  kind: 'realtime',
  label: 'Realtime',
  configKey: 'voice.realtime.providers',
  rosterHeading: 'Realtime providers',
  blurb:
    'Hosted speech-to-speech engines — one live session handles listening and speaking together, instead of transcribing, thinking, then synthesizing. A personality can pick one by name; the default below is what everything else uses.',
  addLabel: 'Add realtime provider',
  providerOptions: REALTIME_PROVIDER_OPTIONS,
  defaultProvider: 'openai-realtime',
  modelPlaceholder: 'gpt-realtime',
  baseUrlPlaceholder: 'https://api.openai.com/v1',
  audioOutputFields: false,
  timeoutField: false,
  realtimeFields: true,
};
