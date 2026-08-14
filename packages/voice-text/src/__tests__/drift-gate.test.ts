// Voice V1a drift gate (eng-review D8) — one implementation, enforced.
//
// The speakable-text logic had drifted into three near-identical copies (the
// gateway, voice-session, and web-api each carried a hallucination filter, and
// three surfaces each carried their own sentence splitter). Reviews did not
// catch it; a copy is cheap to write and invisible in a diff. So the invariant
// is a test, not a convention.
//
// The scan is textual on purpose: it fails on the DECLARATION, which is what a
// second copy looks like when it appears. Importing from @ethosagent/voice-text
// is always fine — that is the point.
//
// If you genuinely need a differently-shaped implementation, the answer is an
// option on the shared function, not a second definition.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const SCAN_DIRS = ['packages', 'extensions', 'apps', 'scripts'];

// The home of the one implementation — the only place these may be declared.
const OWNER = 'packages/voice-text/';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.vite', 'coverage']);

// The ONLY dependency this package may take, and it is exhaustive: contracts
// are the floor every layer stands on (ARCHITECTURE.md §II), so importing them
// costs no portability and creates no coupling to an implementation. `VoiceMode`
// moved down there when `LaneVoiceModeStore` (packages/core) had to persist the
// mode — core depends on contracts only, so the shared value type could not stay
// here. Widening this map to anything that is not the contracts package
// re-opens the drift this gate exists to prevent.
const ALLOWED_DEPS = { '@ethosagent/types': 'workspace:*' };

/** Names that must have exactly one definition, in `packages/voice-text/`. */
const OWNED_NAMES = [
  'detectLanguage',
  'isHallucination',
  'splitSentences',
  'sanitizeForSpeech',
  'shouldReplyWithVoice',
  'truncateAtSentenceBoundary',
  'SentenceChunker',
  'stripMarkdown',
  // The wake matcher (V3). Three callers — the satellite's transcript engine,
  // the acoustic engine's phrase normalizer, and the browser's pre-save phrase
  // tester — and a copy that drifts would mean the tester and the microphone
  // disagreeing about which phrase wakes which personality.
  'normalizeUtterance',
  'boundedLevenshtein',
  'matchWakePhrase',
];

// `function foo(`, `const foo = (`, `class Foo {`, and the method-shorthand and
// arrow-property forms a copy tends to take.
function declarationPattern(name: string): RegExp {
  return new RegExp(
    `(?:^|\\s)(?:export\\s+)?(?:async\\s+)?(?:function|class)\\s+${name}\\b|` +
      `(?:^|\\s)(?:export\\s+)?(?:const|let|var)\\s+${name}\\s*(?::[^=]*)?=`,
  );
}

function walkSources(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory absent in this checkout
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      out.push(...walkSources(full));
    } else if (['.ts', '.tsx'].includes(extname(entry))) {
      out.push(full);
    }
  }
  return out;
}

describe('voice-text drift gate', () => {
  it('declares the speakable-text functions exactly once, in packages/voice-text', () => {
    const patterns = OWNED_NAMES.map((name) => [name, declarationPattern(name)] as const);
    const offenders: string[] = [];

    for (const scanDir of SCAN_DIRS) {
      for (const file of walkSources(join(ROOT, scanDir))) {
        const rel = relative(ROOT, file).replace(/\\/g, '/');
        if (rel.startsWith(OWNER)) continue;
        const lines = readFileSync(file, 'utf-8').split('\n');
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? '';
          for (const [name, pattern] of patterns) {
            if (pattern.test(line)) offenders.push(`${rel}:${i + 1}  [${name}]  ${line.trim()}`);
          }
        }
      }
    }

    expect(
      offenders,
      [
        'A second speakable-text implementation appeared. There is exactly one:',
        '@ethosagent/voice-text (packages/voice-text/). Import it instead of',
        'redefining it — the three copies this package replaced had already',
        'drifted apart in what they filtered.',
        '',
        'Offenders:',
        ...offenders,
      ].join('\n'),
    ).toEqual([]);
  });

  it('depends on nothing but contracts', () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, 'packages/voice-text/package.json'), 'utf-8'),
    ) as Record<string, unknown>;
    expect(pkg.dependencies).toEqual(ALLOWED_DEPS);
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it('imports nothing outside itself but contracts', () => {
    const imports = new Set<string>();
    for (const file of walkSources(join(ROOT, 'packages/voice-text/src'))) {
      if (file.includes('__tests__')) continue;
      for (const match of readFileSync(file, 'utf-8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = match[1] ?? '';
        if (!spec.startsWith('.') && !(spec in ALLOWED_DEPS)) imports.add(spec);
      }
    }
    expect([...imports]).toEqual([]);
  });
});
