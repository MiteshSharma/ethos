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

export const RETENTION_DEFAULTS: {
  messages: string;
  traces: string;
  spans: string;
  events: Required<RetentionEventsConfig>;
  blobs: string;
  archive: string;
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
};
