const _nodeMajor = Number(process.versions.node.split('.')[0]);
if (_nodeMajor < 24) {
  process.stderr.write(
    `Ethos requires Node 24 or later (current: ${process.version}).\n` +
      'Install it with: nvm install 24 && nvm alias default 24\n',
  );
  process.exit(1);
}

// Shebang `#!/usr/bin/env node` is added by tsup via banner config at build time.
// Don't put it here - tsx in dev mode doesn't need it and source-level shebangs
// in TypeScript trip on tsup's bundler.
import { join } from 'node:path';
import { ethosDir, readConfig } from '@ethosagent/config';
import { reconcileRegistry } from '@ethosagent/tools-process';
import { formatError, toEthosError } from '@ethosagent/types';
import { applyCliOverrides, parseCliOverrideFlags } from './cli-overrides';
import { runA2a } from './commands/a2a';
import { runAcp } from './commands/acp';
import { runApiKey } from './commands/api-key';
import { runArchive } from './commands/archive';
import { runAudit } from './commands/audit';
import { runBackup, runImport } from './commands/backup';
import { runBatch } from './commands/batch';
import { runBench } from './commands/bench';
import { runCas } from './commands/cas';
import { runChat } from './commands/chat';
import { runClaw } from './commands/claw';
import { runCommands } from './commands/commands';
import { runCronCommand } from './commands/cron';
import { runDashboard } from './commands/dashboard';
import { runData } from './commands/data';
import { runDoctor } from './commands/doctor';
import { runErrors } from './commands/errors';
import { runEval } from './commands/eval';
import { runEvolve } from './commands/evolve';
import { runFallback } from './commands/fallback';
import { runGatewayStart } from './commands/gateway';
import { runKeys } from './commands/keys';
import { runLearn } from './commands/learn';
import { runLogs } from './commands/logs';
import { runMcp } from './commands/mcp';
import { runMeshCommand } from './commands/mesh';
import { runPerf } from './commands/perf';
import { runPlugin } from './commands/plugin';
import { runProcessCommand } from './commands/process';
import { runRequestDump } from './commands/request-dump';
import { runRetention } from './commands/retention';
import { runAll } from './commands/run-all';
import { runSecrets } from './commands/secrets';
import { runSecurityAudit } from './commands/security-audit';
import { runServe } from './commands/serve';
import { runSessionsCommand } from './commands/sessions';
import { runSet } from './commands/set';
import { runSetup } from './commands/setup';
import { runSkills } from './commands/skills';
import { runSlackManifest } from './commands/slack-manifest';
import { runStatus } from './commands/status';
import { runSupport } from './commands/support';
import { runTail } from './commands/tail';
import { runTeamCommand } from './commands/team';
import { runTrace } from './commands/trace';
import { runUpgrade } from './commands/upgrade';
import { runWhy } from './commands/why';
import { appendErrorLog } from './error-log';
import { writeJson } from './json-output';
import { CliSubcommandRegistry } from './lib/cli-subcommand-registry';
import { loadRequiredConfig } from './managed-mode';
import { getSecretsResolver, getStorage } from './wiring';

// Compile-time injected by tsup via define (or read from env at runtime in dev).
declare const __ETHOS_VERSION__: string;
const ETHOS_VERSION =
  typeof __ETHOS_VERSION__ === 'string' ? __ETHOS_VERSION__ : (process.env.ETHOS_VERSION ?? 'dev');

const USAGE =
  'Usage: ethos [-z <prompt> | setup | chat | sessions | serve | boot | dashboard | status | run-all | set | team | mesh | a2a | process | logs | gateway | listen | cron | personality | memory | acp | batch | bench | eval | evolve | learn | nightly | digest | plugin | skills | commands | keys | secrets | fallback | slack | api-key | claw | doctor | upgrade | mcp | backup | import | trace | audit | security | errors | perf | tail | retention | cas | why | data | support | archive | systemd-unit | usage] [--version | --help]';

const args = process.argv.slice(2);
const command = args[0] ?? '';
const inferredChatFromQueryFlag =
  command === '-q' || command === '--query' || command.startsWith('--query=');
const inferredChatFromResumeFlag =
  command === '--continue' || command === '-c' || command === '--resume' || command === '-r';
const effectiveCommand = inferredChatFromQueryFlag || inferredChatFromResumeFlag ? 'chat' : command;
process.title = `ethos${effectiveCommand ? ` ${effectiveCommand}` : ''}`;

// FW-8: parse CLI override flags from the full argv. These override
// ~/.ethos/config.yaml for this invocation only and are never written back.
const cliOverrideFlags = parseCliOverrideFlags(args);

function extractSingleQuery(argv: string[]): {
  query?: string;
  rest: string[];
  queryFlagUsed: boolean;
} {
  const rest: string[] = [];
  let query: string | undefined;
  let queryFlagUsed = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if (a === '-q' || a === '--query') {
      queryFlagUsed = true;
      query = argv[i + 1];
      i++;
      continue;
    }
    if (a.startsWith('--query=')) {
      queryFlagUsed = true;
      query = a.slice('--query='.length);
      continue;
    }
    rest.push(a);
  }
  return { query, rest, queryFlagUsed };
}

// W2.5 — dispatch the setup wizard's three-way close. 'chat' opens the CLI
// REPL; 'gateway' hands off to `ethos gateway start` with the t.me deep-link
// success block (reusing the validated @username); 'done' exits.
async function launchAfterSetup(
  setupResult: import('./commands/setup').SetupResult | null,
): Promise<void> {
  if (!setupResult) return;
  if (setupResult.launch === 'chat') {
    await runChat(setupResult.config);
    return;
  }
  if (setupResult.launch === 'gateway') {
    console.log('Starting the Telegram bot…');
    const username = setupResult.telegramUsername;
    await runGatewayStart({
      onReady: () => {
        if (username) {
          const handle = username.replace(/^@/, '');
          console.log(`✓ ${username} is live — message it: t.me/${handle}`);
        }
        console.log("Ctrl+C stops the bot. Run 'ethos gateway start' to restart it.");
      },
    });
  }
}

// Pure-metadata commands (`--version`/`--help`) do no registry work, so skip
// the startup crash-recovery scan for them — no point acquiring the registry
// lock + scanning files to print a version string.
const isMetadataCommand =
  effectiveCommand === '--version' ||
  effectiveCommand === '-v' ||
  effectiveCommand === '--help' ||
  effectiveCommand === '-h';

