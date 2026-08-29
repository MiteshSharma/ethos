// The repeatable-row shapes the page keeps in `useState` alongside the form
// store: the provider chain, the quick commands, the channel toolsets and the
// retention rules. Moved verbatim out of `Settings.tsx` (Phase 1); they live in
// `SettingsShell` and pass down to the panes as props, because they have no
// `preserve` to survive a pane unmount the way form fields do (D4).

import type { ProviderEntry } from '@ethosagent/web-contracts';
import { type ConfigGetData, RETENTION_SUBKEYS, type RetentionSubkey } from './config-types';
import { nextRowId } from './row-id';

// ---------------------------------------------------------------------------
// Provider chain row — local state for the editor
// ---------------------------------------------------------------------------

export interface ProviderRow {
  /** Stable key for React list rendering. */
  _id: number;
  provider: string;
  model: string;
  apiKey: string;
  apiKeyPreview: string;
  baseUrl: string;
  testStatus: 'idle' | 'testing' | 'success' | 'error';
  testError?: string;
}

export function emptyRow(): ProviderRow {
  return {
    _id: nextRowId(),
    provider: '',
    model: '',
    apiKey: '',
    apiKeyPreview: '',
    baseUrl: '',
    testStatus: 'idle',
  };
}

export function rowsFromConfig(
  providers: ProviderEntry[],
  legacyProvider?: string,
  legacyModel?: string,
  legacyApiKeyPreview?: string,
  legacyBaseUrl?: string | null,
): ProviderRow[] {
  if (providers.length > 0) {
    return providers.map((p) => ({
      _id: nextRowId(),
      provider: p.provider,
      model: p.model ?? '',
      apiKey: '',
      apiKeyPreview: p.apiKeyPreview,
      baseUrl: p.baseUrl ?? '',
      testStatus: 'idle' as const,
    }));
  }
  // Backward compat: populate from single-field config
  if (legacyProvider) {
    return [
      {
        _id: nextRowId(),
        provider: legacyProvider,
        model: legacyModel ?? '',
        apiKey: '',
        apiKeyPreview: legacyApiKeyPreview ?? '',
        baseUrl: legacyBaseUrl ?? '',
        testStatus: 'idle' as const,
      },
    ];
  }
  return [emptyRow()];
}

export interface QuickCommandRow {
  _id: number;
  name: string;
  type: 'exec' | 'reply';
  command: string;
  reply: string;
  gateway: boolean;
  channels: string[];
}

export interface ChannelToolsetRow {
  _id: number;
  platform: string;
  toolsets: string[];
}

export interface RetentionRow {
  _id: number;
  /** '' = global `retention.<subkey>`; otherwise `personalities.<id>.retention.<subkey>`. */
  personalityId: string;
  subkey: RetentionSubkey;
  duration: string;
}

export function quickCommandRowsFromConfig(
  commands: ConfigGetData['quickCommands'],
): QuickCommandRow[] {
  return Object.entries(commands)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, qc]) => ({
      _id: nextRowId(),
      name,
      type: qc.type,
      command: qc.type === 'exec' ? qc.command : '',
      reply: qc.type === 'reply' ? qc.reply : '',
      gateway: qc.gateway,
      channels: qc.channels,
    }));
}

export function channelToolsetRowsFromConfig(
  map: ConfigGetData['channelToolsets'],
): ChannelToolsetRow[] {
  return Object.entries(map)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([platform, toolsets]) => ({ _id: nextRowId(), platform, toolsets }));
}

export function retentionRowsFromConfig(
  retention: ConfigGetData['retention'],
  personalityRetention: ConfigGetData['personalityRetention'],
): RetentionRow[] {
  const rows: RetentionRow[] = [];
  for (const subkey of RETENTION_SUBKEYS) {
    const duration = retention[subkey];
    if (duration !== undefined)
      rows.push({ _id: nextRowId(), personalityId: '', subkey, duration });
  }
  for (const [pid, map] of Object.entries(personalityRetention).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    for (const subkey of RETENTION_SUBKEYS) {
      const duration = map[subkey];
      if (duration !== undefined) {
        rows.push({ _id: nextRowId(), personalityId: pid, subkey, duration });
      }
    }
  }
  return rows;
}
