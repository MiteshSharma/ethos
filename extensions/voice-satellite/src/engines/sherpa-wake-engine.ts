// The acoustic wake engine: sherpa-onnx keyword spotting, loaded lazily.
//
// ── HONESTY NOTE, READ BEFORE TRUSTING THIS FILE ──────────────────────────────
// `sherpa-onnx-node` is NOT installed in this repo and is deliberately not a
// dependency: it ships a per-architecture native binary of roughly 33 MB, which
// every contributor and every CI job would pay for a capability almost none of
// them exercise. It is an OPTIONAL PEER resolved at runtime on hosts that want
// acoustic wake.
//
// The consequence is that the calls below are written against sherpa-onnx's
// DOCUMENTED KeywordSpotter surface and have never been executed against a real
// binary in this repo. The narrow interfaces in this file describe only the
// members used, and they are a DESCRIPTION OF AN EXPECTATION, not a verified
// contract. Treat first hardware bring-up as the point at which this mapping is
// confirmed — and if the real API differs, this file changes, not the seam.
//
// What IS verified here, and what the tests cover, is the part that matters for
// the failure modes this lane exists to contain: the import is lazy, the probe
// really loads what it would load, every distinct failure produces a distinct
// diagnosable message, and nothing throws out of the probe.
// ──────────────────────────────────────────────────────────────────────────────
//
// NO TOP-LEVEL IMPORT OF ANYTHING NATIVE. Both the probe and `init()` reach the
// package through `await import()`. Importing this module on a machine with no
// ONNX runtime, no audio stack, and no models is a no-op.

import type { Storage } from '@ethosagent/types';
import type {
  WakeEngine,
  WakeEngineFactory,
  WakeEngineOptions,
  WakeEngineProbe,
  WakeFrame,
  WakeMatch,
  WakeRoute,
} from '../wake-engine';
import { wakePhraseKey } from './transcript-wake-engine';

/** The npm package name, resolved at runtime and never bundled. */
const SHERPA_PACKAGE = 'sherpa-onnx-node';

const ENGINE_NAME = 'sherpa';

/** Model files a transducer keyword spotter needs, relative to `modelDir`. */
export interface SherpaModelFiles {
  encoder: string;
  decoder: string;
  joiner: string;
  tokens: string;
}

export interface SherpaWakeEngineConfig {
  /** Reads model files through the Storage contract — never `node:fs`. */
  storage: Storage;
  /** Absolute directory the model files live in. */
  modelDir: string;
  files: SherpaModelFiles;
  /**
   * sherpa's keyword spotter matches over the MODEL's tokens, not over English
   * words, so an arbitrary phrase has to be rendered in the token form the
   * model was trained on. The default passes the normalized phrase through,
   * which is correct for the token files whose units are whitespace-separated
   * words; a BPE model needs a real tokenizer wired here.
   */
  tokenizePhrase?: (phrase: string) => string;
}

// --- the narrow slice of sherpa-onnx-node this file uses ---------------------

interface SherpaStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
}

interface SherpaKeywordResult {
  keyword: string;
}

interface SherpaKeywordSpotter {
  createStream(keywords?: string): SherpaStream;
  isReady(stream: SherpaStream): boolean;
  decode(stream: SherpaStream): void;
  getResult(stream: SherpaStream): SherpaKeywordResult;
  reset(stream: SherpaStream): void;
}

interface SherpaKeywordSpotterCtor {
  new (config: unknown): SherpaKeywordSpotter;
}

interface SherpaModule {
  KeywordSpotter?: SherpaKeywordSpotterCtor;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Load the optional peer. The two failure shapes are reported differently
 * because the remedies are different: "not installed" is an install away,
 * whereas an import that resolves and then throws is the wrong-architecture
 * binary — the single most common native-dependency failure in this space, and
 * one that a generic "wake unavailable" message leaves the operator guessing at.
 */
async function loadSherpa(): Promise<{ module: SherpaModule } | { error: string }> {
  // Held in a `string`-typed local so the specifier is not a literal: the
  // package is intentionally absent from this repo, and a literal would make
  // `tsc` demand types for a module nobody installed.
  const specifier: string = SHERPA_PACKAGE;
  try {
    const loaded: unknown = await import(specifier);
    return { module: (loaded as { default?: SherpaModule }).default ?? (loaded as SherpaModule) };
  } catch (err) {
    const message = errorMessage(err);
    if (/cannot find (module|package)|ERR_MODULE_NOT_FOUND/i.test(message)) {
      return {
        error:
          `${SHERPA_PACKAGE} is not installed — acoustic wake is an optional peer ` +
          `(per-architecture native binary, ~33 MB). Install it on this host, or run the ` +
          `'transcript' engine, which needs nothing. Loader said: ${message}`,
      };
    }
    return {
      error:
        `${SHERPA_PACKAGE} is installed but failed to load — this is usually a native binary ` +
        `built for a different architecture than this machine. Reinstall it on this host so ` +
        `the prebuilt binary matches. Loader said: ${message}`,
    };
  }
}

function modelPaths(config: SherpaWakeEngineConfig): string[] {
  const { modelDir, files } = config;
  const join = (name: string) =>
    modelDir.endsWith('/') ? `${modelDir}${name}` : `${modelDir}/${name}`;
  return [join(files.encoder), join(files.decoder), join(files.joiner), join(files.tokens)];
}

/** First missing model path, or null when all four are present. */
async function firstMissingModel(config: SherpaWakeEngineConfig): Promise<string | null> {
  for (const path of modelPaths(config)) {
    if (!(await config.storage.exists(path))) return path;
  }
  return null;
}

class SherpaWakeEngine implements WakeEngine {
  readonly name = ENGINE_NAME;

