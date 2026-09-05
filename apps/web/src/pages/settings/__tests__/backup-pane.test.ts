// @vitest-environment jsdom
//
// Settings › Backup — the seven states of plan/phases/agent-state-backup.md §5,
// and the three places the pane must be more careful than the plan's table is:
//
//   1. The running state carries NO size. There is no progress seam through
//      `createBackup`, and the only counter underneath counts pages, not bytes,
//      so "Creating backup… 12 MB" would be a number nothing measured.
//   2. The restart notice keys off `serverStartedAt` and nothing else, and is
//      not dismissable — dismissing a true statement does not make it false.
//   3. `downloadAvailable: false` degrades to a path and a CLI line, never to a
//      Download button that 401s on click.
//
// And two contract obligations: the rows are the SAME rows the chat trail
// draws (`.activity-row`, glyph + word), and `inUseCheck`'s two `skipped_*`
// values are never rendered as "nothing was running".
//
// `renderToStaticMarkup` + a seeded `QueryClient`, the same harness
// `settings-self-save-markers.test.ts` uses — `apps/web` has no testing-library
// and this change deliberately does not add one, so anything behind a click is
// asserted through the pure function the click calls.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntApp, Form } from 'antd';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { backupKeys } from '../../../features/settings/api/backup';
import {
  actionsDisabled,
  BackupActionRow,
  BackupPane,
  BackupRestartNotice,
  cliRestoreCommand,
  inUseCheckLine,
  nextRunLabel,
  restartNoticeVisible,
  restoreConfirmContent,
  restoreOutcome,
} from '../panes/backup';

type Status = Parameters<typeof seed>[0];

const NOW = '2026-09-05T12:00:00.000Z';

function baseStatus() {
  return {
    directory: '/home/u/.ethos/backups',
    serverStartedAt: '2026-09-05T09:00:00.000Z',
    running: false,
    downloadAvailable: true,
    schedule: {
      enabled: true,
      cron: '0 4 * * *',
      scopes: ['identity' as const, 'state' as const],
      keep: 7,
      nextRunAt: '2026-09-06T04:00:00.000Z',
      lastRunAt: null,
      lastError: null,
    },
    lastBackup: null as {
      ok: boolean;
      at: string;
      archive: { name: string; bytes: number; createdAt: string; scheduled: boolean } | null;
      error: string | null;
    } | null,
    archives: [] as { name: string; bytes: number; createdAt: string; scheduled: boolean }[],
    stores: [] as {
      database: string;
      scope: 'identity' | 'state' | 'telemetry' | null;
      included: boolean;
      reason: string;
      changed: 'changed' | 'unchanged' | 'absent' | 'unknown';
    }[],
  };
}

/**
 * The schedule rows are `Form.Item`s the page Save writes, so the harness
 * supplies the enclosing `<Form component={false}>` `SettingsShell` gives the
 * pane through its outlet — without it rc-field-form warns and the fields
 * render detached from any store, which is not the shape being tested.
 */
function seed(
  status: ReturnType<typeof baseStatus>,
  values: { backup?: Record<string, unknown> } = {},
): string {
  const queryClient = new QueryClient();
  queryClient.setQueryData(backupKeys.status(), status);
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        AntApp,
        null,
        createElement(
          Form,
          { component: false as const, initialValues: values },
          createElement(BackupPane),
        ),
      ),
    ),
  );
}

function markup(patch: Partial<Status> = {}): string {
  return seed({ ...baseStatus(), ...patch });
}

/**
 * The pane with `backup.status` in its failed state, nothing else changed.
 * `retryOnMount: false` because an errored query with no data otherwise
 * renders OPTIMISTICALLY as pending — the observer assumes the mount will
 * refetch — and the loading branch is not what this is testing.
 */
function seedError(message: string): string {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retryOnMount: false } } });
  const query = queryClient
    .getQueryCache()
    .build(queryClient, queryClient.defaultQueryOptions({ queryKey: backupKeys.status() }));
  query.setState({
    status: 'error',
    error: new Error(message),
    fetchStatus: 'idle',
    errorUpdateCount: 1,
    errorUpdatedAt: Date.now(),
  });
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(
        AntApp,
        null,
        createElement(Form, { component: false as const }, createElement(BackupPane)),
      ),
    ),
  );
}

