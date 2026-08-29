import { statSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { ethosDir, readRawConfig } from '@ethosagent/config';
import {
  archiveMonth,
  BlobStore,
  getSqliteStats,
  listArchives,
  mergeRetentionConfig,
  ObservabilityService,
  pruneObservabilityByPath,
  SQLiteObservabilityStore,
} from '@ethosagent/observability-sqlite';
import { RETENTION_DEFAULTS } from '@ethosagent/types';
import { EthosObservability } from '@ethosagent/wiring';
import { writeJson } from '../json-output';
import { getEthosObservability, getStorage } from '../wiring';

// ---------------------------------------------------------------------------
// ethos data stats
// ethos data prune [--dry-run] [--category <name>] [--older-than <duration>]
// ethos data reset [--dry-run] [--blobs-only]
// ethos data archive list
// ethos data recompute-costs [--json]
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes >= 1_073_741_824) return `${(bytes / 1_073_741_824).toFixed(1)} GB`;
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(0)} MB`;
  if (bytes >= 1_024) return `${(bytes / 1_024).toFixed(0)} KB`;
  return `${bytes} B`;
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function dirSize(path: string): Promise<number> {
  const storage = getStorage();
  try {
    let total = 0;
    const entries = await storage.listEntries(path);
    for (const e of entries) {
      const p = join(path, e.name);
      if (e.isDir) {
        total += await dirSize(p);
      } else {
        total += fileSize(p);
      }
    }
    return total;
  } catch {
    return 0;
  }
}

async function countFiles(path: string, ext?: string): Promise<number> {
  const storage = getStorage();
  try {
    const names = await storage.list(path);
    let count = 0;
    for (const name of names) {
      if (!ext || name.endsWith(ext)) count++;
    }
    return count;
  } catch {
    return 0;
  }
}

function parseFlags(argv: string[]): {
  dryRun: boolean;
  blobsOnly: boolean;
  category?: string;
  olderThan?: string;
  personality?: string;
  positional: string[];
} {
  const positional: string[] = [];
  let dryRun = false;
  let blobsOnly = false;
  let category: string | undefined;
  let olderThan: string | undefined;
  let personality: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--blobs-only') {
      blobsOnly = true;
    } else if (a === '--category' && argv[i + 1]) {
      category = argv[i + 1];
      i++;
    } else if (a === '--older-than' && argv[i + 1]) {
      olderThan = argv[i + 1];
      i++;
    } else if ((a === '--personality' || a === '-p') && argv[i + 1]) {
      personality = argv[i + 1];
      i++;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  return { dryRun, blobsOnly, category, olderThan, personality, positional };
}

async function runStats(argv: string[]): Promise<void> {
  const dir = ethosDir();

  const sessDbPath = join(dir, 'sessions.db');
  const obsDbPath = join(dir, 'observability.db');
  const blobsDir = join(dir, 'blobs');
  const archiveDir = join(dir, 'archive');

  const sessSize = fileSize(sessDbPath);
  const obsSize = fileSize(obsDbPath);
  const [blobsSize, archiveSize, blobCount, archiveCount] = await Promise.all([
    dirSize(blobsDir),
    dirSize(archiveDir),
    countFiles(blobsDir),
    countFiles(archiveDir, '.tar.gz'),
  ]);

  if (argv.includes('--json')) {
    writeJson({
      sessionsDb: { exists: sessSize > 0, sizeBytes: sessSize },
      observabilityDb: { exists: obsSize > 0, sizeBytes: obsSize },
      blobs: { exists: blobsSize > 0, sizeBytes: blobsSize },
      archive: { exists: archiveSize > 0, sizeBytes: archiveSize },
    });
    return;
  }

  console.log('\nData stats — ~/.ethos/');
  console.log('══════════════════════');
  console.log('WARM CRITICAL PATH');

  let sessDbExtra = '';
  const sessStats = getSqliteStats(sessDbPath);
  if (sessStats) {
    sessDbExtra =
      sessStats.totalBytes === sessSize ? '' : ` (pragma: ${formatBytes(sessStats.totalBytes)})`;
  }
  console.log(`  sessions.db      ${formatBytes(sessSize)}${sessDbExtra}`);

  console.log('COLD DROPPABLE PATH');
  console.log(`  observability.db ${formatBytes(obsSize)}`);
  console.log(`  blobs/           ${formatBytes(blobsSize)}  (${blobCount} files)`);
  console.log(`  archive/         ${formatBytes(archiveSize)}  (${archiveCount} .tar.gz)`);
  console.log();
}

async function runPrune(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const storage = getStorage();
  const config = await readRawConfig(storage);

  const globalRetention = config?.retention;
  const baseConfig = mergeRetentionConfig(RETENTION_DEFAULTS, globalRetention ?? {});
  const personalityRetention = flags.personality
    ? config?.personalitiesConfig?.[flags.personality]?.retention
    : undefined;
  const merged = personalityRetention
    ? mergeRetentionConfig(baseConfig, personalityRetention)
    : baseConfig;

  // If --older-than and --category, override the specific category for this run
  const effectiveConfig = { ...merged };
  if (flags.olderThan && flags.category) {
    const cat = flags.category;
    const dur = flags.olderThan;
    if (cat === 'traces') effectiveConfig.traces = dur;
    else if (cat === 'spans') effectiveConfig.spans = dur;
    else if (cat === 'events.error')
      effectiveConfig.events = { ...effectiveConfig.events, error: dur };
    else if (cat === 'events.audit')
      effectiveConfig.events = { ...effectiveConfig.events, audit: dur };
    else if (cat === 'events.channel')
      effectiveConfig.events = { ...effectiveConfig.events, channel: dur };
    else if (cat === 'events.install')
      effectiveConfig.events = { ...effectiveConfig.events, install: dur };
  }

  const dir = ethosDir();
  const obsDbPath = join(dir, 'observability.db');
  const sessDbPath = join(dir, 'sessions.db');

  if (!fileSize(obsDbPath)) {
    console.log('No observability.db found — nothing to prune.');
    return;
  }

  const result = pruneObservabilityByPath(obsDbPath, effectiveConfig, {
    dryRun: flags.dryRun,
    sessDbPath,
  });
  const prefix = flags.dryRun ? 'Would prune' : 'Pruned';
  console.log(
    `${prefix} ${result.traces} trace(s), ${result.spans} span(s), ${result.events} event(s), ${result.snapshots} orphaned snapshot(s), ${result.messages} message(s).`,
  );
  if (flags.dryRun) {
    console.log('(Dry run — no changes made)');
  }
}

async function runReset(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const dir = ethosDir();

  const obsDbPath = join(dir, 'observability.db');
  const obsWalPath = `${obsDbPath}-wal`;
  const obsShmPath = `${obsDbPath}-shm`;
  const blobsDir = join(dir, 'blobs');
  const archiveDir = join(dir, 'archive');

  const obsSize = fileSize(obsDbPath);
  const [blobsSize, archiveSize] = await Promise.all([dirSize(blobsDir), dirSize(archiveDir)]);

  console.log('\nThis will delete:');
  if (!flags.blobsOnly) {
    console.log(`  observability.db  ${formatBytes(obsSize)}`);
    console.log(`  archive/          ${formatBytes(archiveSize)}`);
  }
  console.log(`  blobs/            ${formatBytes(blobsSize)}`);
  console.log('\n  sessions.db will be preserved.');
  console.log();

  if (flags.dryRun) {
    console.log('(Dry run — no changes made)');
    return;
  }

  // Prompt for confirmation
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question('Type RESET to confirm: ', resolve);
  });
  rl.close();

  if (answer.trim() !== 'RESET') {
    console.log('Cancelled.');
    return;
  }

  const storage = getStorage();
  const killSwitchPath = join(dir, '.observability.disabled');

  // Signal active writers to skip writes during the reset window.
  await storage.writeAtomic(killSwitchPath, `reset started at ${new Date().toISOString()}`);

  try {
    if (!flags.blobsOnly) {
      for (const p of [obsDbPath, obsWalPath, obsShmPath]) {
        try {
          await storage.remove(p);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      try {
        await storage.remove(archiveDir, { recursive: true });
      } catch {
        // ignore
      }
    }

    try {
      await storage.remove(blobsDir, { recursive: true });
    } catch {
      // ignore
    }

    if (!flags.blobsOnly) {
      // Recreate the observability.db with all tables
      const blobStore = new BlobStore(join(dir, 'blobs'), storage);
      const store = new SQLiteObservabilityStore(obsDbPath);
      try {
        const svc = new ObservabilityService(store, blobStore);
        new EthosObservability(svc).recordInstallEvent({
          code: 'data.reset',
          cause: 'User-initiated reset',
        });
      } finally {
        store.close();
      }
      console.log('\nReset complete. observability.db recreated.');
      console.log('  observability.db recreated with empty schema');
      console.log('  archive/ removed');
    } else {
      console.log('\nReset complete. blobs/ removed.');
    }
    console.log('  blobs/ removed');
    console.log('  sessions.db untouched');
    console.log();
  } finally {
    // Remove kill-switch regardless of success or failure — writers must resume.
    try {
      await storage.remove(killSwitchPath);
    } catch {
      // ignore if already gone
    }
  }
}

// ---------------------------------------------------------------------------
// ethos data recompute-costs
// ---------------------------------------------------------------------------
//
// A5 backfill. Fixing the emitters does nothing for the numbers already on
// disk: three providers wrote $0 for every call and llm-anthropic priced
// unrecognised `claude-*` ids at Sonnet rates. This re-derives every stored
// message cost from its stored token counts through the one rate table, and
// rebuilds the session rollups that cache their sum.
async function runRecomputeCosts(argv: string[]): Promise<void> {
  const sessDbPath = join(ethosDir(), 'sessions.db');
  if (!fileSize(sessDbPath)) {
    console.log('No sessions.db found — nothing to recompute.');
    return;
  }

  const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
  const store = new SQLiteSessionStore(sessDbPath);
  let result: Awaited<ReturnType<typeof store.recomputeMessageCosts>>;
  try {
    result = await store.recomputeMessageCosts();
  } finally {
    store.close();
  }

  getEthosObservability().recordCostRecompute({
    code: 'data.recompute_costs',
    messagesScanned: result.messagesScanned,
    messagesUpdated: result.messagesUpdated,
    sessionsUpdated: result.sessionsUpdated,
    unpricedModels: result.unpricedModels,
  });

  if (argv.includes('--json')) {
    writeJson(result);
    return;
  }

  console.log(
    `Recomputed ${result.messagesScanned} message(s): ${result.messagesUpdated} cost(s) rewritten, ` +
      `${result.sessionsUpdated} session rollup(s) rebuilt.`,
  );
  if (result.unpricedModels.length > 0) {
    console.log(
      `  No rate for: ${result.unpricedModels.join(', ')} — those rows are recorded as $0.`,
    );
  }
}

async function runArchiveCommand(argv: string[]): Promise<void> {
  const dir = ethosDir();
  const archiveDir = join(dir, 'archive');
  const obsDbPath = join(dir, 'observability.db');
  const storage = getStorage();

  const archiveSub = argv[0] ?? 'list';

  if (archiveSub === 'list') {
    const archives = await listArchives(storage, archiveDir);
    if (archives.length === 0) {
      console.log('No archives found.');
      return;
    }
    console.log('\nArchives — ~/.ethos/archive/');
    console.log('══════════════════════════════');
    for (const { month, path } of archives) {
      const size = fileSize(path);
      console.log(`  ${month.padEnd(10)} ${formatBytes(size)}`);
    }
    console.log();
    return;
  }

  // `ethos data archive [--month YYYY-MM]` — create an archive for a given month
  let month: string | undefined;
  let dryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '--month' && argv[i + 1]) {
      month = argv[i + 1];
      i++;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (!a.startsWith('-') && /^\d{4}-\d{2}$/.test(a)) {
      month = a;
    }
  }

  if (!month) {
    // Default: archive the previous calendar month
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  if (!/^\d{4}-\d{2}$/.test(month)) {
    console.error(`Invalid month format: "${month}". Use YYYY-MM.`);
    process.exit(1);
  }

  if (!fileSize(obsDbPath)) {
    console.log('No observability.db found — nothing to archive.');
    return;
  }

  if (dryRun) {
    console.log(`Would archive ${month} from observability.db (dry run — no changes made).`);
    return;
  }

  console.log(`Archiving ${month}...`);
  const result = await archiveMonth(obsDbPath, storage, archiveDir, month);
  if (result.traces === 0) {
    console.log(`No completed traces found for ${month}.`);
    return;
  }
  console.log(
    `Archived ${result.traces} trace(s), ${result.spans} span(s), ${result.events} event(s), ${result.snapshots} snapshot(s) → archive/${month}.tar.gz`,
  );
}

export async function runData(sub: string, argv: string[]): Promise<void> {
  if (sub === 'stats' || sub === '') {
    await runStats(argv);
    return;
  }

  if (sub === 'prune') {
    await runPrune(argv);
    return;
  }

  if (sub === 'reset') {
    await runReset(argv);
    return;
  }

  if (sub === 'archive') {
    await runArchiveCommand(argv);
    return;
  }

  if (sub === 'recompute-costs') {
    await runRecomputeCosts(argv);
    return;
  }

  console.log(
    'Usage: ethos data [stats | prune [--dry-run] [--personality <id>] | reset [--dry-run] [--blobs-only] | archive [list | --month YYYY-MM | --dry-run] | recompute-costs [--json]]',
  );
}
