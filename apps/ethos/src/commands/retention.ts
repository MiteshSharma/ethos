import { readRawConfig, writeConfig } from '@ethosagent/config';
import { mergeRetentionConfig, parseDuration } from '@ethosagent/observability-sqlite';
import { RETENTION_DEFAULTS, type RetentionConfig } from '@ethosagent/types';
import { writeJson } from '../json-output';
import { getSecretsResolver, getStorage } from '../wiring';

// ---------------------------------------------------------------------------
// ethos retention show [--personality <id>] [--defaults]
// ethos retention set <category> <duration> [--personality <id>]
// ethos retention reset <category|--all> [--personality <id>]
// ---------------------------------------------------------------------------

const CATEGORY_LABELS: Record<string, string> = {
  messages: 'messages',
  traces: 'traces',
  spans: 'spans',
  blobs: 'blobs',
  archive: 'archive',
  channelTranscript: 'channelTranscript',
  'events.error': 'events.error',
  'events.audit': 'events.audit',
  'events.channel': 'events.channel',
  'events.install': 'events.install',
};

function getDefault(category: string): string {
  switch (category) {
    case 'messages':
      return RETENTION_DEFAULTS.messages;
    case 'traces':
      return RETENTION_DEFAULTS.traces;
    case 'spans':
      return RETENTION_DEFAULTS.spans;
    case 'blobs':
      return RETENTION_DEFAULTS.blobs;
    case 'archive':
      return RETENTION_DEFAULTS.archive;
    case 'channelTranscript':
      return RETENTION_DEFAULTS.channelTranscript;
    case 'events.error':
      return RETENTION_DEFAULTS.events.error;
    case 'events.audit':
      return RETENTION_DEFAULTS.events.audit;
    case 'events.channel':
      return RETENTION_DEFAULTS.events.channel;
    case 'events.install':
      return RETENTION_DEFAULTS.events.install;
    default:
      return '—';
  }
}

function getRetentionValue(cfg: RetentionConfig | undefined, category: string): string | undefined {
  if (!cfg) return undefined;
  switch (category) {
    case 'messages':
      return cfg.messages;
    case 'traces':
      return cfg.traces;
    case 'spans':
      return cfg.spans;
    case 'blobs':
      return cfg.blobs;
    case 'archive':
      return cfg.archive;
    case 'channelTranscript':
      return cfg.channelTranscript;
    case 'events.error':
      return cfg.events?.error;
    case 'events.audit':
      return cfg.events?.audit;
    case 'events.channel':
      return cfg.events?.channel;
    case 'events.install':
      return cfg.events?.install;
    default:
      return undefined;
  }
}

function setRetentionValue(cfg: RetentionConfig, category: string, value: string): RetentionConfig {
  const out = { ...cfg };
  switch (category) {
    case 'messages':
      out.messages = value;
      break;
    case 'traces':
      out.traces = value;
      break;
    case 'spans':
      out.spans = value;
      break;
    case 'blobs':
      out.blobs = value;
      break;
    case 'archive':
      out.archive = value;
      break;
    case 'channelTranscript':
      out.channelTranscript = value;
      break;
    case 'events.error':
      out.events = { ...out.events, error: value };
      break;
    case 'events.audit':
      out.events = { ...out.events, audit: value };
      break;
    case 'events.channel':
      out.events = { ...out.events, channel: value };
      break;
    case 'events.install':
      out.events = { ...out.events, install: value };
      break;
  }
  return out;
}

function deleteRetentionValue(cfg: RetentionConfig, category: string): RetentionConfig {
  const out = { ...cfg };
  switch (category) {
    case 'messages':
      delete out.messages;
      break;
    case 'traces':
      delete out.traces;
      break;
    case 'spans':
      delete out.spans;
      break;
    case 'blobs':
      delete out.blobs;
      break;
    case 'archive':
      delete out.archive;
      break;
    case 'channelTranscript':
      delete out.channelTranscript;
      break;
    case 'events.error':
      out.events = { ...out.events };
      delete out.events.error;
      break;
    case 'events.audit':
      out.events = { ...out.events };
      delete out.events.audit;
      break;
    case 'events.channel':
      out.events = { ...out.events };
      delete out.events.channel;
      break;
    case 'events.install':
      out.events = { ...out.events };
      delete out.events.install;
      break;
  }
  return out;
}

function parseFlags(argv: string[]): {
  personality?: string;
  defaults: boolean;
  all: boolean;
  positional: string[];
} {
  const positional: string[] = [];
  let personality: string | undefined;
  let defaults = false;
  let all = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? '';
    if ((a === '--personality' || a === '-p') && argv[i + 1]) {
      personality = argv[i + 1];
      i++;
    } else if (a === '--defaults') {
      defaults = true;
    } else if (a === '--all') {
      all = true;
    } else if (!a.startsWith('--')) {
      positional.push(a);
    }
  }
  return { personality, defaults, all, positional };
}

