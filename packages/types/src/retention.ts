export interface RetentionEventsConfig {
  error?: string;
  audit?: string;
  channel?: string;
  install?: string;
}

export interface RetentionConfig {
  messages?: string;
  traces?: string;
  spans?: string;
  events?: RetentionEventsConfig;
  blobs?: string;
  archive?: string;
  /**
   * How long observe-mode channel transcripts are kept (R4). Pruned against
   * `recorded_at` — when we saw a message, not when the platform says it was
   * sent — so a backdated message cannot outlive the window.
   *
   * Short by default (`30d`, against `messages: 365d`): these are rooms the
   * agent watches without being addressed, so the corpus grows with the room's
   * traffic rather than with the user's use of the agent, and only the last
   * digest window is ever read.
   */
  channelTranscript?: string;
  /**
   * Run `VACUUM` on the session database after a prune actually deleted rows.
   * Default `false` — VACUUM rewrites the whole file and holds a write lock,
   * so reclaiming the freed pages is opt-in.
   */
  vacuumAfterPrune?: boolean;
  /**
   * Minimum whole days between two automatic vacuums. Default `0` (vacuum on
   * every prune that deleted rows). Only consulted when `vacuumAfterPrune`.
   */
  minVacuumIntervalDays?: number;
}

/**
 * The grammar every `retention.*` value must match: `forever`, or a whole
 * number followed by `d`(ays) | `w`(eeks) | `m`(onths, 30 days) | `y`(ears,
 * 365 days). Hours and minutes are NOT in it — `12h` is not a retention value.
 *
 * Canonical here because the code that ENFORCES it — `parseDuration` in
 * `extensions/observability-sqlite/src/retention.ts`, which throws on anything
 * else — lives in an extension no package may import, so every validating
 * surface would otherwise keep its own copy. Two already do
 * (`RETENTION_DURATION_RE` in `apps/web-api/src/services/config.service.ts`,
 * `RetentionDurationSchema` in `packages/web-contracts/src/router.ts`); they
 * are byte-identical to this and must change with it.
 *
 * Checked on the config-load path by `buildRetentionConfig`
 * (`packages/config/src/index.ts`), which drops a value that fails and warns.
 * Guarded by `packages/types/src/__tests__/retention-duration.test.ts`, which
 * pins this pattern against `parseDuration`'s own accept/reject set.
 */
export const RETENTION_DURATION_PATTERN = /^(forever|\d+[dwmy])$/;

/** True when `value` is a duration `parseDuration` will accept rather than
 *  throw on. See {@link RETENTION_DURATION_PATTERN}. */
export function isRetentionDuration(value: string): boolean {
  return RETENTION_DURATION_PATTERN.test(value);
}

/**
 * Retention subkeys that may NOT be scoped to one personality, and the sentence
 * every refusing surface shows the operator.
 *
 * `personalities.<id>.retention.*` is written and displayed by
 * `ethos retention` and the web Settings page, and read by NOTHING that prunes
 * on a schedule. No category honours a per-personality window today; the
 * difference with `channelTranscript` is that there is nothing for one to
 * honour. Observe-mode transcripts live in ONE `~/.ethos/channel-transcript.db`
 * with no personality column, pruned from the `observability-prune` cron
 * handler (`apps/ethos/src/wiring.ts`) against the global
 * `retention.channelTranscript` alone, so a per-personality value here could
 * never be more than a number in a file.
 *
 * Refused rather than accepted-and-ignored because this is third-party message
 * text: an operator who sets a shorter window and is told it was set has been
 * told the room is forgotten sooner than it is. The pre-existing gap for every
 * OTHER category is not fixed here — see the message, which names it.
 *
 * Canonical here for the same reason {@link RETENTION_DURATION_PATTERN} is:
 * more than one surface has to refuse the same combination, and a copy per
 * surface is how they come to disagree. The enforcers are
 * `runRetention`'s `set` branch (`apps/ethos/src/commands/retention.ts`),
 * `validateSettingsPatch` (`apps/web-api/src/services/config.service.ts` —
 * covers every `config.update` caller, UI or not), and `buildConfigPatch`
 * (`apps/web/src/pages/settings/lib/build-config-patch.ts`, which stops the
 * Settings page from sending one).
 *
 * Clearing is deliberately NOT refused anywhere: a value an earlier build wrote
 * must stay removable. On the CLI that is `ethos retention reset <category>
 * --personality <id>`; on the web it is removing the row, since
 * `personalityRetention` is a full replacement of `personalities.*.retention.*`
 * and an omitted subkey is deleted.
 */
export const RETENTION_NO_PERSONALITY_SCOPE: Readonly<Record<string, string>> = {
  channelTranscript:
    'observe-mode transcripts are one database with no personality column — ' +
    'the nightly prune reads the global retention.channelTranscript only.',
};

export const RETENTION_DEFAULTS: {
  messages: string;
  traces: string;
  spans: string;
  events: Required<RetentionEventsConfig>;
  blobs: string;
  archive: string;
  channelTranscript: string;
} = {
  messages: '365d',
  traces: '90d',
  spans: '90d',
  events: {
    error: '90d',
    audit: '365d',
    channel: '365d',
    install: 'forever',
  },
  blobs: '7d',
  archive: '730d',
  channelTranscript: '30d',
};
