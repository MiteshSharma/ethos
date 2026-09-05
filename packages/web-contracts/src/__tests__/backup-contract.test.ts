import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contract } from '../index';

// Shape tests for the `backup` namespace. The schemas themselves are module-
// private — only the types are exported — so they are reached through the
// contract the same way the server reaches them. The container access is
// guarded by an `instanceof` rather than trusted, so a change in oRPC's
// internals fails loudly here instead of silently skipping every assertion.

function schemaOf(procedure: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
  const def = (procedure as { '~orpc'?: Record<string, unknown> })['~orpc'];
  const schema = def?.[field];
  if (!(schema instanceof z.ZodType)) throw new Error(`backup contract has no ${field}`);
  return schema;
}

const statusOut = schemaOf(contract.backup.status, 'outputSchema');
const createIn = schemaOf(contract.backup.create, 'inputSchema');
const restoreIn = schemaOf(contract.backup.restoreIdentity, 'inputSchema');
const restoreOut = schemaOf(contract.backup.restoreIdentity, 'outputSchema');

const archive = {
  name: 'ethos-web-2026-09-05T00-00-00Z.tar.gz',
  bytes: 12345,
  createdAt: '2026-09-05T00:00:00.000Z',
  scheduled: false,
};

const status = {
  directory: '/home/u/.ethos/backups',
  serverStartedAt: '2026-09-05T00:00:00.000Z',
  running: false,
  downloadAvailable: true,
  schedule: {
    enabled: true,
    cron: '0 4 * * *',
    scopes: ['identity', 'state'],
    keep: 7,
    nextRunAt: '2026-09-06T04:00:00.000Z',
    lastRunAt: null,
    lastError: null,
  },
  lastBackup: { ok: true, at: archive.createdAt, archive, error: null },
  archives: [archive],
  stores: [
    {
      database: 'sessions.db',
      scope: 'state',
      included: true,
      reason: 'Conversation history.',
      changed: 'changed',
    },
  ],
};

const restoreReport = {
  dryRun: false,
  scopes: ['identity'],
  createdAt: '2026-09-05T00:00:00.000Z',
  restored: ['config.yaml'],
  displaced: ['config.yaml'],
  displacedTo: '.pre-restore/2026-09-05',
  inUseCheck: 'held',
  lockedDatabases: ['sessions.db'],
  restartRequired: true,
  warnings: [],
  secretsManifest: null,
};

describe('backup contract', () => {
  it('is mounted on the root contract with three procedures', () => {
    expect(Object.keys(contract.backup).sort()).toEqual(['create', 'restoreIdentity', 'status']);
  });

  it('status carries the whole pane header', () => {
    expect(statusOut.parse(status)).toMatchObject({
      directory: status.directory,
      serverStartedAt: status.serverStartedAt,
      downloadAvailable: true,
    });
  });

  it('status requires serverStartedAt — the restart notice has nothing else to key off', () => {
    const { serverStartedAt: _dropped, ...without } = status;
    expect(statusOut.safeParse(without).success).toBe(false);
  });

  it('status requires downloadAvailable — a Bearer client must be told', () => {
    const { downloadAvailable: _dropped, ...without } = status;
    expect(statusOut.safeParse(without).success).toBe(false);
  });

  it('a store row must say whether it changed, and may be excluded', () => {
    const excluded = {
      ...status,
      stores: [
        {
          database: 'delivery-ledger.db',
          scope: null,
          included: false,
          reason: 'Transient.',
          changed: 'unknown',
        },
      ],
    };
    expect(statusOut.parse(excluded)).toMatchObject({
      stores: [{ scope: null, included: false }],
    });

    const bogus = {
      ...status,
      stores: [{ ...status.stores[0], changed: 'maybe' }],
    };
    expect(statusOut.safeParse(bogus).success).toBe(false);
  });

  it('create takes no scopes, or a non-empty scope list', () => {
    expect(createIn.parse({})).toEqual({});
    expect(createIn.safeParse({ scopes: ['identity', 'state'] }).success).toBe(true);
    expect(createIn.safeParse({ scopes: [] }).success).toBe(false);
    expect(createIn.safeParse({ scopes: ['everything'] }).success).toBe(false);
  });

  it('restoreIdentity ACCEPTS a `state` scope at the schema, so the refusal can be a refusal', () => {
    // D6 is enforced by the service with a reason the pane can render. If the
    // schema rejected it here the caller would get an unactionable 400 instead.
    expect(restoreIn.safeParse({ name: 'a.tar.gz', scopes: ['state'] }).success).toBe(true);
    expect(restoreIn.safeParse({ name: '' }).success).toBe(false);
  });

  it('a restore report always carries inUseCheck and restartRequired', () => {
    expect(restoreOut.parse(restoreReport)).toMatchObject({
      inUseCheck: 'held',
      restartRequired: true,
    });

    for (const field of ['inUseCheck', 'restartRequired'] as const) {
      const { [field]: _dropped, ...without } = restoreReport;
      expect(restoreOut.safeParse(without).success).toBe(false);
    }
  });

  it('inUseCheck admits exactly the three states the core reports', () => {
    for (const value of ['held', 'skipped_dry_run', 'skipped_force']) {
      expect(restoreOut.safeParse({ ...restoreReport, inUseCheck: value }).success).toBe(true);
    }
    // Anything else would let an empty `lockedDatabases` be rendered as
    // "nothing was running" under a state that made no check at all.
    expect(restoreOut.safeParse({ ...restoreReport, inUseCheck: 'ok' }).success).toBe(false);
  });

  it('secretsManifest is nullable text, never a structured command', () => {
    const withManifest = { ...restoreReport, secretsManifest: '# set ANTHROPIC_API_KEY\n' };
    expect(restoreOut.parse(withManifest)).toMatchObject({
      secretsManifest: '# set ANTHROPIC_API_KEY\n',
    });
    expect(restoreOut.safeParse({ ...restoreReport, secretsManifest: { run: 'x' } }).success).toBe(
      false,
    );
  });
});
