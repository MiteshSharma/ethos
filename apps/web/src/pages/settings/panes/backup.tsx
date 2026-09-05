// Backup — local archives of `~/.ethos`, and the identity-only restore
// (plan/phases/agent-state-backup.md §5, D6). Status-first: the header row is
// the anchor, the store rows say what a backup would hold, the archive rows
// carry the two secondary actions, and the schedule is five page-Save
// `SettingRow`s bound to `backup.*`.
//
// Every action this page takes is a ROW — `ui/FeedbackRow`, the same row the
// chat trail draws (feedback & activity contract §6). No toast, and no second
// status vocabulary invented for settings: a user who has read one row has read
// them all. Outcomes resolve their row in place and stay (§7, "nothing
// vanishes"), which is why the create/restore rows live in pane state rather
// than being derived from the mutation's `data`.
//
// Two things the store rows say that a naive rendering would lose:
//
//   * `changed` has FOUR values, not two. `absent` (this deployment never
//     created the database) and `unknown` (no archive to compare against yet)
//     exist precisely so that "no dot" cannot mean two different things, so all
//     four get their own glyph and their own word.
//   * `inUseCheck` is load-bearing. `skipped_dry_run` / `skipped_force` mean NO
//     CHECK WAS MADE, and an empty `lockedDatabases` under either of them must
//     never be rendered as "nothing was running".
//
// The store rows and the archive rows are NOT `FeedbackRow`s: neither
// `included`/`excluded` nor `changed`/`unchanged`/`absent`/`unknown` is a
// `RowStatus`, and painting `✓ ok` on an included store would be a word the
// wire never said. They are the same `.activity-row` markup with their own two
// columns — the row language, not a fork of it.

import { App as AntApp, Button, Form, Input, InputNumber, Select, Switch, Typography } from 'antd';
import { useState } from 'react';
import { shellQuote } from '../../../components/mcp/AddMcpModal';
import { FeedbackRow } from '../../../components/ui/FeedbackRow';
import { backupDownloadHref } from '../../../features/settings/api/backup';
import {
  useBackupCreate,
  useBackupRestoreIdentity,
} from '../../../features/settings/api/backup-mutations';
import { useBackupStatus } from '../../../features/settings/api/backup-queries';
import { formatBytes } from '../../../lib/attachments';
import type { RowStatus } from '../../../lib/trail';
import type { rpc } from '../../../rpc';
import { SectionHeading } from '../components/section-heading';
import { SelfSaveMarker } from '../components/self-save-marker';
import { SettingRow } from '../components/setting-row';

type BackupStatusData = Awaited<ReturnType<typeof rpc.backup.status>>;
type BackupStoreRow = BackupStatusData['stores'][number];
type BackupArchive = BackupStatusData['archives'][number];
type BackupSchedule = BackupStatusData['schedule'];
type RestoreReport = Awaited<ReturnType<typeof rpc.backup.restoreIdentity>>;
type CreateReport = Awaited<ReturnType<typeof rpc.backup.create>>;

/** While a create is in flight, or while the restart notice is unresolved. */
const POLL_MS = 3000;

// ---------------------------------------------------------------------------
// The rows this page keeps
// ---------------------------------------------------------------------------

export interface BackupActionRowView {
  id: string;
  /** Mono subject — the archive name, or `backup` before there is one. */
  subject: string;
  status: RowStatus;
  result?: string;
  meta?: string;
  /** Lines under the row: what a report says beyond its one-line outcome. */
  detail: string[];
}

