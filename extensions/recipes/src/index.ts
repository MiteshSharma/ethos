// @ethosagent/recipes — one-click use-case bundles.
//
// Pure, data-first, and dependent on `@ethosagent/types` only: the bundle
// schema, the `{{input.*}}` templater, and preflight as functions over an
// injected world snapshot. Every write lives at the app layer (R2's
// `recipes.service.ts`), so nothing in this package can install anything.

export { morningBriefing, RECIPES } from './data';
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
  RECIPE_INPUT_KINDS,
  type RecipeBundle,
  RecipeBundleSchema,
  type RecipeCronJob,
  type RecipeInput,
  type RecipePersonality,
  type RecipePostInstall,
  type RecipeSecretRequirement,
} from './schema';
export {
  placeholderKeys,
  RecipeTemplateError,
  type ResolvedInputs,
  type ResolvedRecipe,
  renderRecipe,
  renderTemplate,
  renderTemplatePreview,
  resolveInputs,
  unresolvedPlaceholders,
} from './template';
