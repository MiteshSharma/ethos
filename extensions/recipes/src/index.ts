// @ethosagent/recipes — one-click use-case bundles.
//
// Pure, data-first, and dependent on `@ethosagent/types` only: the bundle
// schema, the `{{input.*}}` templater, and preflight as functions over an
// injected world snapshot. Every write lives at the app layer (R2's
// `recipes.service.ts`), so nothing in this package can install anything.

export { linkArchiver, morningBriefing, obsidianSecondBrain, RECIPES, webWatchdog } from './data';
export {
  type PreflightBlocker,
  type PreflightNeedsInput,
  type PreflightReport,
  type PreflightRequest,
  type PreflightWarning,
  preflightRecipe,
  type RecipeSecretBinding,
  type RecipeSecretOption,
  type RecipeSecretRef,
  type RecipeSecretStatus,
  type RecipeWorldSnapshot,
  secretRequirementSatisfied,
  unknownToolNames,
} from './preflight';
export {
  defaultRecipeSafety,
  INPUT_PLACEHOLDER_PATTERN,
  projectBundle,
  projectPersonality,
  RECIPE_INPUT_KINDS,
  type RecipeAttachBundle,
  type RecipeAttachPersonality,
  type RecipeBothBundle,
  type RecipeBothPersonality,
  type RecipeBundle,
  RecipeBundleSchema,
  type RecipeCreateBundle,
  type RecipeCreatePersonality,
  type RecipeCronJob,
  type RecipeInput,
  type RecipeInstallMode,
  type RecipePersonality,
  type RecipePostInstall,
  type RecipeSecretRequirement,
  resolveInstallMode,
} from './schema';
export {
  appendRecipeSoulSection,
  hasRecipeSoulSection,
  placeholderKeys,
  RecipeTemplateError,
  type ResolvedInputs,
  type ResolvedRecipe,
  recipeSoulMarkers,
  renderRecipe,
  renderTemplate,
  renderTemplatePreview,
  resolveInputs,
  unresolvedPlaceholders,
} from './template';