try {
  // Startup crash-recovery scan: flips any `running` registry entry with a dead
  // pid to `orphan`. Best-effort and never throws (a missing/corrupt registry
  // must not block startup); idempotent, so re-running it is harmless.
  if (!isMetadataCommand) await reconcileRegistry(ethosDir());

  // -z / --zero: one-shot non-interactive mode. Intercept before the main
  // command switch so it works regardless of positional command parsing.
  const isZeroMode = args.includes('-z') || args.includes('--zero');
  if (isZeroMode) {
    const zIdx = args.indexOf('-z') !== -1 ? args.indexOf('-z') : args.indexOf('--zero');
    const prompt = args[zIdx + 1] ?? '';
    const { runZero } = await import('./commands/zero');
    await runZero(args, prompt);
    // runZero signals failure via process.exitCode — don't clobber it with 0.
    process.exit(process.exitCode ?? 0);
  }

  switch (effectiveCommand) {
    case '--version':
    case '-v': {
      if (args.includes('--json')) {
        const { buildVersionInfo } = await import('./version-info');
        process.stdout.write(`${JSON.stringify(buildVersionInfo())}
`);
      } else {
        console.log(`@ethosagent/cli ${ETHOS_VERSION}`);
      }
      break;
    }

    case '--help':
    case '-h': {
      console.log(USAGE);
      console.log(
        '\nOne-shot mode:\n' +
          '  -z, --zero <prompt>   Run a single turn and exit (non-interactive)\n' +
          '                        Compatible flags: --no-stream, --model, --personality, --provider\n' +
          '                        Pipe input: echo "code" | ethos -z "explain this"\n',
      );
      break;
    }

    case 'setup': {
      // W2.4 — headless bootstrap for Docker/CI: `ethos setup --from-env`.
      if (args.includes('--from-env')) {
        const { runSetupFromEnv } = await import('./commands/setup-from-env');
        await runSetupFromEnv();
        break;
      }
      const setupSub = args[1];
      const sectionStepMap: Record<string, import('@ethosagent/tui/setup').WizardStepId> = {
        auth: 'auth',
        model: 'model',
        personality: 'personality',
        messaging: 'messaging',
        memory: 'memory',
        providers: 'provider-chain',
        keys: 'key-rotation',
      };
      const startAtStep = setupSub ? sectionStepMap[setupSub] : undefined;
      const setupResult = await runSetup(startAtStep);
      await launchAfterSetup(setupResult);
      break;
    }

    case 'chat':
    case '': {
      const chatArgs = args.slice(command === 'chat' ? 1 : 0);
      const verboseFlag = chatArgs.includes('--verbose');
      // --skin <name> overrides the persisted config.skin for this process.
      const skinFlagIdx = chatArgs.indexOf('--skin');
      const skinFlag = skinFlagIdx !== -1 ? chatArgs[skinFlagIdx + 1] : undefined;
      // --team <name> overrides activeContext for this process (no persistence).
      // Mirrors `ethos serve --team`; same dispatch as `ethos set team <name>`.
      const teamFlagIdx = chatArgs.indexOf('--team');
      const teamFlag = teamFlagIdx !== -1 ? chatArgs[teamFlagIdx + 1] : undefined;
      if (teamFlagIdx !== -1 && (!teamFlag || teamFlag.startsWith('--'))) {
        console.error('Usage: ethos chat --team <name>');
        process.exit(1);
      }
      // FW-2 — --continue / -c (resume most recent) and --resume / -r <id> (resume by id/title)
      const continueFlag = chatArgs.includes('--continue') || chatArgs.includes('-c');
      const resumeFlagIdx =
        chatArgs.indexOf('--resume') !== -1 ? chatArgs.indexOf('--resume') : chatArgs.indexOf('-r');
      const resumeQuery = resumeFlagIdx !== -1 ? chatArgs[resumeFlagIdx + 1] : undefined;
      // FW-5 — --no-resume-hint suppresses the exit hint for this session
      const noResumeHintFlag = chatArgs.includes('--no-resume-hint');
      // --dry-run enables dry-run mode (tools are planned but not executed)
      const dryRunFlag = chatArgs.includes('--dry-run');

      const { query, queryFlagUsed } = extractSingleQuery(chatArgs);
      if (queryFlagUsed && (!query || query.trim().length === 0)) {
        console.error('Usage: ethos chat -q "<prompt>"');
        process.exit(1);
      }

      // Resolve resume target before loading config so we can error early
      let resumeSessionKey: string | undefined;
      let resumeSessionId: string | undefined;
      if (continueFlag || resumeQuery !== undefined) {
        const { SQLiteSessionStore } = await import('@ethosagent/session-sqlite');
        const { ethosDir } = await import('@ethosagent/config');
        const { join: pathJoin } = await import('node:path');
        const { resolveResumeSession } = await import('./commands/sessions');
        const store = new SQLiteSessionStore(pathJoin(ethosDir(), 'sessions.db'));
        try {
          const target = continueFlag
            ? { type: 'continue' as const }
            : { type: 'resume' as const, query: resumeQuery ?? '' };
          const session = await resolveResumeSession(store, target);
          if (!session) {
            console.error(
              continueFlag ? 'No sessions found to resume.' : `Session not found: ${resumeQuery}`,
            );
            process.exit(1);
          }
          resumeSessionKey = session.key;
          resumeSessionId = session.id;
        } finally {
          store.close();
        }
      }

      const config = await readConfig(getStorage(), await getSecretsResolver());
      if (!config) {
        if (process.env.ETHOS_MANAGED === '1') {
          console.error(
            'ethos: managed mode (ETHOS_MANAGED=1); no ~/.ethos/config.yaml found.\n' +
              '       Bootstrap the config externally (e.g. Clawrium playbook) and retry.',
          );
          process.exit(2);
        }
        console.log('No config found. Running setup first...\n');
        const setupResult = await runSetup();
        if (setupResult) {
          const { config: fresh } = setupResult;
          if (fresh.logs?.rotation) {
            const { setRotationConfig } = await import('./error-log');
            setRotationConfig(fresh.logs.rotation);
          }
          let withFlags = { ...fresh };
          if (verboseFlag) withFlags.verbose = true;
          if (skinFlag) withFlags.skin = skinFlag;
          if (teamFlag) withFlags.activeContext = { type: 'team', name: teamFlag };
          // FW-8: apply CLI overrides after config is available.
          withFlags = await applyCliOverrides(withFlags, cliOverrideFlags, getStorage());
          await runChat(withFlags, {
            ...(query ? { singleQuery: query } : {}),
            ...(resumeSessionKey ? { resumeSessionKey, resumeSessionId } : {}),
            ...(noResumeHintFlag ? { noResumeHint: true } : {}),
            ...(dryRunFlag ? { dryRun: true } : {}),
          });
          if (query) process.exit(0);
        }
      } else {
        if (config.logs?.rotation) {
          const { setRotationConfig } = await import('./error-log');
          setRotationConfig(config.logs.rotation);
        }
        let withFlags = { ...config };
        if (verboseFlag) withFlags.verbose = true;
        if (skinFlag) withFlags.skin = skinFlag;
        if (teamFlag) withFlags.activeContext = { type: 'team', name: teamFlag };
        // FW-8: apply CLI overrides after config is available.
        withFlags = await applyCliOverrides(withFlags, cliOverrideFlags, getStorage());
        await runChat(withFlags, {
          ...(query ? { singleQuery: query } : {}),
          ...(resumeSessionKey ? { resumeSessionKey, resumeSessionId } : {}),
          ...(noResumeHintFlag ? { noResumeHint: true } : {}),
          ...(dryRunFlag ? { dryRun: true } : {}),
        });
        if (query) process.exit(0);
      }
      break;
    }

    case 'sessions': {
      await runSessionsCommand(args[1] ?? 'list', args.slice(2));
      break;
    }

    case 'personality': {
      const sub = args[1] ?? '';
      if (sub === 'list' || sub === '') {
        const jsonMode = args.includes('--json');
        const { createPersonalityRegistry } = await import('@ethosagent/personalities');
        const reg = await createPersonalityRegistry(getStorage());
        if (jsonMode) {
          const defaultId = reg.getDefault().id;
          writeJson(
            reg.list().map((p) => ({
              id: p.id,
              description: p.description ?? null,
              isDefault: p.id === defaultId,
            })),
          );
          break;
        }
        console.log('\nBuilt-in personalities:\n');
        for (const p of reg.list()) {
          const def = reg.getDefault().id === p.id ? ' (default)' : '';
          console.log(`  ${p.id.padEnd(14)} ${p.description ?? ''}${def}`);
        }
        console.log();
      } else if (sub === 'create') {
        const { runPersonalityCreate } = await import('./commands/personality-create');
        await runPersonalityCreate(args.slice(2));
      } else if (sub === 'set' && args[2]) {
        const { writeConfig, readRawConfig: rc } = await import('@ethosagent/config');
        const cfg = await rc(getStorage());
        if (!cfg) {
          console.error('Run ethos setup first.');
          process.exit(1);
        }
        await writeConfig(
          getStorage(),
          { ...cfg, personality: args[2] },
          await getSecretsResolver(),
        );
        console.log(`Personality set to: ${args[2]}`);
      } else if (sub === 'mcp') {
        await runPersonalityMcp(args.slice(2));
      } else if (sub === 'plugins') {
        await runPersonalityPlugins(args.slice(2));
      } else if (sub === 'duplicate') {
        await runPersonalityDuplicate(args.slice(2));
      } else if (sub === 'show') {
        await runPersonalityShow(args.slice(2));
      } else if (sub === 'diff') {
        await runPersonalityDiff(args.slice(2));
      } else if (sub === 'evolve') {
        const { runPersonalityEvolve } = await import('./commands/personality-evolve');
        await runPersonalityEvolve(args.slice(2));
      } else if (sub === 'revert') {
        const { runPersonalityRevert } = await import('./commands/personality-evolve');
        await runPersonalityRevert(args.slice(2));
      } else if (sub === 'judge') {
        const { runPersonalityJudge } = await import('./commands/personality-evolve');
        await runPersonalityJudge(args.slice(2));
      } else if (sub === 'export') {
        const { runPersonalityExport } = await import('./commands/personality-export');
        await runPersonalityExport(args.slice(2));
      } else if (sub === 'import') {
        const { runPersonalityImport } = await import('./commands/personality-export');
        await runPersonalityImport(args.slice(2));
      } else if (sub === 'fork') {
        const srcId = args[2];
        const dstId = args[3] ?? (srcId ? `${srcId}-fork` : undefined);
        if (!srcId || !dstId) {
          console.log('Usage: ethos personality fork <id> [<new-id>]');
          break;
        }
        const { createPersonalityRegistry } = await import('@ethosagent/personalities');
        const storage = getStorage();
        const reg = await createPersonalityRegistry({
          storage,
          userPersonalitiesDir: ethosDir(),
        });
        await reg.loadFromDirectory(join(ethosDir(), 'personalities'));
        const created = await reg.duplicate(srcId, dstId);
        // Prepend fork provenance to SOUL.md
        const soulPath = join(ethosDir(), 'personalities', dstId, 'SOUL.md');
        const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
        if (existsSync(soulPath)) {
          const existing = readFileSync(soulPath, 'utf8');
          writeFileSync(
            soulPath,
            `<!-- forked from: ${srcId} at ${new Date().toISOString()} -->\n${existing}`,
          );
        }
        console.log(
          `✓ Forked "${srcId}" → "${created.config.id}" at ~/.ethos/personalities/${created.config.id}`,
        );
      } else if (sub === 'retire') {
        const retireId = args[2];
        if (!retireId) {
          console.log('Usage: ethos personality retire <id>');
          break;
        }
        // Validate personality ID — reject path traversal
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(retireId)) {
          console.error(
            `Invalid personality ID "${retireId}" — must be alphanumeric with hyphens/underscores.`,
          );
          process.exitCode = 1;
          break;
        }
        const pDir = join(ethosDir(), 'personalities', retireId);
        const resolvedPDir = (await import('node:path')).resolve(pDir);
        const personalitiesBase = (await import('node:path')).resolve(
          join(ethosDir(), 'personalities'),
        );
        if (!resolvedPDir.startsWith(`${personalitiesBase}/`)) {
          console.error('Invalid personality path.');
          process.exitCode = 1;
          break;
        }
        const { existsSync, readFileSync, writeFileSync } = await import('node:fs');
        if (!existsSync(pDir)) {
          console.error(`Personality "${retireId}" not found.`);
          process.exitCode = 1;
          break;
        }
        // Mark config.yaml
        const cfgPath = join(pDir, 'config.yaml');
        if (existsSync(cfgPath)) {
          let cfg = readFileSync(cfgPath, 'utf8');
          if (!cfg.includes('retired:')) {
            cfg += '\nretired: true\n';
          }
          writeFileSync(cfgPath, cfg);
        }
        // Append retirement notice to SOUL.md
        const soulPath = join(pDir, 'SOUL.md');
        if (existsSync(soulPath)) {
          const soul = readFileSync(soulPath, 'utf8');
          writeFileSync(soulPath, `${soul}\n<!-- retired at ${new Date().toISOString()} -->\n`);
        }
        console.log(`✓ Personality "${retireId}" retired. History preserved.`);
      } else {
        console.log(
          'Usage: ethos personality [list | create [name] [--blank | --from <id>] | show <id> | diff <a> <b> | evolve <id> | revert <id> | judge <id> | set <id> | duplicate <src> <dst> | fork <id> [<new-id>] | retire <id> | export <id> [--output <path>] | import <file> [--force] [--secrets <manifest>] | mcp <id> [--attach <name> [--token-stdin] | --detach <name> | --token-stdin <server>] | plugins <id> [--attach <plugin-id> | --detach <plugin-id>]]',
        );
      }
      break;
    }

    case 'plugins': {
      await runPluginsStatus();
      break;
    }

    case 'memory': {
      const sub = args[1] ?? 'show';
      const jsonMode = args.includes('--json');

      if (sub === 'history') {
        const { runMemoryHistory } = await import('./commands/memory-history');
        await runMemoryHistory(args.slice(2));
        break;
      }

      if (sub === 'restore') {
        const { runMemoryRestore } = await import('./commands/memory-restore');
        await runMemoryRestore(args.slice(2));
        break;
      }

      if (sub === 'pending') {
        const { runMemoryPending } = await import('./commands/memory-pending');
        await runMemoryPending(args.slice(2));
        break;
      }

      if (sub === 'supersede') {
        const { runMemorySupersede } = await import('./commands/memory-supersede');
        await runMemorySupersede(args.slice(2));
        break;
      }

      if (sub === 'retract') {
        const { runMemoryRetract } = await import('./commands/memory-retract');
        await runMemoryRetract(args.slice(2));
        break;
      }

      const config = await readConfig(getStorage(), await getSecretsResolver());

      if (config?.memory === 'vector') {
        const { VectorMemoryProvider } = await import('@ethosagent/memory-vector');
        const { ethosDir: getDir } = await import('@ethosagent/config');
        const mem = new VectorMemoryProvider({ dir: getDir(), storage: getStorage() });

        if (sub === 'show' || sub === '') {
          const records = mem.showRecent(20);
          if (jsonMode) {
            writeJson(
              records.map((r) => ({
                scopeId: r.scopeId,
                key: r.key,
                createdAt: r.createdAt.toISOString(),
                content: r.content,
              })),
            );
            mem.close();
            break;
          }
          if (records.length === 0) {
            console.log('No memory yet.');
          } else {
            for (const r of records) {
              console.log(`[${r.scopeId}/${r.key}] ${r.createdAt.toISOString().slice(0, 16)}`);
              console.log(r.content);
              console.log();
            }
          }
        } else if (sub === 'add') {
          const text = args.slice(2).join(' ');
          if (!text) {
            console.error('Usage: ethos memory add "<text>"');
            process.exit(1);
          }
          const n = await mem.add(text, 'memory');
          console.log(`Added ${n} chunk${n === 1 ? '' : 's'} to vector memory.`);
        } else if (sub === 'export') {
          const { join: pathJoin } = await import('node:path');
          const outPath = args[2] ?? pathJoin(getDir(), `memory-export-${Date.now()}.md`);
          const n = await mem.exportAll(outPath);
          if (n === 0) {
            console.log('Memory is empty - nothing to export.');
          } else {
            console.log(`Exported ${n} chunk${n === 1 ? '' : 's'} to ${outPath}`);
          }
        } else if (sub === 'clear') {
          const readline = await import('node:readline');
          const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
          await new Promise<void>((resolve) => {
            rl.question('Clear all vector memory? This cannot be undone. [y/N] ', (answer) => {
              rl.close();
              if (answer.toLowerCase() === 'y') {
                mem.clear();
                console.log('Vector memory cleared.');
              } else {
                console.log('Cancelled.');
              }
              resolve();
            });
          });
        } else {
          console.log('Usage: ethos memory [show | add "<text>" | export [path] | clear]');
        }
        mem.close();
      } else {
        const { createMemoryProvider } = await import('@ethosagent/wiring');
        const { ethosDir: getDir } = await import('@ethosagent/config');
        const mem = createMemoryProvider({ dataDir: getDir(), storage: getStorage() });
        const personalityId = config?.personality ?? 'default';
        const cliCtx = {
          scopeId: `personality:${personalityId}`,
          sessionId: '',
          sessionKey: 'cli',
          platform: 'cli',
          workingDir: process.cwd(),
        };

        if (sub === 'show' || sub === '') {
          const result = await mem.prefetch(cliCtx);
          if (jsonMode) {
            writeJson({
              entries: result
                ? result.entries.map((e) => ({ key: e.key, content: e.content.trim() }))
                : [],
            });
            break;
          }
          if (result && result.entries.length > 0) {
            console.log(result.entries.map((e) => e.content.trim()).join('\n\n'));
          } else {
            console.log('No memory yet.');
          }
        } else if (sub === 'add') {
          const text = args.slice(2).join(' ');
          if (!text) {
            console.error('Usage: ethos memory add "<text>"');
            process.exit(1);
          }
          await mem.sync([{ action: 'add', key: 'MEMORY.md', content: text }], cliCtx);
          console.log('Added to memory.');
        } else if (sub === 'clear') {
          await mem.sync([{ action: 'replace', key: 'MEMORY.md', content: '' }], cliCtx);
          console.log('Memory cleared.');
        } else {
          console.log(
            'Usage: ethos memory [show | add "<text>" | clear | history | restore <slug> | ' +
              'supersede <slug> --by <slug> | retract <slug>]',
          );
        }
      }
      break;
    }

    case 'gateway': {
      const sub = args[1] ?? '';
      if (sub === 'setup') {
        // Alias: open the TUI wizard at the messaging step (TTY), else legacy readline setup.
        const gwResult = await runSetup('messaging');
        await launchAfterSetup(gwResult);
      } else if (sub === 'start') {
        await runGatewayStart();
      } else {
        console.log('Usage: ethos gateway [setup | start]');
      }
      break;
    }

    case 'listen': {
      // Lazily imported: `@ethosagent/voice-satellite` (and, behind it, `ws`)
      // must not sit in the CLI's top-level import graph just because the
      // binary can also be a wake satellite. Same doctrine the daemon-free
      // smoke test enforces for the gateway.
      const { runListen } = await import('./commands/listen');
      await runListen(args.slice(1));
      break;
    }

    case 'cron': {
      const config = await loadRequiredConfig();
      await runCronCommand(args[1] ?? 'list', args.slice(2), config);
      break;
    }

    case 'a2a': {
      await runA2a(args.slice(1));
      break;
    }

    case 'acp': {
      const config = await loadRequiredConfig();
      await runAcp(config);
      break;
    }

    case 'serve': {
      const secrets = await getSecretsResolver();
      const config = (await readConfig(getStorage(), secrets)) ?? null;
      if (config?.logs?.rotation) {
        const { setRotationConfig } = await import('./error-log');
        setRotationConfig(config.logs.rotation);
      }
      await runServe(args.slice(1), config);
      break;
    }

    // `ethos boot` — the merged single-process profile
    // (plan/phases/single-process-boot-profile.md). Runs the gateway role and
    // the serve role in ONE process so boot-time reconciliation runs in full on
    // every start, instead of each command silently skipping the other's half.
    // Additive: `gateway`, `serve` and `run-all` are unchanged.
    // Lazily imported for the same reason `listen` is — `commands/boot.ts`
    // pulls in the gateway, web-api and ACP graphs, which must not sit in the
    // CLI's top-level import path just because the binary can also merge them.
    case 'boot': {
      const secrets = await getSecretsResolver();
      const config = (await readConfig(getStorage(), secrets)) ?? null;
      if (config?.logs?.rotation) {
        const { setRotationConfig } = await import('./error-log');
        setRotationConfig(config.logs.rotation);
      }
      const { runBoot } = await import('./commands/boot');
      await runBoot(args.slice(1), config);
      break;
    }

    // `ethos run-all` — child-process supervisor. Spawns `gateway start` and
    // `serve` as subprocesses and restarts them on crash.
    // One command for the full production surface; wrap it in PM2/systemd for
    // reboot survival. See docs/content/using/how-to/deploy-in-production.md.
    case 'run-all': {
      await loadRequiredConfig();
      await runAll();
      break;
    }

    case 'batch': {
      const config = await loadRequiredConfig();
      await runBatch(args.slice(1), config);
      break;
    }

    case 'bench': {
      await runBench(args.slice(1));
      break;
    }

    case 'eval': {
      const config = await loadRequiredConfig();
      await runEval(args.slice(1), config);
      break;
    }

    case 'evolve': {
      const config = await loadRequiredConfig();
      await runEvolve(args.slice(1), config);
      break;
    }

    case 'learn': {
      await runLearn(args.slice(1));
      break;
    }

    case 'plugin': {
      await runPlugin(args.slice(1));
      break;
    }

    case 'skills': {
      await runSkills(args.slice(1));
      break;
    }

    case 'commands': {
      await runCommands(args.slice(1));
      break;
    }

    case 'keys': {
      await runKeys(args.slice(1));
      break;
    }

    case 'secrets': {
      await runSecrets(args.slice(1));
      break;
    }

    case 'api-key': {
      await runApiKey(args.slice(1));
      break;
    }

    case 'claw': {
      await runClaw(args.slice(1));
      break;
    }

    case 'doctor': {
      await runDoctor(args.slice(1));
      break;
    }

    case 'status': {
      await runStatus(args.slice(1));
      break;
    }

    case 'dashboard': {
      const config = await loadRequiredConfig();
      await runDashboard(args.slice(1), config);
      break;
    }

    case 'fallback': {
      await runFallback(args.slice(1));
      break;
    }

    case 'slack': {
      // Today: only `slack manifest` (mirrors hermes slack). Future
      // subcommands (e.g. `slack post`) extend through this dispatch.
      await runSlackManifest(args.slice(1));
      break;
    }

    case 'upgrade': {
      await runUpgrade();
      break;
    }

    case 'set': {
      await runSet(args.slice(1));
      break;
    }

    case 'team': {
      await runTeamCommand(args[1] ?? 'list', args.slice(2));
      break;
    }

    case 'mesh': {
      await runMeshCommand(args[1] ?? 'list', args.slice(2));
      break;
    }

    case 'process': {
      await runProcessCommand(args[1] ?? 'list', args.slice(2));
      break;
    }

    case 'logs': {
      await runLogs(args.slice(1));
      break;
    }

    case 'mcp': {
      await runMcp(args.slice(1));
      break;
    }

    case 'backup': {
      await runBackup(args.slice(1));
      break;
    }

    case 'import': {
      await runImport(args.slice(1));
      break;
    }

    case 'trace': {
      await runTrace(args.slice(1));
      break;
    }

    case 'audit': {
      await runAudit(args.slice(1));
      break;
    }

    case 'security': {
      // `ethos security audit [--fix] [--json] [--deep]`
      if (args[1] !== 'audit') {
        console.error('Usage: ethos security audit [--fix] [--json] [--deep]');
        process.exit(2);
      }
      await runSecurityAudit(args.slice(1));
      break;
    }

    case 'errors': {
      await runErrors(args.slice(1));
      break;
    }

    case 'perf': {
      await runPerf(args.slice(1));
      break;
    }

    case 'tail': {
      await runTail(args.slice(1));
      break;
    }

    case 'retention': {
      await runRetention(args[1] ?? 'show', args.slice(2));
      break;
    }

    case 'cas': {
      await runCas(args[1] ?? '', args.slice(2));
      break;
    }

    case 'why': {
      await runWhy(args.slice(1));
      break;
    }

    case 'data': {
      await runData(args[1] ?? 'stats', args.slice(2));
      break;
    }

    case 'support': {
      await runSupport(args[1] ?? 'bundle', args.slice(2));
      break;
    }

    case 'archive': {
      await runArchive(args[1] ?? 'list', args.slice(2));
      break;
    }

    case 'systemd-unit': {
      const { runSystemdUnit } = await import('./commands/systemd-unit');
      runSystemdUnit(args.slice(1));
      break;
    }

    case 'usage': {
      const { runUsage } = await import('./commands/usage');
      await runUsage(args.slice(1));
      break;
    }

    case 'nightly': {
      const sub = args[1];
      if (sub === 'run') {
        const { runNightly } = await import('./commands/nightly');
        await runNightly(args.slice(2));
      } else {
        console.log('Usage: ethos nightly run [<id>]');
      }
      break;
    }

    case 'digest': {
      const { runDigest } = await import('./commands/digest');
      await runDigest(args.slice(1));
      break;
    }

    case 'request-dump': {
      await runRequestDump(args.slice(1));
      break;
    }

    // Internal command - launched by `ethos team start` as a detached background
    // supervisor process. Not listed in USAGE; not user-facing.
    case '_supervisor': {
      const teamName = args[1];
      const manifestPath = args[2];
      if (!teamName || !manifestPath) {
        console.error('_supervisor requires <name> <manifestPath>');
        process.exit(1);
      }
      const { readFileSync } = await import('node:fs');
      const { ConsoleLogger } = await import('@ethosagent/logger');
      const { parseTeamManifest, runSupervisor } = await import('@ethosagent/team-supervisor');
      const supervisorLogger = new ConsoleLogger();
      const manifest = parseTeamManifest(readFileSync(manifestPath, 'utf-8'), {
        logger: supervisorLogger,
      });
      const supervisorSecrets = await getSecretsResolver();
      const supervisorConfig = await readConfig(getStorage(), supervisorSecrets);
      await runSupervisor(manifest, manifestPath, {
        logger: supervisorLogger,
        storage: getStorage(),
        secrets: supervisorSecrets,
        ...(supervisorConfig?.teamSupervisor?.restartLoopGuard
          ? { restartLoopGuard: supervisorConfig.teamSupervisor.restartLoopGuard }
          : {}),
      });
      break;
    }

    default: {
      const registry = await getBootCliRegistry();
      const entry = registry.get(effectiveCommand);
      if (!entry?.handler) {
        console.log(`Unknown command: ${command}`);
        console.log(USAGE);
        process.exit(1);
      }
      const exitCode = await entry.handler({
        argv: args.slice(1),
        cwd: process.cwd(),
        stdout: (s) => {
          process.stdout.write(s);
        },
        stderr: (s) => {
          process.stderr.write(s);
        },
        storage: getStorage(),
      });
      if (exitCode !== 0) process.exit(exitCode);
      break;
    }
  }
} catch (err) {
  // Phase 30.9 - render every surface-level failure through the EthosError
  // envelope so users see code/cause/action even when a command throws raw.
  const e = toEthosError(err);
  process.stderr.write(`\n${formatError(e, { color: process.stderr.isTTY })}\n`);
  // Phase 30.10 - append to ~/.ethos/logs/errors.jsonl for local diagnostics.
  appendErrorLog(e, { command: effectiveCommand });
  process.exit(1);
}