export function BackupActionRow({ row }: { row: BackupActionRowView }) {
  return (
    <div className="settings-backup-action">
      <FeedbackRow
        status={row.status}
        subject={row.subject}
        {...(row.result ? { result: row.result } : {})}
        {...(row.meta ? { meta: row.meta } : {})}
      />
      {row.detail.length > 0 ? (
        <ul className="settings-backup-detail">
          {row.detail.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pure view logic — exported so the states are testable without a click
// ---------------------------------------------------------------------------

/** Coarse "how long ago", the same vocabulary the satellite rows use. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return iso;
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** `Next run: 04:00`, or the honest absence of one. */
export function nextRunLabel(schedule: BackupSchedule): string {
  if (!schedule.enabled) return 'Next run: never — the schedule is off';
  if (!schedule.nextRunAt) return 'Next run: unscheduled — no scheduler is running here';
  const at = new Date(schedule.nextRunAt);
  if (Number.isNaN(at.getTime())) return `Next run: ${schedule.nextRunAt}`;
  const hh = String(at.getHours()).padStart(2, '0');
  const mm = String(at.getMinutes()).padStart(2, '0');
  return `Next run: ${hh}:${mm}`;
}

export interface GlyphWord {
  glyph: string;
  word: string;
  /** CSS modifier suffix, so colour is the third signal and never the only one. */
  tone: string;
}

export function storeInclusion(store: BackupStoreRow): GlyphWord {
  return store.included
    ? { glyph: '✓', word: 'included', tone: 'included' }
    : { glyph: '–', word: 'excluded', tone: 'excluded' };
}

/**
 * All FOUR values, distinctly. `absent` and `unknown` are not "no dot": they
 * are two different facts, and collapsing either into `unchanged` would claim
 * a comparison that never happened.
 */
export function storeChanged(store: BackupStoreRow): GlyphWord {
  switch (store.changed) {
    case 'changed':
      return { glyph: '●', word: 'changed', tone: 'changed' };
    case 'unchanged':
      return { glyph: '○', word: 'unchanged', tone: 'unchanged' };
    case 'absent':
      return { glyph: '⊘', word: 'absent', tone: 'absent' };
    default:
      return { glyph: '?', word: 'unknown', tone: 'unknown' };
  }
}

/**
 * Whether the in-use gate RAN, said in words. Two of the three values mean no
 * check was made, and an empty `lockedDatabases` under those means nothing was
 * asked — never that nothing was running.
 */
export function inUseCheckLine(report: RestoreReport): string {
  if (report.inUseCheck === 'skipped_dry_run') {
    return 'In-use check: not made — a dry run cannot ask without writing, so nothing was proved idle.';
  }
  if (report.inUseCheck === 'skipped_force') {
    return 'In-use check: not made — force was used, so nothing was proved idle.';
  }
  if (report.lockedDatabases.length === 0) {
    return 'In-use check: held — no database was in the way of this restore.';
  }
  return `In-use check: held — ${report.lockedDatabases.join(', ')} kept idle for the restore.`;
}

/** The confirm body: what this overwrites, before it overwrites it. */
export function restoreConfirmContent(archiveName: string): string {
  return (
    `Restore identity from ${archiveName}? This overwrites config.yaml, mcp.json, MEMORY.md, ` +
    'USER.md, cron/jobs.json and every personality under ~/.ethos/personalities/ with the ' +
    'archive’s copies. The current files are moved into ~/.ethos/.pre-restore/ first. ' +
    'Conversation history, skills, teams and the secrets vault are not touched — a running ' +
    'server holds those databases open, so restoring them is a CLI operation.'
  );
}

/**
 * `ethos import …` — the full restore this pane cannot do (D6).
 *
 * The archive path is QUOTED, as one word. This line exists to be pasted into a
 * shell, and neither half of the path is ours: `backup.dir` is operator-typed
 * config, and `listArchives` returns any regular file ending `.tar.gz`, so the
 * filename is whatever is sitting in that directory rather than something Ethos
 * generated. Unquoted, a space breaks the command in two and a `;`, a backtick
 * or a `$(…)` in either half runs when the operator pastes it.
 *
 * `shellQuote` is IMPORTED, not copied for the seventh time. `AddMcpModal` is
 * the one copy in this repo that is exported, it composes its own paste line
 * for the same reason, and it is in `apps/web` alongside this pane — no layer
 * is crossed and no chunk is merged (`App.tsx` imports every route eagerly).
 * The other five copies are module-private in packages this file may not reach.
 *
 * The scopes are not quoted: they are literals in this template, not values.
 */
export function cliRestoreCommand(directory: string, archiveName: string): string {
  return `ethos import ${shellQuote(`${directory}/${archiveName}`)} --scope identity,state --secrets prompt`;
}

/**
 * Create and Restore disable each other while either is in flight.
 *
 * SUPPLEMENTARY, and only that: the guarantee is `BackupService`'s in-process
 * operation lock, which refuses the loser with a FORBIDDEN naming what is
 * running, whatever this page happens to show. A create archives `config.yaml`
 * and `personalities/` while a restore renames those same paths in and out of
 * `.pre-restore/`; a disabled button cannot prevent that, because a second tab,
 * a stale page or a direct RPC call never sees it. What this does buy is that
 * the pane stops OFFERING an action the server is about to refuse.
 *
 * `statusRunning` is the server's own answer (another tab's create counts);
 * the two `isPending` flags are this page's in-flight mutations.
 */
export function actionsDisabled(input: {
  statusRunning: boolean;
  creating: boolean;
  restoring: boolean;
}): { create: boolean; restore: boolean } {
  const busy = input.statusRunning || input.creating || input.restoring;
  return { create: busy, restore: busy };
}

export function createOutcome(report: CreateReport): BackupActionRowView {
  const detail = [
    `${report.fileCount} files · ${formatBytes(report.uncompressedBytes)} uncompressed · scopes ${report.scopes.join(', ')}`,
  ];
  // Both are reported rather than fatal, and both MUST be surfaced: a silent
  // drop is the failure mode a backup cannot have.
  for (const skipped of report.skipped) {
    detail.push(`⚠ skipped ${skipped.path} — ${skipped.reason}`);
  }
  if (report.unclassifiedDatabases.length > 0) {
    detail.push(
      `⚠ no scope rule accounts for ${report.unclassifiedDatabases.join(', ')} — it is not in this archive.`,
    );
  }
  return {
    id: report.archive.name,
    subject: report.archive.name,
    status: 'ok',
    result: formatBytes(report.archive.bytes),
    meta: 'just now',
    detail,
  };
}

export function restoreOutcome(id: string, report: RestoreReport): BackupActionRowView {
  const detail = [inUseCheckLine(report)];
  if (report.displaced.length > 0 && report.displacedTo) {
    detail.push(`${report.displaced.length} existing files moved to ${report.displacedTo}`);
  }
  for (const warning of report.warnings) detail.push(`⚠ ${warning.path} — ${warning.message}`);
  if (report.secretsManifest) {
    detail.push(
      'The archive carries a secrets manifest naming credentials it does not contain. ' +
        'Refill them with `ethos import <archive> --secrets prompt`.',
    );
  }
  const verb = report.dryRun ? 'would restore' : 'restored';
  return {
    id,
    subject: id,
    status: 'ok',
    result: `${verb} ${report.restored.length} files · archived ${relativeAge(report.createdAt)}`,
    detail,
  };
}

/**
 * The restart notice keys off `serverStartedAt` and nothing else. Pin the value
 * seen when `restartRequired` came back; a later status carrying a DIFFERENT
 * one is the only proof the restart happened. No status at all (the server is
 * down, mid-restart) is not proof, so the notice stays.
 */
export function restartNoticeVisible(pinnedAt: string | null, serverStartedAt?: string): boolean {
  if (pinnedAt === null) return false;
  if (serverStartedAt === undefined) return true;
  return serverStartedAt === pinnedAt;
}

/** Not dismissable: dismissing a true statement does not make it false. */
export function BackupRestartNotice() {
  return (
    <div className="settings-backup-notice">
      <span className="settings-backup-notice-state">
        <span aria-hidden="true">⚠</span> restart required
      </span>
      <span>
        config.yaml and mcp.json are read at boot, so this server is still running the old ones.
        Restart Ethos to apply what was restored.
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export function BackupPane() {
  const { modal } = AntApp.useApp();
  const [rows, setRows] = useState<BackupActionRowView[]>([]);
  const [restartPinnedAt, setRestartPinnedAt] = useState<string | null>(null);

  const createMut = useBackupCreate();
  const restoreMut = useBackupRestoreIdentity();
  // A pinned restart notice is the one thing only this pane knows is pending;
  // a create in flight polls itself (see `useBackupStatus`).
  const statusQuery = useBackupStatus(restartPinnedAt !== null ? POLL_MS : false);
  const status = statusQuery.data;

  const showRestart = restartNoticeVisible(restartPinnedAt, status?.serverStartedAt);
  // `running` is the CREATE label's condition — a restore in flight must not
  // make the button say "Creating backup…". What each button may be CLICKED
  // for is `disabled`, which is the mutual exclusion.
  const running = status?.running === true || createMut.isPending;
  const disabled = actionsDisabled({
    statusRunning: status?.running === true,
    creating: createMut.isPending,
    restoring: restoreMut.isPending,
  });

  const upsert = (row: BackupActionRowView) =>
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.id === row.id);
      if (idx < 0) return [...prev, row];
      // Resolve IN PLACE — the row that was running becomes the row that says
      // what happened; it is never removed and never replaced by a toast.
      const next = [...prev];
      next[idx] = row;
      return next;
    });

  const create = () => {
    const id = `create-${Date.now()}`;
    upsert({ id, subject: 'backup', status: 'running', result: 'Creating backup…', detail: [] });
    createMut.mutate(
      {},
      {
        onSuccess: (report) => upsert({ ...createOutcome(report), id }),
        onError: (err) =>
          upsert({
            id,
            subject: 'backup',
            status: 'failed',
            result: (err as Error).message,
            detail: [],
          }),
      },
    );
  };

  const restore = (archive: BackupArchive) => {
    modal.confirm({
      title: 'Restore identity',
      content: restoreConfirmContent(archive.name),
      okText: 'Restore identity',
      okButtonProps: { danger: true },
      onOk: () => {
        const id = `restore-${archive.name}`;
        upsert({
          id,
          subject: archive.name,
          status: 'running',
          result: 'Restoring identity…',
          detail: [],
        });
        restoreMut.mutate(
          { name: archive.name },
          {
            onSuccess: (report) => {
              upsert({ ...restoreOutcome(archive.name, report), id });
              if (report.restartRequired && !report.dryRun && status) {
                setRestartPinnedAt(status.serverStartedAt);
              }
            },
            onError: (err) =>
              upsert({
                id,
                subject: archive.name,
                status: 'failed',
                result: `restore failed: ${(err as Error).message}`,
                detail: [],
              }),
          },
        );
      },
    });
  };

  // The schedule fields render even here, and that is not defensive padding:
  // `backup.status` resolves `backup.*` through `resolveBackupSettings`, which
  // THROWS on a `keep` or a scope name config cannot use. Those are the very
  // fields below, so a pane that bailed out entirely would show the operator
  // the error and then hide the only place to fix it.
  if (statusQuery.error) {
    return (
      <>
        <SectionHeading id="status">status</SectionHeading>
        <FeedbackRow
          status="failed"
          subject="backup.status"
          result={(statusQuery.error as Error).message}
        />
        <SectionHeading id="schedule">schedule</SectionHeading>
        <ScheduleFields directory={null} />
      </>
    );
  }
  if (!status) {
    return <Typography.Text type="secondary">Reading the backup directory…</Typography.Text>;
  }

  // The newest archive is the one an operator would restore; with none, the
  // command still shows the shape, with the placeholder visible as a placeholder.
  const cliCommand = cliRestoreCommand(status.directory, status.archives[0]?.name ?? '<archive>');

  return (
    <>
      <SectionHeading id="status">status</SectionHeading>
      {showRestart ? <BackupRestartNotice /> : null}
      <div className="settings-backup-header">
        <div className="settings-backup-header-status">
          <StatusAnchor status={status} running={running} />
          <div className="settings-backup-meta">
            {nextRunLabel(status.schedule)} · configured scopes {status.schedule.scopes.join(', ')}{' '}
            · keeps {status.schedule.keep}
          </div>
        </div>
        <div className="settings-backup-header-action">
          <Button
            type="primary"
            disabled={disabled.create}
            onClick={create}
            style={{ minHeight: 44 }}
            className="settings-backup-create"
          >
            {running ? 'Creating backup…' : 'Create backup'}
          </Button>
          <SelfSaveMarker />
        </div>
      </div>

      {rows.map((row) => (
        <BackupActionRow key={row.id} row={row} />
      ))}

      <div className="settings-backup-subhead">stores</div>
      <div className="settings-backup-help">
        What a backup in the configured scopes would hold, and what has changed since the last
        archive. <span className="settings-backup-mono">absent</span> — this deployment has never
        created the database; <span className="settings-backup-mono">unknown</span> — there is no
        archive to compare against yet.
      </div>
      {status.stores.map((store) => (
        <StoreRow key={store.database} store={store} />
      ))}

      <SectionHeading id="archives">archives</SectionHeading>
      <div className="settings-backup-help">
        Archives in <span className="settings-backup-mono">{status.directory}</span>. A{' '}
        <span className="settings-backup-mono">state</span> archive holds conversation history —
        treat it as sensitive. <SelfSaveMarker />
      </div>
      {status.downloadAvailable ? null : (
        <div className="settings-backup-help">
          Downloads are unavailable for this session: the streaming route is cookie-authenticated
          and this client is not. Copy the file off the server by path, or run{' '}
          <span className="settings-backup-mono">ethos backup --out &lt;path&gt;</span> there.
        </div>
      )}
      {status.archives.length === 0 ? (
        <div className="settings-backup-empty">No archives yet.</div>
      ) : (
        status.archives.map((archive) => (
          <ArchiveRow
            key={archive.name}
            archive={archive}
            directory={status.directory}
            downloadAvailable={status.downloadAvailable}
            onRestore={() => restore(archive)}
            busy={disabled.restore}
          />
        ))
      )}
      <div className="settings-backup-subhead">full restore</div>
      <div className="settings-backup-help">
        This page restores <span className="settings-backup-mono">identity</span> only — a running
        server holds every database open, so a <span className="settings-backup-mono">state</span>{' '}
        restore is refused here. Stop Ethos and run:
      </div>
      <Typography.Paragraph className="settings-backup-cli" copyable={{ text: cliCommand }}>
        <code>{cliCommand}</code>
      </Typography.Paragraph>

      <SectionHeading id="schedule">schedule</SectionHeading>
      <ScheduleFields directory={status.directory} />
      {status.schedule.lastRunAt ? (
        <FeedbackRow
          status={status.schedule.lastError ? 'failed' : 'ok'}
          subject="scheduled run"
          {...(status.schedule.lastError ? { result: status.schedule.lastError } : {})}
          meta={relativeAge(status.schedule.lastRunAt)}
        />
      ) : null}
    </>
  );
}

/** The header's anchor: what the last backup was, or that there has been none. */
function StatusAnchor({ status, running }: { status: BackupStatusData; running: boolean }) {
  if (running) {
    // No size: there is no progress seam through `createBackup`, and the only
    // thing underneath counts PAGES, not bytes. `status.running` is a boolean.
    return <FeedbackRow status="running" subject="backup" result="Creating backup…" />;
  }
  const last = status.lastBackup;
  if (!last) {
    return (
      <div className="settings-backup-empty">
        <strong>No backup yet.</strong> A backup copies this agent&rsquo;s configuration,
        personalities, memory and conversation history into one file you can move to another
        machine.
      </div>
    );
  }
  if (!last.ok) {
    return (
      <FeedbackRow
        status="failed"
        subject={last.archive?.name ?? 'backup'}
        result={last.error ?? 'The last backup attempt failed.'}
        meta={relativeAge(last.at)}
      />
    );
  }
  return (
    <FeedbackRow
      status="ok"
      subject={last.archive?.name ?? 'backup'}
      {...(last.archive ? { result: formatBytes(last.archive.bytes) } : {})}
      meta={relativeAge(last.at)}
    />
  );
}

function StoreRow({ store }: { store: BackupStoreRow }) {
  const inclusion = storeInclusion(store);
  const changed = storeChanged(store);
  return (
    <div className="activity-row settings-backup-store">
      <span className="activity-row-subject">{store.database}</span>
      <span className={`settings-backup-cell settings-backup-cell--${inclusion.tone}`}>
        <span aria-hidden="true">{inclusion.glyph}</span> {inclusion.word}
      </span>
      <span className={`settings-backup-cell settings-backup-cell--${changed.tone}`}>
        <span aria-hidden="true">{changed.glyph}</span> {changed.word}
      </span>
      <span className="activity-row-result">{store.reason}</span>
    </div>
  );
}

function ArchiveRow({
  archive,
  directory,
  downloadAvailable,
  onRestore,
  busy,
}: {
  archive: BackupArchive;
  directory: string;
  downloadAvailable: boolean;
  onRestore: () => void;
  /** A create OR a restore is in flight — see `actionsDisabled`. */
  busy: boolean;
}) {
  return (
    <div className="activity-row settings-backup-archive">
      <span className="activity-row-subject">{archive.name}</span>
      <span className="settings-backup-cell">
        {archive.scheduled ? 'scheduled' : 'manual'} · {formatBytes(archive.bytes)}
      </span>
      <span className="activity-row-meta">{relativeAge(archive.createdAt)}</span>
      {downloadAvailable ? (
        <a className="settings-backup-link" href={backupDownloadHref(archive.name)} download>
          Download
        </a>
      ) : (
        <span className="settings-backup-mono settings-backup-path">
          {directory}/{archive.name}
        </span>
      )}
      <Button size="small" onClick={onRestore} disabled={busy}>
        Restore identity
      </Button>
    </div>
  );
}

/**
 * The schedule, as five page-Save rows written by `config.update` into
 * `backup.*` — the same Save bar every other pane uses.
 *
 * Blank is a real value here: every default except `enabled` is COMPUTED
 * (`resolveBackupSettings` in `@ethosagent/wiring`, and `dir` from `ethosDir()`
 * — `${ETHOS_HOME}` is not a token config.yaml expands, D5), so the fields
 * carry the default as a placeholder and write nothing when left empty. That
 * is what keeps a saved config from pinning today's computed directory as
 * though the operator had chosen it.
 *
 * Neither `keep` nor `scope` is validated here. `packages/config` already
 * rejects a `backup.keep` that is not a positive integer and
 * `@ethosagent/wiring`'s `parseScopes` already rejects an unknown scope when
 * the backup runs; a second copy of either rule in this pane is the drift
 * those single sources exist to prevent. `keep`'s `InputNumber` bounds are an
 * affordance — they make the rejected value hard to type — not a second rule
 * with a second error message.
 */
function ScheduleFields({ directory }: { directory: string | null }) {
  return (
    <>
      <SettingRow
        label="Scheduled backups"
        formName="backup.enabled"
        help="Nightly local snapshot of ~/.ethos, run by ethos serve / ethos gateway (backup.enabled). On unless you turn it off."
      >
        <Form.Item name={['backup', 'enabled']} valuePropName="checked" style={{ marginBottom: 0 }}>
          <Switch />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Backup schedule"
        formName="backup.cron"
        help="5-field cron (backup.cron). Blank = 0 4 * * *."
      >
        <Form.Item name={['backup', 'cron']} style={{ marginBottom: 0 }}>
          <Input style={{ fontFamily: 'Geist Mono, monospace' }} placeholder="0 4 * * *" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Backup scopes"
        formName="backup.scope"
        help="Which parts of ~/.ethos an archive holds (backup.scope). Blank = identity,state. A name is checked when the backup runs, not when you save it, so a typo shows up as a failed status above."
      >
        <Form.Item name={['backup', 'scope']} style={{ marginBottom: 0 }}>
          <Select
            mode="tags"
            open={false}
            suffixIcon={null}
            tokenSeparators={[',']}
            placeholder="identity, state"
          />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Archives kept"
        formName="backup.keep"
        help="Scheduled archives rotation keeps (backup.keep). Blank = 7."
      >
        <Form.Item name={['backup', 'keep']} style={{ marginBottom: 0 }}>
          <InputNumber min={1} precision={0} style={{ width: '100%' }} placeholder="7" />
        </Form.Item>
      </SettingRow>
      <SettingRow
        label="Backup directory"
        formName="backup.dir"
        advanced
        help="Where archives are written (backup.dir). Blank = <ethos data dir>/backups; a relative path resolves under the data dir, and ${ETHOS_HOME} is not expanded."
      >
        <Form.Item name={['backup', 'dir']} style={{ marginBottom: 0 }}>
          <Input
            style={{ fontFamily: 'Geist Mono, monospace' }}
            placeholder={directory ?? '/home/you/.ethos/backups'}
          />
        </Form.Item>
      </SettingRow>
    </>
  );
}
