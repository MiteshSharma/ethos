// `voice.bots[]` — which number reaches which agent — and the first-call
// invitation read off the SAVED config. Moved verbatim out of `Settings.tsx`
// (Phase 1).

import { type ConfigGetData, type ConfigUpdatePatch, RECORD_KEY_RE } from './config-types';
import { nextRowId } from './row-id';

/** One `voice.bots[]` row: which number reaches which agent. */
export interface VoiceBotRow {
  _id: number;
  /** '' = let the loader derive one from `match`. */
  id: string;
  match: string;
  bindType: 'personality' | 'team';
  bindName: string;
  allowSlashSwitch: boolean;
}

export function voiceBotRowsFromConfig(bots: ConfigGetData['voiceBots']): VoiceBotRow[] {
  return bots.map((bot) => ({
    _id: nextRowId(),
    id: bot.id ?? '',
    match: bot.match,
    bindType: bot.bind.type,
    bindName: bot.bind.name,
    allowSlashSwitch: bot.bind.allowSlashSwitch,
  }));
}

export type VoiceBotsPatchResult =
  | { ok: true; bots: NonNullable<ConfigUpdatePatch['voiceBots']> }
  | { ok: false; error: string };

/** Rows → the full-replacement `voice.bots[]` list. A removed row IS a
 *  deletion, so the table is validated before it can delete anything. */
export function voiceBotsPatchFromRows(rows: VoiceBotRow[]): VoiceBotsPatchResult {
  const bots: NonNullable<ConfigUpdatePatch['voiceBots']> = [];
  const seenIds = new Set<string>();
  for (const row of rows) {
    const match = row.match.trim();
    const bindName = row.bindName.trim();
    const id = row.id.trim();
    if (!match) return { ok: false, error: 'Numbers: every row needs a number or room to match.' };
    if (!bindName) {
      return { ok: false, error: `Numbers: "${match}" needs a personality or team to answer it.` };
    }
    if (id && !RECORD_KEY_RE.test(id)) {
      return {
        ok: false,
        error: `Numbers: the bot id "${id}" becomes a config.yaml key — letters, digits, hyphens and underscores only.`,
      };
    }
    if (id && seenIds.has(id)) return { ok: false, error: `Numbers: duplicate bot id "${id}".` };
    if (id) seenIds.add(id);
    bots.push({
      ...(id ? { id } : {}),
      match,
      bind: {
        type: row.bindType,
        name: bindName,
        ...(row.allowSlashSwitch ? { allowSlashSwitch: true } : {}),
      },
    });
  }
  return { ok: true, bots };
}

/**
 * The guided first-call moment (DR2) — the last step of the first-run journey.
 *
 * Read off the SAVED config, never the live form: you can only dial a number
 * that is actually on disk, and an invitation to call an unsaved draft is an
 * invitation to hear a busy tone. Returns null when there is no trunk yet —
 * there is nothing to invite anyone to.
 */
export function firstCallInvitation(
  config: Pick<ConfigGetData, 'voiceTrunkProvider' | 'voiceTrunkId' | 'voiceTrunkFromNumber'> & {
    voiceBots: ConfigGetData['voiceBots'];
  },
): { number: string; answeredBy: string | null } | null {
  if (!config.voiceTrunkProvider || !config.voiceTrunkId) return null;
  // A wildcard row matches numbers; it is not one you can dial. The trunk's own
  // caller ID is the fallback, because on most trunks it is also the DID.
  const dialable = config.voiceBots.find((bot) => !bot.match.includes('*') && bot.match.trim());
  const number = dialable?.match.trim() ?? config.voiceTrunkFromNumber?.trim() ?? '';
  if (!number) return null;
  return { number, answeredBy: dialable?.bind.name ?? null };
}