// ---------------------------------------------------------------------------
// ethos personality mcp <id> [--attach <name> [--token-stdin] | --detach <name> | --token-stdin <server>]
// ---------------------------------------------------------------------------

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function runPersonalityMcp(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    console.log(
      'Usage: ethos personality mcp <id> [--attach <name> [--token-stdin] | --detach <name> | --token-stdin <server>]',
    );
    return;
  }
  const flags = parseCliFlags(argv.slice(1));
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { loadMcpConfig, mcpTokenSecretRef } = await import('@ethosagent/tools-mcp');
  const { PersonalityScopedSecrets } = await import('@ethosagent/storage-fs');
  const { ethosDir } = await import('@ethosagent/config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  const personality = reg.get(id);
  if (!personality) {
    console.error(`Unknown personality: ${id}`);
    process.exit(1);
  }

  const allServers = await loadMcpConfig(storage);
  const attached = new Set(personality.mcp_servers ?? []);

  // Mode A: --attach <server> --token-stdin — attach + store token from stdin
  if (flags.attach && argv.includes('--token-stdin')) {
    const token = await readStdin();
    if (!token) {
      console.error('No token received on stdin.');
      process.exitCode = 1;
      return;
    }

    attached.add(flags.attach);
    await reg.update(id, { mcp_servers: [...attached] });

    const secrets = await getSecretsResolver();
    const scoped = new PersonalityScopedSecrets(secrets, id);
    await scoped.set(mcpTokenSecretRef(flags.attach), token);

    const serverCfg = allServers.find((s) => s.name === flags.attach);
    if (serverCfg && (serverCfg.auth?.type as string) !== 'bearer') {
      console.warn(
        `⚠ Server "${flags.attach}" auth is not { type: 'bearer' }. Token stored but will not be used until auth is updated in mcp.json.`,
      );
    }

    console.log(`✓ Token stored for server "${flags.attach}" on personality "${id}"`);
    return;
  }

  if (flags.attach) {
    attached.add(flags.attach);
    await reg.update(id, { mcp_servers: [...attached] });
    console.log(`✓ Attached MCP server "${flags.attach}" to ${id}`);
    return;
  }
  if (flags.detach) {
    attached.delete(flags.detach);
    await reg.update(id, { mcp_servers: [...attached] });
    console.log(`✓ Detached MCP server "${flags.detach}" from ${id}`);
    return;
  }

  // Mode B: --token-stdin <server> — standalone token update from stdin
  if (argv.includes('--token-stdin')) {
    const tokenStdinIdx = argv.indexOf('--token-stdin');
    const serverName = argv[tokenStdinIdx + 1];
    if (!serverName || serverName.startsWith('--')) {
      console.error('Usage: echo "<token>" | ethos personality mcp <id> --token-stdin <server>');
      process.exitCode = 1;
      return;
    }

    const token = await readStdin();
    if (!token) {
      console.error('No token received on stdin.');
      process.exitCode = 1;
      return;
    }

    const secrets = await getSecretsResolver();
    const scoped = new PersonalityScopedSecrets(secrets, id);
    await scoped.set(mcpTokenSecretRef(serverName), token);

    const serverCfg = allServers.find((s) => s.name === serverName);
    if (serverCfg && (serverCfg.auth?.type as string) !== 'bearer') {
      console.warn(
        `⚠ Server "${serverName}" auth is not { type: 'bearer' }. Token stored but will not be used until auth is updated in mcp.json.`,
      );
    }

    console.log(`✓ Token stored for server "${serverName}" on personality "${id}"`);
    return;
  }

  // Default: list servers with attachment status
  console.log(`\nMCP servers for ${id}:\n`);
  if (allServers.length === 0) {
    console.log('  No MCP servers configured in ~/.ethos/mcp.json');
  } else {
    for (const s of allServers) {
      const mark = attached.has(s.name) ? '✓' : ' ';
      console.log(`  [${mark}] ${s.name}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// ethos personality plugins <id> [--attach <plugin-id> | --detach <plugin-id>]
// ---------------------------------------------------------------------------

async function runPersonalityPlugins(argv: string[]): Promise<void> {
  const id = argv[0];
  if (!id) {
    console.log(
      'Usage: ethos personality plugins <id> [--attach <plugin-id> | --detach <plugin-id>]',
    );
    return;
  }
  const flags = parseCliFlags(argv.slice(1));
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { scanInstalledPlugins } = await import('@ethosagent/plugin-loader');
  const { ethosDir } = await import('@ethosagent/config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  const personality = reg.get(id);
  if (!personality) {
    console.error(`Unknown personality: ${id}`);
    process.exit(1);
  }

  const allPlugins = await scanInstalledPlugins({ userDir: ethosDir(), storage });
  const attached = new Set(personality.plugins ?? []);

  if (flags.attach) {
    attached.add(flags.attach);
    await reg.update(id, { plugins: [...attached] });
    console.log(`✓ Attached plugin "${flags.attach}" to ${id}`);
    return;
  }
  if (flags.detach) {
    attached.delete(flags.detach);
    await reg.update(id, { plugins: [...attached] });
    console.log(`✓ Detached plugin "${flags.detach}" from ${id}`);
    return;
  }

  console.log(`\nPlugins for ${id}:\n`);
  if (allPlugins.length === 0) {
    console.log('  No plugins installed. Run: ethos plugin install <path>');
  } else {
    for (const p of allPlugins) {
      const mark = attached.has(p.id) ? '✓' : ' ';
      console.log(`  [${mark}] ${p.id.padEnd(24)} ${p.description ?? ''}`);
    }
  }
  console.log();
}

// ---------------------------------------------------------------------------
// ethos personality duplicate <src> <dst>
// ---------------------------------------------------------------------------

async function runPersonalityDuplicate(argv: string[]): Promise<void> {
  const src = argv[0];
  const dst = argv[1];
  if (!src || !dst) {
    console.log('Usage: ethos personality duplicate <src-id> <dst-id>');
    return;
  }
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { ethosDir } = await import('@ethosagent/config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  const created = await reg.duplicate(src, dst);
  const newId = created.config.id;
  console.log(`✓ Duplicated "${src}" -> "${newId}" at ~/.ethos/personalities/${newId}`);
}

// `ethos personality show <id>` — print the generated character sheet: one
// Markdown screen of what the personality is, what it has, and what it can
// reach. The artifact is regenerated on every call from config + SOUL.md.
async function runPersonalityShow(argv: string[]): Promise<void> {
  const jsonMode = argv.includes('--json');
  const id = argv.find((a) => a !== '--json');
  if (!id) {
    console.log('Usage: ethos personality show <id> [--json]');
    return;
  }
  const { createPersonalityRegistry, renderCharacterSheet } = await import(
    '@ethosagent/personalities'
  );
  const { ethosDir } = await import('@ethosagent/config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  const described = reg.describe(id);
  if (!described) {
    console.error(`Unknown personality: ${id}`);
    console.error('Run `ethos personality list` to see available ids.');
    process.exit(1);
  }
  const soulMd = await reg.readSoulMd(id);
  if (jsonMode) {
    writeJson({
      id,
      config: described.config,
      soulMd: soulMd ?? null,
    });
    return;
  }
  // Resolve the execution posture so `## Execution` renders on the sheet
  // (Phase 2a, lane E1). Read-only — no daemon probe here; the static posture
  // (backend / network / memory / mounts / macOS caveat) is what `show` audits.
  const { buildExecutionPosture, resolvePersonalityModelFit } = await import('@ethosagent/wiring');
  const posture = await buildExecutionPosture({
    personality: described.config,
    substitutionVars: { ethosHome: ethosDir(), cwd: process.cwd() },
  });

  // Lane 6 — the arithmetic model-fit verdict, rendered as the sheet's
  // `## Model fit` section. The window resolution probes LIVE and rewrites the
  // probe cache (D16 — this is a diagnostic command; the numbers an operator
  // tunes against are never stale). The tool registry supplies the SERIALIZED
  // schema payload the floor divides by (D8). Fail-soft: no config, or a loop
  // that cannot be constructed, renders today's sheet without the verdict —
  // the character sheet is the command's contract.
  let modelFit: import('@ethosagent/personalities').CharacterSheetModelFit | undefined;
  let scriptSurface: import('@ethosagent/personalities').CharacterSheetScriptSurface | undefined;
  let boundary: import('@ethosagent/personalities').CharacterSheetBoundary | undefined;
  let renderers: string[] | undefined;
  let loopConstructed = false;
  try {
    const cfg = await readConfig(storage, await getSecretsResolver());
    if (cfg) {
      const { createAgentLoop } = await import('./wiring');
      const result = await createAgentLoop(cfg);
      loopConstructed = true;
      // Lane G (tools-as-code-api) — the script-callable surface, computed by
      // the SAME derivation the ScriptToolBridge enforces. Fail-soft with the
      // rest of this block: no loop → no line.
      const { scriptCallableFor, toolsDeclaringNetwork } = await import('@ethosagent/core');
      scriptSurface = { callable: scriptCallableFor(described.config, result.toolRegistry) };
      // §4.7 — which tools in reach DECLARE network egress, so the `## Boundary`
      // section can say G-NET is inapplicable rather than implying reach this
      // personality does not have. Same declaration G-CAP intersects per call.
      boundary = { networkTools: toolsDeclaringNetwork(described.config, result.toolRegistry) };
      const model = cfg.modelRouting?.[id] ?? cfg.model;
      modelFit = await resolvePersonalityModelFit({
        personality: described.config,
        soulMd,
        toolDefinitions: result.toolRegistry.toDefinitions(described.config.toolset),
        provider: cfg.provider,
        model,
        ...(cfg.baseUrl !== undefined ? { baseUrl: cfg.baseUrl } : {}),
        ...(model === cfg.model && cfg.contextWindow !== undefined
          ? { configWindow: cfg.contextWindow }
          : {}),
        ...(cfg.compaction?.smallWindow !== undefined
          ? { smallWindowOverride: cfg.compaction.smallWindow }
          : {}),
        storage,
        dataDir: ethosDir(),
        forceProbeRefresh: true,
      });
      // skill-declared-renderers Lane E — the same `resolveRenderers` derivation
      // the `personalities.renderers` RPC gates the web renderer on, so the
      // sheet and the surface cannot disagree about what may be drawn. Last in
      // the block: this one touches disk, and a skills read that fails should
      // cost the Renders line, not the model-fit verdict above it.
      renderers = await result.skillsInjector.resolveRenderers(id);
    }
  } catch {
    // The verdict is advisory — the character sheet is the command's contract.
  }
  console.log(
    `\n${renderCharacterSheet(
      described.config,
      soulMd,
      { posture },
      modelFit,
      scriptSurface,
      renderers,
      boundary,
    )}`,
  );

  // Loop construction can leave live handles (MCP children, background
  // executors); the sheet is printed and flushed, so exit explicitly (same
  // posture as `ethos bench context`).
  if (loopConstructed) process.exit(process.exitCode ?? 0);
}

// ---------------------------------------------------------------------------
// Minimal unified diff — LCS-based, no external dependency.
// ---------------------------------------------------------------------------

export function unifiedDiff(a: string, b: string, labelA: string, labelB: string): string {
  const linesA = a.split('\n');
  const linesB = b.split('\n');

  // Build LCS table
  const m = linesA.length;
  const n = linesB.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0) as number[]);
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (linesA[i - 1] === linesB[j - 1]) {
        dp[i][j] = (dp[i - 1]?.[j - 1] ?? 0) + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1]?.[j] ?? 0, dp[i]?.[j - 1] ?? 0);
      }
    }
  }

  // Backtrack to produce diff lines
  const result: Array<{ tag: ' ' | '-' | '+'; line: string }> = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && linesA[i - 1] === linesB[j - 1]) {
      result.push({ tag: ' ', line: linesA[i - 1] ?? '' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || (dp[i]?.[j - 1] ?? 0) >= (dp[i - 1]?.[j] ?? 0))) {
      result.push({ tag: '+', line: linesB[j - 1] ?? '' });
      j--;
    } else {
      result.push({ tag: '-', line: linesA[i - 1] ?? '' });
      i--;
    }
  }
  result.reverse();

  // ANSI coloring
  const red = '\x1b[31m';
  const green = '\x1b[32m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  const out: string[] = [`${red}--- ${labelA}${reset}`, `${green}+++ ${labelB}${reset}`];
  for (const entry of result) {
    if (entry.tag === '-') {
      out.push(`${red}-${entry.line}${reset}`);
    } else if (entry.tag === '+') {
      out.push(`${green}+${entry.line}${reset}`);
    } else {
      out.push(`${dim} ${entry.line}${reset}`);
    }
  }
  return out.join('\n');
}

