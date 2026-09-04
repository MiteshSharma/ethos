import { Link } from 'react-router-dom';

// The six-step wayfinder across the top of the Recipes flow
// (plan/phases/recipes-gallery.md §5).
//
// Orientation, not action: it says where you are in a six-screen walk that
// spans two routes (`/recipes` → `/recipes/:id`). The outcome-named buttons at
// the foot of each screen are still the things you press to move forward — a
// stepper that also advanced the flow would give the same decision two homes.
//
// Only steps you can legitimately return to are rendered as controls, so the
// tab order never lands on a step that does nothing. `install` and `working`
// are terminal: an install has happened and there is no going back to before
// it.

export type RecipeStepId = 'gallery' | 'detail' | 'inputs' | 'confirm' | 'install' | 'working';

export const RECIPE_STEPS: ReadonlyArray<{ id: RecipeStepId; label: string }> = [
  { id: 'gallery', label: 'Recipes' },
  { id: 'detail', label: 'The recipe' },
  { id: 'inputs', label: 'Needs you' },
  { id: 'confirm', label: 'Preview' },
  { id: 'install', label: 'Install' },
  { id: 'working', label: 'Working' },
];

/** The steps a user may click backwards into. Never `install` or `working`. */
const BACKABLE = new Set<RecipeStepId>(['detail', 'inputs', 'confirm']);

export function RecipeStepper({
  current,
  onGoTo,
}: {
  current: RecipeStepId;
  /** Absent while installing and after — going back is not a thing then. */
  onGoTo?: (step: RecipeStepId) => void;
}) {
  const currentIndex = RECIPE_STEPS.findIndex((step) => step.id === current);

  return (
    <nav className="recipe-stepper" aria-label="Recipe steps">
      {RECIPE_STEPS.map((step, index) => {
        const done = index < currentIndex;
        const isCurrent = index === currentIndex;
        const body = (
          <>
            <span className="recipe-step-n recipe-mono">{String(index + 1).padStart(2, '0')}</span>
            <span className="recipe-step-label">{step.label}</span>
          </>
        );

        if (step.id === 'gallery' && !isCurrent) {
          return (
            <Link key={step.id} to="/recipes" className="recipe-step recipe-step--done">
              {body}
            </Link>
          );
        }

        if (done && onGoTo && BACKABLE.has(step.id)) {
          return (
            <button
              key={step.id}
              type="button"
              className="recipe-step recipe-step--done"
              onClick={() => onGoTo(step.id)}
            >
              {body}
            </button>
          );
        }

        return (
          <span
            key={step.id}
            className={`recipe-step ${isCurrent ? 'recipe-step--current' : done ? 'recipe-step--done' : 'recipe-step--ahead'}`}
            aria-current={isCurrent ? 'step' : undefined}
          >
            {body}
          </span>
        );
      })}
    </nav>
  );
}
