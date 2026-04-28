// Deterministic personality mark — the load-bearing identity affordance
// from DESIGN.md ("the agent team is present"). Every surface that needs
// to render a personality (web SVG, TUI ASCII, future OG-image generator)
// reads from this single algorithm so a personality always looks like
// itself, regardless of where it appears.
//
// Spec (DESIGN.md → "Personality marks (generative SVG)"):
//   1. Hash personality id (FNV-1a 32-bit).
//   2. 5×5 grid, mirror-symmetric — generate columns 0..2, mirror to 3..4.
//   3. Each cell is filled based on a bit from the hash; opacity is
//      drawn from {0.55, 0.68, 0.81, 0.93} via 2 hash bits.
//   4. Background: rounded square (corner radius = size × 0.16),
//      accent color at 0x22 alpha (~13%).
//   5. Filled cells: solid accent at the computed opacity.

export interface PersonalityMarkCell {
  /** Row 0..4 in the 5×5 grid. */
  row: number;
  /** Column 0..4 in the 5×5 grid. */
  col: number;
  /** Fill opacity, one of {0.55, 0.68, 0.81, 0.93}. */
  opacity: number;
}

export interface PersonalityMarkSpec {
  /** Filled cells, including their mirror reflections. */
  cells: PersonalityMarkCell[];
  /** Background corner radius as a fraction of the mark's bounding size. */
  bgRadius: number;
  /** Background fill alpha (0..1). */
  bgAlpha: number;
}

const FNV_OFFSET_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const OPACITY_LEVELS = [0.55, 0.68, 0.81, 0.93] as const;
const GRID_SIZE = 5;
const UNIQUE_COLS = 3; // 0..2; columns 3 and 4 are mirrors of 1 and 0.
const _FILL_BITS_NEEDED = GRID_SIZE * UNIQUE_COLS; // 15

/** FNV-1a 32-bit hash. Standard, fast, no dependencies. */
export function fnv1a32(input: string): number {
  let hash = FNV_OFFSET_32;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Math.imul handles 32-bit overflow; the explicit bit math at the end
    // forces unsigned interpretation so callers can safely shift.
    hash = Math.imul(hash, FNV_PRIME_32);
  }
  return hash >>> 0;
}

/**
 * Generate the deterministic mark spec for a personality id. Pure
 * function — call it on the server, the client, or in a worker; identical
 * inputs always produce identical output.
 *
 * Two FNV-1a passes: one for fill bits, one for opacity bits. A single
 * 32-bit hash isn't wide enough (15 fill bits + 30 opacity bits = 45),
 * so the second pass keys off `${id}:o` to keep the algorithm pure.
 */
export function generatePersonalityMark(personalityId: string): PersonalityMarkSpec {
  const fillHash = fnv1a32(personalityId);
  const opacityHash = fnv1a32(`${personalityId}:o`);

  const cells: PersonalityMarkCell[] = [];
  for (let row = 0; row < GRID_SIZE; row++) {
    for (let uniqueCol = 0; uniqueCol < UNIQUE_COLS; uniqueCol++) {
      const cellIndex = row * UNIQUE_COLS + uniqueCol;
      const filled = (fillHash >>> cellIndex) & 1;
      if (!filled) continue;

      const opacityBits = (opacityHash >>> (cellIndex * 2)) & 0b11;
      const opacity = OPACITY_LEVELS[opacityBits] ?? OPACITY_LEVELS[0];

      cells.push({ row, col: uniqueCol, opacity });
      // Mirror to the right half. Center column (uniqueCol === 2) has no
      // mirror — col 4 - 2 = 2 is itself.
      if (uniqueCol < UNIQUE_COLS - 1) {
        cells.push({ row, col: GRID_SIZE - 1 - uniqueCol, opacity });
      }
    }
  }

  return {
    cells,
    bgRadius: 0.16,
    bgAlpha: 0x22 / 0xff,
  };
}

/**
 * Built-in personality accents from DESIGN.md. Custom personalities fall
 * back to operator grey for now — a sensible neutral until per-
 * personality color customization lands as its own decision.
 */
export const PERSONALITY_ACCENTS: Readonly<Record<string, string>> = Object.freeze({
  researcher: '#4A9EFF',
  engineer: '#4ADE80',
  reviewer: '#F59E0B',
  coach: '#E879F9',
  operator: '#94A3B8',
});

export function personalityAccent(personalityId: string): string {
  return PERSONALITY_ACCENTS[personalityId] ?? PERSONALITY_ACCENTS.operator ?? '#94A3B8';
}

/** True when the id matches one of the five built-in personalities. */
export function isBuiltinPersonality(personalityId: string): boolean {
  return personalityId in PERSONALITY_ACCENTS;
}

/** Public list of built-in ids — useful for tests + iteration. */
export const BUILTIN_PERSONALITY_IDS: ReadonlyArray<string> = Object.freeze(
  Object.keys(PERSONALITY_ACCENTS),
);