  private spotter: SherpaKeywordSpotter | null = null;
  private stream: SherpaStream | null = null;
  private keywords = '';
  /** Tokenized keyword → the route it came from. */
  private byKeyword = new Map<string, WakeRoute>();

  constructor(private readonly config: SherpaWakeEngineConfig) {}

  async init(routes: readonly WakeRoute[], opts: WakeEngineOptions): Promise<void> {
    const loaded = await loadSherpa();
    if ('error' in loaded) throw new Error(loaded.error);
    const Spotter = loaded.module.KeywordSpotter;
    if (typeof Spotter !== 'function') {
      throw new Error(
        `${SHERPA_PACKAGE} loaded but exposes no KeywordSpotter — the installed version does ` +
          `not support keyword spotting. Upgrade it, or run the 'transcript' engine.`,
      );
    }
    const missing = await firstMissingModel(this.config);
    if (missing !== null) {
      throw new Error(`wake model file missing — ${missing}`);
    }

    const tokenize = this.config.tokenizePhrase ?? ((phrase: string) => phrase);
    this.byKeyword = new Map();
    const lines: string[] = [];
    for (const route of routes) {
      if (route.enabled !== true) continue;
      // `wakePhraseKey`, not `normalizeUtterance`: the transcript engine treats
      // the leading greeting as optional, and a keyword spotter that insisted
      // on "hey engineer" acoustically would be the two engines disagreeing
      // about what the house answers to. The key is the name, which the spotter
      // still finds inside "hey engineer".
      const keyword = tokenize(wakePhraseKey(route.phrase));
      if (keyword.length === 0) continue;
      this.byKeyword.set(keyword, {
        id: route.id,
        phrase: route.phrase,
        personalityId: route.personalityId,
        privileged: route.privileged === true,
        enabled: true,
      });
      lines.push(keyword);
    }
    this.keywords = lines.join('\n');

    const paths = modelPaths(this.config);
    this.spotter = new Spotter({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder: paths[0], decoder: paths[1], joiner: paths[2] },
        tokens: paths[3],
        numThreads: 1,
        provider: 'cpu',
        debug: false,
      },
      // Sensitivity maps onto the spotter's acceptance threshold: a higher
      // sensitivity means a lower bar for a spot to count.
      keywordsThreshold: Math.max(0.05, Math.min(0.95, 1 - opts.sensitivity)),
      numTrailingBlanks: Math.max(1, opts.confirmationFrames),
    });
    this.stream = this.spotter.createStream(this.keywords);
  }

  push(frame: WakeFrame): WakeMatch | null {
    const spotter = this.spotter;
    const stream = this.stream;
    if (spotter === null || stream === null) return null;

    const samples = new Float32Array(frame.samples.length);
    for (let i = 0; i < frame.samples.length; i++) {
      samples[i] = (frame.samples[i] ?? 0) / 32768;
    }
    stream.acceptWaveform({ sampleRate: frame.sampleRate, samples });
    while (spotter.isReady(stream)) spotter.decode(stream);

    const keyword = spotter.getResult(stream).keyword;
    if (keyword.length === 0) return null;
    // A spot leaves the decoder holding the phrase it just matched; without the
    // reset the next frame re-reports it and one wake becomes a stream of them.
    spotter.reset(stream);

    const route = this.byKeyword.get(keyword);
    if (route === undefined) return null;
    return {
      routeId: route.id,
      phrase: route.phrase,
      // sherpa's keyword result carries no score, so reporting anything but
      // certainty here would be inventing a number. `WakeMatch.confidence` is
      // documented as the engine's own scale precisely so this stays honest.
      confidence: 1,
    };
  }

  reset(): void {
    if (this.spotter === null) return;
    this.stream = this.spotter.createStream(this.keywords);
  }

  async dispose(): Promise<void> {
    this.spotter = null;
    this.stream = null;
    this.byKeyword = new Map();
  }
}

export function createSherpaWakeEngineFactory(config: SherpaWakeEngineConfig): WakeEngineFactory {
  return {
    name: ENGINE_NAME,
    /**
     * The real probe: it loads the package the engine would load and stats the
     * model files the engine would open. Nothing here reports availability from
     * configuration — "the operator ticked the sherpa box" is exactly the
     * false-available claim this probe exists to refuse.
     */
    async probe(): Promise<WakeEngineProbe> {
      const loaded = await loadSherpa();
      if ('error' in loaded) return { ok: false, engine: ENGINE_NAME, detail: loaded.error };
      if (typeof loaded.module.KeywordSpotter !== 'function') {
        return {
          ok: false,
          engine: ENGINE_NAME,
          detail:
            `${SHERPA_PACKAGE} loaded but exposes no KeywordSpotter — the installed version ` +
            `does not support keyword spotting.`,
        };
      }
      let missing: string | null;
      try {
        missing = await firstMissingModel(config);
      } catch (err) {
        return {
          ok: false,
          engine: ENGINE_NAME,
          detail: `wake model directory unreadable — ${config.modelDir} (${errorMessage(err)})`,
        };
      }
      if (missing !== null) {
        return { ok: false, engine: ENGINE_NAME, detail: `wake model file missing — ${missing}` };
      }
      return {
        ok: true,
        engine: ENGINE_NAME,
        detail: `${SHERPA_PACKAGE} loaded and all four model files present in ${config.modelDir}`,
      };
    },
    create: () => new SherpaWakeEngine(config),
  };
}