// `ethos personality diff <a> <b>` — render both character sheets and print
// a unified diff so you can see what changed between two personalities.
// TODO(phase-5d): extend with version-ref args (<a>[@ref] <b>[@ref])
// when a personality version store is available (deferred — depends on Phase 3 amendment history).
async function runPersonalityDiff(argv: string[]): Promise<void> {
  const [idA, idB] = argv;
  if (!idA || !idB) {
    console.log('Usage: ethos personality diff <a> <b>');
    process.exit(1);
  }
  const { createPersonalityRegistry, renderCharacterSheet } = await import(
    '@ethosagent/personalities'
  );
  const { ethosDir } = await import('@ethosagent/config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  const descA = reg.describe(idA);
  if (!descA) {
    console.error(`Unknown personality: ${idA}`);
    console.error('Run `ethos personality list` to see available ids.');
    process.exit(1);
  }
  const descB = reg.describe(idB);
  if (!descB) {
    console.error(`Unknown personality: ${idB}`);
    console.error('Run `ethos personality list` to see available ids.');
    process.exit(1);
  }

  const soulA = await reg.readSoulMd(idA);
  const soulB = await reg.readSoulMd(idB);
  const sheetA = renderCharacterSheet(descA.config, soulA);
  const sheetB = renderCharacterSheet(descB.config, soulB);

  if (sheetA === sheetB) {
    console.log(`\nNo differences between "${idA}" and "${idB}".\n`);
    return;
  }

  const diff = unifiedDiff(sheetA, sheetB, idA, idB);
  console.log(`\n${diff}`);
}

// ---------------------------------------------------------------------------
// ethos plugins status - global plugin × personality matrix
// ---------------------------------------------------------------------------

async function runPluginsStatus(): Promise<void> {
  const { createPersonalityRegistry } = await import('@ethosagent/personalities');
  const { scanInstalledPlugins } = await import('@ethosagent/plugin-loader');
  const { ethosDir } = await import('@ethosagent/config');
  const storage = getStorage();
  const reg = await createPersonalityRegistry({ storage, userPersonalitiesDir: ethosDir() });
  await reg.loadFromDirectory(join(ethosDir(), 'personalities'));

  const allPlugins = await scanInstalledPlugins({ userDir: ethosDir(), storage });
  const allPersonalities = reg.list();

  if (allPlugins.length === 0) {
    console.log('\nNo plugins installed. Run: ethos plugin install <path>\n');
    return;
  }

  console.log('\nPlugin attachment status:\n');
  const colWidth = 20;
  const header = 'Plugin'.padEnd(colWidth) + allPersonalities.map((p) => p.id.padEnd(12)).join('');
  console.log(`  ${header}`);
  console.log(`  ${'-'.repeat(header.length)}`);

  for (const plugin of allPlugins) {
    let row = plugin.id.padEnd(colWidth);
    for (const personality of allPersonalities) {
      const attached = (personality.plugins ?? []).includes(plugin.id);
      row += (attached ? '✓' : '·').padEnd(12);
    }
    console.log(`  ${row}`);
  }
  console.log();

  const unattached = allPlugins.filter((p) =>
    allPersonalities.every((pers) => !(pers.plugins ?? []).includes(p.id)),
  );
  if (unattached.length > 0) {
    console.log(
      `  ⚠  ${unattached.length} plugin(s) installed but not attached to any personality - they're inert until attached.`,
    );
    console.log();
  }
}

function parseCliFlags(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith('--')) {
      const key = arg.slice(2);
      const val = argv[i + 1];
      if (val && !val.startsWith('--')) {
        out[key] = val;
        i++;
      }
    }
  }
  return out;
}

let _bootCliRegistry: CliSubcommandRegistry | null = null;

async function getBootCliRegistry(): Promise<CliSubcommandRegistry> {
  if (_bootCliRegistry) return _bootCliRegistry;
  const { PluginLoader } = await import('@ethosagent/plugin-loader');
  const {
    DefaultHookRegistry,
    DefaultLLMProviderRegistry,
    DefaultMemoryProviderRegistry,
    DefaultPersonalityRegistry,
    DefaultToolRegistry,
  } = await import('@ethosagent/core');
  const registry = new CliSubcommandRegistry();
  const registries: import('@ethosagent/plugin-sdk').PluginRegistries = {
    tools: new DefaultToolRegistry(),
    hooks: new DefaultHookRegistry(),
    injectors: [],
    injectorPluginIds: new Map(),
    personalities: new DefaultPersonalityRegistry(),
    llmProviders: new DefaultLLMProviderRegistry(),
    memoryProviders: new DefaultMemoryProviderRegistry(),
    cliSubcommandRegistry: registry,
  };
  const loader = new PluginLoader(registries, { storage: getStorage() });
  await loader.loadAll();
  _bootCliRegistry = registry;
  return registry;
}
