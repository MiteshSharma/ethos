import type { Logger, Storage } from '@ethosagent/types';

/**
 * Shared context passed to extension `compose()` functions. Contains
 * everything an extension needs to construct its components without
 * importing wiring internals.
 *
 * Deliberately avoids referencing WiringConfig so extensions don't
 * take a reverse dependency on the wiring package.
 */
export interface WiringContext {
  storage: Storage;
  dataDir: string;
  workingDir: string;
  log: Logger;
  isDebugSession?: boolean;
  /**
   * Override for where personality built-ins load from, forwarded to
   * `createPersonalityRegistry()` in `extensions/personalities/src/compose.ts`.
   * `import.meta.dirname` inside `loadBuiltins()` resolves relative to the
   * bundled output file once a caller (e.g. the desktop app's electron-vite
   * main bundle) packages `@ethosagent/personalities` into a single file, so
   * a bundled caller must resolve the real data dir itself and pass it here.
   * Unset (the CLI/tsx path, and every other caller) keeps the existing
   * default `loadBuiltins()` behavior unchanged.
   */
  builtinPersonalitiesDir?: string;
  /**
   * Override for the root directory containing call-capture's native
   * binaries (`bin/mic-detector`, `bin/mic-capture`,
   * `vendor/audiotee/audiotee`), forwarded to `buildAgentLoop()`'s
   * `TapCapture`/`MicCapture` construction. Same rationale as
   * `builtinPersonalitiesDir`: `import.meta.dirname` inside
   * `tap-capture.ts`/`mic-capture.ts`'s own `defaultBinaryPath()` resolves
   * relative to the bundled output file once a caller (e.g. the desktop
   * app's electron-vite main bundle) packages `@ethosagent/platform-
   * callcapture` into a single file. Unset (the CLI/tsx path, and every
   * other caller) keeps the existing default binary-path behavior
   * unchanged.
   */
  callCaptureNativeDir?: string;
}
