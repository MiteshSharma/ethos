import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The desktop main process clamps the three retention numbers on the way to the
// store (`config:update`). If the card's inputs accept a wider range, the value
// the user typed is silently rewritten. Asserted against both sources so the
// two tables cannot drift apart. Same source-text technique as
// `features/voice/__tests__/call-row-css.test.ts`.

const root = join(import.meta.dirname, '..', '..', '..', '..', '..');
const page = readFileSync(join(root, 'apps', 'web', 'src', 'pages', 'DesktopSettings.tsx'), 'utf8');
const ipc = readFileSync(join(root, 'apps', 'desktop', 'src', 'main', 'ipc.ts'), 'utf8');

function clampBounds(key: string): { min: number; max: number } {
  const match = ipc.match(new RegExp(`\\{ key: '${key}', min: (\\d+), max: (\\d+),`));
  expect(match, `missing clamp entry for ${key}`).not.toBeNull();
  return { min: Number(match?.[1]), max: Number(match?.[2]) };
}

function inputBounds(stateSetter: string): { min: number; max: number } {
  // The `<InputNumber>` whose onChange feeds the given setter.
  const end = page.indexOf(`${stateSetter}(v ??`);
  expect(end, `missing input for ${stateSetter}`).toBeGreaterThan(-1);
  const start = page.lastIndexOf('<InputNumber', end);
  const input = page.slice(start, end);
  return {
    min: Number(input.match(/min=\{(\d+)\}/)?.[1]),
    max: Number(input.match(/max=\{(\d+)\}/)?.[1]),
  };
}

describe('desktop retention bounds', () => {
  it.each([
    ['retentionDays', 'setRetentionDays'],
    ['traceLogDays', 'setTraceLogDays'],
    ['observabilityDays', 'setObservabilityDays'],
  ])('%s is refused at entry rather than clamped on the way to the store', (key, setter) => {
    expect(inputBounds(setter)).toEqual(clampBounds(key));
  });
});