export async function runRetention(sub: string, argv: string[]): Promise<void> {
  const storage = getStorage();
  const config = await readRawConfig(storage);
  if (!config) {
    console.error('Run ethos setup first.');
    process.exit(1);
  }

  const flags = parseFlags(argv);

  if (sub === 'show' || sub === '') {
    const globalRetention = config.retention;
    const personalityRetention = flags.personality
      ? config.personalitiesConfig?.[flags.personality]?.retention
      : undefined;

    const effectiveRetention = flags.personality
      ? mergeRetentionConfig(globalRetention ?? RETENTION_DEFAULTS, personalityRetention ?? {})
      : globalRetention;

    if (argv.includes('--json')) {
      const categories = Object.entries(CATEGORY_LABELS).map(([key]) => {
        const overrideVal = getRetentionValue(effectiveRetention, key);
        const defaultVal = getDefault(key);
        return {
          name: key,
          duration: overrideVal ?? defaultVal,
          isOverride: overrideVal !== undefined,
        };
      });
      writeJson({ categories });
      return;
    }

    console.log('\nRetention settings');
    console.log('══════════════════════');
    if (flags.personality) {
      console.log(`  (personality override: ${flags.personality})`);
    }

    for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
      const overrideVal = getRetentionValue(effectiveRetention, key);
      const defaultVal = getDefault(key);
      const displayVal = overrideVal ?? defaultVal;
      const tag = overrideVal ? '(override)' : '(default)';
      console.log(`  ${label.padEnd(18)} ${displayVal.padEnd(8)} ${tag}`);
    }
    console.log();

    if (flags.defaults) {
      console.log('Defaults:');
      console.log('══════════════════════');
      for (const [key, label] of Object.entries(CATEGORY_LABELS)) {
        console.log(`  ${label.padEnd(18)} ${getDefault(key)}`);
      }
      console.log();
    }
    return;
  }

  if (sub === 'set') {
    const category = flags.positional[0];
    const duration = flags.positional[1];
    if (!category || !duration) {
      console.log('Usage: ethos retention set <category> <duration> [--personality <id>]');
      process.exit(1);
    }
    if (!CATEGORY_LABELS[category]) {
      console.error(
        `Unknown category: ${category}. Valid: ${Object.keys(CATEGORY_LABELS).join(', ')}`,
      );
      process.exit(1);
    }
    // Validate duration
    try {
      parseDuration(duration);
    } catch (e) {
      console.error(`Invalid duration: ${String(e)}`);
      process.exit(1);
    }

    if (flags.personality) {
      const existing = config.personalitiesConfig?.[flags.personality]?.retention ?? {};
      const updated = setRetentionValue(existing, category, duration);
      await writeConfig(
        storage,
        {
          ...config,
          personalitiesConfig: {
            ...config.personalitiesConfig,
            [flags.personality]: { retention: updated },
          },
        },
        await getSecretsResolver(),
      );
      console.log(`Set ${category} = ${duration} for personality ${flags.personality}`);
    } else {
      const existing = config.retention ?? {};
      const updated = setRetentionValue(existing, category, duration);
      await writeConfig(storage, { ...config, retention: updated }, await getSecretsResolver());
      console.log(`Set retention.${category} = ${duration}`);
    }
    return;
  }

  if (sub === 'reset') {
    const category = flags.positional[0];

    if (flags.all || !category) {
      if (flags.personality) {
        const pcfg = config.personalitiesConfig ?? {};
        const updated = { ...pcfg };
        delete updated[flags.personality];
        await writeConfig(
          storage,
          {
            ...config,
            personalitiesConfig: Object.keys(updated).length > 0 ? updated : undefined,
          },
          await getSecretsResolver(),
        );
        console.log(`Reset all retention overrides for personality ${flags.personality}`);
      } else {
        await writeConfig(storage, { ...config, retention: undefined }, await getSecretsResolver());
        console.log('Reset all global retention settings to defaults');
      }
      return;
    }

    if (!CATEGORY_LABELS[category]) {
      console.error(
        `Unknown category: ${category}. Valid: ${Object.keys(CATEGORY_LABELS).join(', ')}`,
      );
      process.exit(1);
    }

    if (flags.personality) {
      const existing = config.personalitiesConfig?.[flags.personality]?.retention ?? {};
      const updated = deleteRetentionValue(existing, category);
      await writeConfig(
        storage,
        {
          ...config,
          personalitiesConfig: {
            ...config.personalitiesConfig,
            [flags.personality]: { retention: updated },
          },
        },
        await getSecretsResolver(),
      );
      console.log(`Reset retention.${category} for personality ${flags.personality} to default`);
    } else {
      const existing = config.retention ?? {};
      const updated = deleteRetentionValue(existing, category);
      const isEmpty = Object.keys(updated).length === 0 && !updated.events;
      await writeConfig(
        storage,
        {
          ...config,
          retention: isEmpty ? undefined : updated,
        },
        await getSecretsResolver(),
      );
      console.log(`Reset retention.${category} to default`);
    }
    return;
  }

  console.log(
    'Usage: ethos retention [show [--personality <id>] [--defaults] | set <category> <duration> [--personality <id>] | reset <category|--all> [--personality <id>]]',
  );
}
