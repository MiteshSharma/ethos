import { Alert, Skeleton, Typography } from 'antd';
import { Link } from 'react-router-dom';
import { RecipeStepper } from '../components/recipes/RecipeStepper';
import { usePersonalityList } from '../features/personalities/api/queries';
import { useRecipeBundles, useRecipeList } from '../features/recipes/api/queries';
import { recipeMetaLine } from '../lib/recipes';
import { personalityAccent } from '../lib/theme';

// Recipes gallery — plan/phases/recipes-gallery.md §5.
//
// A CARD GRID, and that is a recorded exception rather than a drift.
// DESIGN.md's "cards earn existence" rule names card grids as slop and the
// first cut of this page was stacked rows for exactly that reason. The user
// reviewed both that page and a clickable card-grid prototype and chose the
// grid on 2026-09-04; DESIGN.md's own rule is "do not deviate without explicit
// user approval", and this is that approval. It is scoped to this gallery —
// see the DESIGN.md decisions log entry — and it is NOT a licence to
// card-grid other surfaces. The cards are built from raw primitives: the Antd
// `Card` primitive is still unused here, and each card is a real `<Link>` so
// it keeps keyboard focus and middle-click.
//
// The status word is DERIVED (D8 — no install ledger): a recipe reads as
// installed when a personality with its bundle's id exists. That id lives on
// the bundle, not on the list row, so the bundles are fetched alongside — three
// cached reads of a static catalog. The mono meta line comes off the same
// bundle.

export function Recipes() {
  const { data, isLoading, error } = useRecipeList();
  const recipes = data?.recipes ?? [];
  const bundleQueries = useRecipeBundles(recipes.map((r) => r.id));
  const personalities = usePersonalityList();

  if (isLoading) return <Skeleton active paragraph={{ rows: 4 }} />;

  if (error) {
    return (
      <Alert
        type="error"
        showIcon
        message="Could not load recipes"
        description={error instanceof Error ? error.message : String(error)}
      />
    );
  }

  if (recipes.length === 0) {
    return (
      <Typography.Text type="secondary">
        No recipes are shipped in this build. Recipes are first-party and curated — there is nothing
        to install from elsewhere.
      </Typography.Text>
    );
  }

  const installedIds = new Set((personalities.data?.items ?? []).map((p) => p.id));

  return (
    <div className="recipes-page">
      <header className="recipe-detail-header">
        <div className="recipe-eyebrow recipe-mono">
          Library / Recipes · {recipes.length} recipe{recipes.length === 1 ? '' : 's'}
        </div>
        <h2 className="recipe-detail-title">Recipes</h2>
        <p className="recipe-detail-summary">
          Ready-made agents that do one job well. Each installs a personality, its tools and its
          schedule — then starts working.
        </p>
      </header>

      <RecipeStepper current="gallery" />

      <div className="recipe-section-label recipes-grid-label">Available now</div>
      <div className="recipes-grid">
        {recipes.map((recipe, index) => {
          const bundle = bundleQueries[index]?.data?.recipe;
          const personalityId = bundle?.personality.id;
          // Undefined while either half is still loading — the card says
          // nothing rather than saying "Install" about something you have.
          const installed =
            personalityId === undefined || personalities.data === undefined
              ? undefined
              : installedIds.has(personalityId);
          return (
            <Link key={recipe.id} to={`/recipes/${recipe.id}`} className="recipe-card">
              <div className="recipe-card-top">
                <span
                  className="recipe-card-dot"
                  style={
                    personalityId ? { background: personalityAccent(personalityId) } : undefined
                  }
                />
                <span className="recipe-card-name">{recipe.title}</span>
                {installed !== undefined && (
                  <span
                    className={`recipe-card-status${installed ? ' recipe-card-status--on' : ''}`}
                  >
                    {installed ? '✓ Installed' : 'Install'}
                  </span>
                )}
              </div>
              <p className="recipe-card-summary">{recipe.summary}</p>
              <div className="recipe-card-meta recipe-mono">
                {bundle ? recipeMetaLine(bundle) : recipe.tags.join(' · ')}
              </div>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