/** The markup's visible text, tags stripped — glyphs and words, not classes. */
function text(html: string): string {
  return (
    html
      .replace(/<[^>]*>/g, ' ')
      // React escapes `'` in text as `&#x27;`, and the CLI line below is
      // single-quoted, so an assertion against the composed command would
      // otherwise never match what was rendered.
      .replace(/&#x27;/g, "'")
      .replace(/\s+/g, ' ')
  );
}

/**
 * Decode ONE POSIX single-quoted argument back to its literal text, refusing
 * anything a shell would not read as a single word: a character outside the
 * quotes, an unterminated quote, or junk between two quoted runs. A value that
 * survives this round trip cannot have broken out of the quoting.
 *
 * Asserting an expected STRING instead is what let seven paste lines pass
 * review while still being injectable — the expectation is written from the
 * same misunderstanding as the code. Same inverter as
 * `apps/ethos/src/commands/__tests__/backup-cli.test.ts`.
 */
function decodeSingleQuoted(arg: string): string {
  let out = '';
  let i = 0;
  while (i < arg.length) {
    if (arg[i] !== "'") throw new Error(`unquoted text at ${i}: ${arg}`);
    const close = arg.indexOf("'", i + 1);
    if (close < 0) throw new Error(`unterminated quote: ${arg}`);
    out += arg.slice(i + 1, close);
    i = close + 1;
    if (i < arg.length) {
      if (arg.slice(i, i + 2) !== "\\'") throw new Error(`junk between quotes: ${arg}`);
      out += "'";
      i += 2;
    }
  }
  return out;
}

const CLI_PREFIX = 'ethos import ';
const CLI_SUFFIX = ' --scope identity,state --secrets prompt';

/** The one argument of the paste line, still quoted — the thing under test. */
function cliArchiveArg(directory: string, archiveName: string): string {
  const line = cliRestoreCommand(directory, archiveName);
  expect(line.startsWith(CLI_PREFIX)).toBe(true);
  expect(line.endsWith(CLI_SUFFIX)).toBe(true);
  return line.slice(CLI_PREFIX.length, line.length - CLI_SUFFIX.length);
}

const ARCHIVE = {
  name: 'ethos-2026-09-05T115900.tar.gz',
  bytes: 13_000_000,
  createdAt: NOW,
  scheduled: false,
};

// ---------------------------------------------------------------------------
// The seven states
// ---------------------------------------------------------------------------

describe('Backup pane — never backed up', () => {
  const html = markup();

  it('says there is no backup yet and why one is worth making', () => {
    expect(text(html)).toContain('No backup yet.');
    expect(text(html)).toContain('move to another machine');
  });

  it('offers Create backup as the one primary, beside the status', () => {
    expect(html).toContain('Create backup');
    expect(html).toContain('ant-btn-primary');
    expect(html).toContain('settings-backup-header');
  });

  it('says the archive list is empty rather than drawing nothing', () => {
    expect(text(html)).toContain('No archives yet.');
  });
});

describe('Backup pane — running', () => {
  // A previous backup exists, so sizes DO appear elsewhere on the page — the
  // "no size" assertion below has to be about the running row specifically.
  const html = markup({
    running: true,
    lastBackup: { ok: true, at: NOW, archive: ARCHIVE, error: null },
    archives: [ARCHIVE],
  });

  it('renders the running state as a row of the shared vocabulary', () => {
    expect(text(html)).toContain('running');
    expect(text(html)).toContain('Creating backup…');
    expect(html).toContain('activity-row activity-row-running');
  });

  it('labels NO size — there is no byte-accurate progress to report', () => {
    // Correction 1: the plan's "Creating backup… 12 MB" is not deliverable.
    // `status.running` is a boolean; the only counter underneath counts pages.
    const row = html.slice(
      html.indexOf('activity-row activity-row-running'),
      html.indexOf('settings-backup-meta'),
    );
    expect(row).toContain('Creating backup…');
    expect(text(row)).not.toMatch(/\d+(\.\d+)?\s?(B|KB|MB)/);
    // …and the size that DOES exist on the page is the finished archive's.
    expect(text(html)).toContain('12 MB');
  });

  it('disables Create while one is already in flight', () => {
    const button = html.slice(html.indexOf('ant-btn-primary'));
    expect(button.slice(0, button.indexOf('</button>'))).toContain('disabled');
    const idle = markup();
    const idleButton = idle.slice(idle.indexOf('ant-btn-primary'));
    expect(idleButton.slice(0, idleButton.indexOf('</button>'))).not.toContain('disabled');
  });
});

describe('Backup pane — success', () => {
  const html = markup({
    lastBackup: { ok: true, at: NOW, archive: ARCHIVE, error: null },
    archives: [ARCHIVE],
  });

  it('anchors the header on the last backup: glyph, word, name, size, age', () => {
    const t = text(html);
    expect(t).toContain('✓ ok');
    expect(t).toContain(ARCHIVE.name);
    expect(t).toContain('12 MB');
    expect(t).toMatch(/\d+[smhd] ago/);
  });

  it('says when the next scheduled run is', () => {
    expect(text(html)).toContain('Next run:');
  });
});

describe('Backup pane — failed', () => {
  const html = markup({
    lastBackup: { ok: false, at: NOW, archive: null, error: 'ENOSPC: no space left on device' },
  });

  it('keeps the failed attempt in the header, with its reason', () => {
    expect(text(html)).toContain('✗ failed');
    expect(text(html)).toContain('ENOSPC: no space left on device');
  });
});

describe('Backup pane — download', () => {
  it('links each archive to the raw cookie-authed route', () => {
    const html = markup({ archives: [ARCHIVE] });
    expect(html).toContain(`href="/backup/download?name=${encodeURIComponent(ARCHIVE.name)}"`);
    expect(html).toContain('download=""');
  });

  it('degrades honestly when the route cannot serve this caller', () => {
    // Correction 3: no Download button that silently 401s. The path to copy,
    // and the CLI that writes one, instead.
    const html = markup({ archives: [ARCHIVE], downloadAvailable: false });
    expect(html).not.toContain('/backup/download?');
    expect(text(html)).toContain('/home/u/.ethos/backups/ethos-2026-09-05T115900.tar.gz');
    expect(text(html)).toContain('ethos backup --out');
  });
});

describe('Backup pane — restoring', () => {
  it('offers Restore identity on every archive row', () => {
    expect(text(markup({ archives: [ARCHIVE] }))).toContain('Restore identity');
  });

  it('withdraws Restore while a create is running, and Create while a restore is', () => {
    // SUPPLEMENTARY to the service's operation lock, which is what actually
    // stops a create and a restore rewriting `config.yaml` and
    // `personalities/` underneath each other. This only keeps the pane from
    // offering an action the server is about to refuse.
    const html = markup({ running: true, archives: [ARCHIVE] });
    const label = html.indexOf('Restore identity');
    expect(label).toBeGreaterThan(-1);
    expect(html.slice(html.lastIndexOf('<button', label), label)).toContain('disabled');
    // …and it is clickable when nothing is in flight.
    const idle = markup({ archives: [ARCHIVE] });
    const idleLabel = idle.indexOf('Restore identity');
    expect(idle.slice(idle.lastIndexOf('<button', idleLabel), idleLabel)).not.toContain('disabled');

    // The rule itself, both ways round.
    expect(actionsDisabled({ statusRunning: true, creating: false, restoring: false })).toEqual({
      create: true,
      restore: true,
    });
    expect(actionsDisabled({ statusRunning: false, creating: false, restoring: true })).toEqual({
      create: true,
      restore: true,
    });
    expect(actionsDisabled({ statusRunning: false, creating: false, restoring: false })).toEqual({
      create: false,
      restore: false,
    });
  });

  it('names what a restore overwrites, before it overwrites it', () => {
    const content = restoreConfirmContent(ARCHIVE.name);
    expect(content).toContain(ARCHIVE.name);
    expect(content).toContain('config.yaml');
    expect(content).toContain('mcp.json');
    expect(content).toContain('personalities/');
    expect(content).toContain('.pre-restore');
    // And what it does NOT touch, so "restore" is not read as "restore everything".
    expect(content).toContain('Conversation history');
  });

  it('resolves the restore row in place, stating the outcome — it never vanishes', () => {
    const running = renderToStaticMarkup(
      createElement(BackupActionRow, {
        row: {
          id: ARCHIVE.name,
          subject: ARCHIVE.name,
          status: 'running',
          result: 'Restoring identity…',
          detail: [],
        },
      }),
    );
    const resolved = renderToStaticMarkup(
      createElement(BackupActionRow, {
        row: restoreOutcome(ARCHIVE.name, report({ restored: ['config.yaml', 'mcp.json'] })),
      }),
    );
    expect(text(running)).toContain('Restoring identity…');
    expect(text(resolved)).toContain(ARCHIVE.name);
    expect(text(resolved)).toContain('restored 2 files');
    expect(running).toContain('activity-row');
    expect(resolved).toContain('activity-row');
    // Not a toast: nothing here clears itself.
    expect(resolved).not.toContain('ant-message');
    expect(resolved).not.toContain('role="alert"');
  });
});

describe('Backup pane — restart required', () => {
  it('appears only once a restore said so, and stays while the boot time is the same', () => {
    expect(restartNoticeVisible(null, '2026-09-05T09:00:00.000Z')).toBe(false);
    expect(restartNoticeVisible('2026-09-05T09:00:00.000Z', '2026-09-05T09:00:00.000Z')).toBe(true);
  });

  it('clears ONLY on a status carrying a different serverStartedAt', () => {
    expect(restartNoticeVisible('2026-09-05T09:00:00.000Z', '2026-09-05T13:30:00.000Z')).toBe(
      false,
    );
  });

  it('does not clear because the status is unreachable — that is not proof', () => {
    // Mid-restart the server answers nothing at all. Absence of evidence is
    // not evidence the restart happened.
    expect(restartNoticeVisible('2026-09-05T09:00:00.000Z', undefined)).toBe(true);
  });

  it('is a warning row with a glyph AND a word, and no way to dismiss it', () => {
    const html = renderToStaticMarkup(createElement(BackupRestartNotice));
    expect(text(html)).toContain('⚠ restart required');
    expect(text(html)).toContain('Restart Ethos');
    expect(html).not.toContain('ant-alert-close');
    expect(html).not.toContain('button');
  });
});

// ---------------------------------------------------------------------------
// Store rows — four `changed` values, two inclusion values
// ---------------------------------------------------------------------------

describe('Backup pane — store rows', () => {
  const stores = [
    {
      database: 'sessions.db',
      scope: 'state' as const,
      included: true,
      reason: 'Conversation history.',
      changed: 'changed' as const,
    },
    {
      database: 'kanban.db',
      scope: 'state' as const,
      included: true,
      reason: 'Boards.',
      changed: 'unchanged' as const,
    },
    {
      database: 'memory.db',
      scope: 'state' as const,
      included: true,
      reason: 'Vector memory.',
      changed: 'absent' as const,
    },
    {
      database: 'observability.db',
      scope: 'telemetry' as const,
      included: false,
      reason: 'Telemetry is opt-in.',
      changed: 'unknown' as const,
    },
  ];
  const html = markup({ stores });
  const t = text(html);

  it('names each store in mono, with the reason it is in or out', () => {
    for (const store of stores) {
      expect(t).toContain(store.database);
      expect(t).toContain(store.reason);
    }
  });

  it('renders included and excluded as glyph + word', () => {
    expect(t).toContain('✓ included');
    expect(t).toContain('– excluded');
  });

  it('renders ALL FOUR changed values distinctly — no dot means one thing only', () => {
    expect(t).toContain('● changed');
    expect(t).toContain('○ unchanged');
    expect(t).toContain('⊘ absent');
    expect(t).toContain('? unknown');
  });

  it('says what absent and unknown mean, rather than leaving two greys to guess at', () => {
    expect(t).toContain('never created the database');
    expect(t).toContain('no archive to compare against yet');
  });

  it('draws them as the shared row, not a table', () => {
    expect(html).toContain('activity-row settings-backup-store');
    expect(html).not.toContain('<table');
  });
});

// ---------------------------------------------------------------------------
// inUseCheck — the three values, and the two that mean "no check was made"
// ---------------------------------------------------------------------------

function report(patch: Partial<ReturnType<typeof baseReport>> = {}) {
  return { ...baseReport(), ...patch };
}

function baseReport() {
  return {
    dryRun: false,
    scopes: ['identity' as const],
    createdAt: NOW,
    restored: ['config.yaml'],
    displaced: [] as string[],
    displacedTo: null as string | null,
    inUseCheck: 'held' as 'held' | 'skipped_dry_run' | 'skipped_force',
    lockedDatabases: [] as string[],
    restartRequired: true,
    warnings: [] as { kind: 'fs_reach_absolute'; path: string; message: string }[],
    secretsManifest: null as string | null,
  };
}

describe('inUseCheck is never read as "nothing was running"', () => {
  it('held, with nothing to lock — the check RAN and found the way clear', () => {
    const line = inUseCheckLine(report({ inUseCheck: 'held', lockedDatabases: [] }));
    expect(line).toContain('held');
    expect(line).not.toContain('not made');
  });

  it('held, naming what it is keeping idle', () => {
    const line = inUseCheckLine(
      report({ inUseCheck: 'held', lockedDatabases: ['sessions.db', 'kanban.db'] }),
    );
    expect(line).toContain('sessions.db');
    expect(line).toContain('kanban.db');
  });

  it('skipped_dry_run — says NO CHECK WAS MADE, and why', () => {
    const line = inUseCheckLine(report({ inUseCheck: 'skipped_dry_run', lockedDatabases: [] }));
    expect(line).toContain('not made');
    expect(line).toContain('dry run');
    expect(line).toContain('nothing was proved idle');
  });

  it('skipped_force — says NO CHECK WAS MADE, and why', () => {
    const line = inUseCheckLine(report({ inUseCheck: 'skipped_force', lockedDatabases: [] }));
    expect(line).toContain('not made');
    expect(line).toContain('force');
    expect(line).toContain('nothing was proved idle');
  });

  it('carries the answer onto the restore row itself', () => {
    const html = renderToStaticMarkup(
      createElement(BackupActionRow, {
        row: restoreOutcome(ARCHIVE.name, report({ inUseCheck: 'skipped_force' })),
      }),
    );
    expect(text(html)).toContain('not made');
  });
});

// ---------------------------------------------------------------------------
// Schedule, and the restore this pane cannot do
// ---------------------------------------------------------------------------

describe('Backup pane — schedule', () => {
  it('names every backup.* key it writes', () => {
    const t = text(markup());
    expect(t).toContain('backup.enabled');
    expect(t).toContain('backup.cron');
    expect(t).toContain('backup.scope');
    expect(t).toContain('backup.keep');
    expect(t).toContain('backup.dir');
  });

  // The narrowing this section closes: it used to say `backup.*` was not
  // carried by the config RPC and send the operator to a text editor.
  it('is editable here — no "read-only" note, no "edit config.yaml and restart"', () => {
    const t = text(markup());
    expect(t).not.toContain('~/.ethos/config.yaml');
    expect(t).not.toContain('Read-only here');
  });

  it('renders real controls, not a value column of resolved strings', () => {
    const html = markup();
    expect(html).toContain('id="backup_enabled"');
    expect(html).toContain('id="backup_cron"');
    expect(html).toContain('id="backup_scope"');
    expect(html).toContain('id="backup_keep"');
    expect(html).toContain('id="backup_dir"');
  });

  it('shows the saved values, and the computed defaults only as placeholders', () => {
    const html = seed(baseStatus(), {
      backup: { enabled: true, cron: '30 2 * * *', scope: ['identity'], keep: 3, dir: '/mnt/snap' },
    });
    expect(html).toContain('value="30 2 * * *"');
    expect(html).toContain('value="/mnt/snap"');
    // `dir` blank must not pin the resolved directory into the field.
    const blank = seed(baseStatus(), { backup: { cron: '', dir: '' } });
    expect(blank).toContain('placeholder="/home/u/.ethos/backups"');
    expect(blank).not.toContain('value="/home/u/.ethos/backups"');
  });

  // `backup.status` resolves `backup.*` through `resolveBackupSettings`, which
  // throws on a `keep` or a scope name config cannot use — the very fields
  // below it. Hiding them would show the error and hide the fix.
  it('keeps the fields reachable when the status call is the thing that failed', () => {
    // Verbatim `packages/config` text — `buildBackupConfig` throws it, and
    // `backup.status` is where a saved-but-unloadable value surfaces.
    const t = text(seedError('Invalid backup.keep "0". Expected a positive integer.'));
    expect(t).toContain('Invalid backup.keep');
    expect(t).toContain('Expected a positive integer.');
    expect(t).toContain('backup.keep');
    expect(t).toContain('backup.scope');
  });

  it('says plainly when there is no next run, rather than inventing one', () => {
    const off = { ...baseStatus().schedule, enabled: false, nextRunAt: null };
    expect(nextRunLabel(off)).toContain('the schedule is off');
    const unscheduled = { ...baseStatus().schedule, nextRunAt: null };
    expect(nextRunLabel(unscheduled)).toContain('no scheduler');
  });

  it('formats a real next run as a clock time', () => {
    expect(nextRunLabel(baseStatus().schedule)).toMatch(/Next run: \d\d:\d\d/);
  });
});

describe('Backup pane — the full restore it cannot do', () => {
  it('offers the exact CLI line, and says why the page will not do it (D6)', () => {
    const t = text(markup({ archives: [ARCHIVE] }));
    expect(t).toContain(cliRestoreCommand('/home/u/.ethos/backups', ARCHIVE.name));
    expect(t).toContain('holds every database open');
  });

  it('builds the command against the archive directory', () => {
    expect(decodeSingleQuoted(cliArchiveArg('/d', 'a.tar.gz'))).toBe('/d/a.tar.gz');
  });

  // Neither half of this path is ours. `backup.dir` is operator-typed config,
  // and `listArchives` returns any regular file ending `.tar.gz` — so the
  // filename is whatever is sitting in that directory, not something Ethos
  // generated. The line is built to be PASTED into a shell, so both halves have
  // to survive as one word: unquoted, the space cases produce a broken command
  // and the `;` / `$(…)` cases run when the operator pastes them.
  it('quotes the whole archive path, so nothing in either half can run', () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ['/home/u/my backups', 'ethos 2026 backup.tar.gz'],
      ["/home/u/ada's", "o'clock.tar.gz"],
      ['/home/u/backups; id', 'a; rm -rf ~.tar.gz'],
      ['/home/u/$(id)', '`id`-$(id).tar.gz'],
    ];
    for (const [dir, name] of cases) {
      expect(decodeSingleQuoted(cliArchiveArg(dir, name))).toBe(`${dir}/${name}`);
    }
  });
});

// ---------------------------------------------------------------------------
// Contract compliance
// ---------------------------------------------------------------------------

describe('Backup pane — the shared row vocabulary', () => {
  it('renders its action rows through FeedbackRow, not a second row component', () => {
    const html = renderToStaticMarkup(
      createElement(BackupActionRow, {
        row: { id: 'x', subject: 'backup', status: 'ok', result: '12 MB', detail: [] },
      }),
    );
    expect(html).toContain('activity-row activity-row-ok');
    expect(text(html)).toContain('✓ ok');
  });

  it('never draws a Card — this is a dense pane of rows', () => {
    expect(markup({ archives: [ARCHIVE] })).not.toContain('ant-card');
  });
});
