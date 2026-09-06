// Shared config-surface types for the Settings panes.
//
// Moved verbatim out of `Settings.tsx` when the page became a routed two-pane
// surface (plan/phases/settings-navigation.md Phase 1). The RPC-derived aliases
// are the single place the page learns the shape of `config.get` / `config.update`.

import type { rpc } from '../../../rpc';

// ---------------------------------------------------------------------------
// Record editors (quick commands, channel toolsets, retention) — local row
// state hydrated from config.get like the provider chain, sent back as
// FULL-REPLACEMENT records on Save: entries removed here are deleted from
// config.yaml. (Webhooks are edited per personality on the Personality page's
// Triggers section, not here.)
// ---------------------------------------------------------------------------

export type ConfigUpdatePatch = Parameters<typeof rpc.config.update>[0];
export type ConfigGetData = Awaited<ReturnType<typeof rpc.config.get>>;
export type QuickCommandPatch = NonNullable<ConfigUpdatePatch['quickCommands']>[string];
export type VoiceTtsProviderPatch = NonNullable<ConfigUpdatePatch['voiceTtsProviders']>[string];
export type VoiceSttProviderPatch = NonNullable<ConfigUpdatePatch['voiceSttProviders']>[string];
export type VoiceRealtimeProviderPatch = NonNullable<
  ConfigUpdatePatch['voiceRealtimeProviders']
>[string];
export type VoiceBargeInPatch = NonNullable<ConfigUpdatePatch['voiceBargeIn']>[string];
export type RetentionSubkey = keyof ConfigGetData['retention'];

/** Mirrors ConfigRecordKeySchema in @ethosagent/web-contracts. */
export const RECORD_KEY_RE = /^[A-Za-z0-9_-]+$/;
/** Mirrors RetentionDurationSchema — 'forever' or <n> followed by d|w|m|y. */
export const RETENTION_DURATION_RE = /^(forever|\d+[dwmy])$/;

/**
 * Every subkey `ConfigGetData['retention']` can carry. It must list ALL of them:
 * `config.update`'s retention patch is a full replacement of the subkeys it owns
 * (`RETENTION_SUBKEYS` in apps/web-api/src/services/config.service.ts — the
 * `owned` sweep in `update`), and this list is what `retentionRowsFromConfig`
 * turns into editable rows and `buildConfigPatch` rebuilds the patch from. A
 * subkey missing here is read off config, dropped on the floor, and then DELETED
 * from config.yaml by the next unrelated save. Pinned by
 * `apps/web/src/pages/__tests__/retention-subkeys.test.ts`.
 */
export const RETENTION_SUBKEYS: readonly RetentionSubkey[] = [
  'messages',
  'traces',
  'spans',
  'blobs',
  'archive',
  'channelTranscript',
  'events.error',
  'events.audit',
  'events.channel',
  'events.install',
];

/** '' / whitespace → null (clear-to-default for nullable config scalars). */
export function strOrNull(s: string): string | null {
  const t = s.trim();
  return t ? t : null;
}

export interface PersonalityOption {
  id: string;
  name: string;
}
