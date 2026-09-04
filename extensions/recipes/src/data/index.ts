// The shipped catalog. Bundles are typed consts, not JSON: the compiler catches
// a field typo at `pnpm typecheck`, and the Zod schema still parses the whole
// array in the table test. No filesystem discovery, no user-authored recipes.

import type { RecipeBundle } from '../schema';
import { linkArchiver } from './link-archiver';
import { morningBriefing } from './morning-briefing';
import { obsidianSecondBrain } from './obsidian-second-brain';
import { webWatchdog } from './web-watchdog';

export const RECIPES: readonly RecipeBundle[] = [
  morningBriefing,
  obsidianSecondBrain,
  linkArchiver,
  webWatchdog,
];

export { linkArchiver, morningBriefing, obsidianSecondBrain, webWatchdog };
