import type { RecipeBundleWire, RecipePreflight } from '@ethosagent/web-contracts';
import { Link } from 'react-router-dom';
import { createsRows, type PreflightRow, preflightGroups } from '../../lib/recipes';
import { RecipeRowItem, RecipeRowList } from './RecipeRowList';

// The read-only prerequisite surfaces of the Recipes flow
// (plan/phases/recipes-gallery.md §5), split the three ways a user reads them:
//
//   Ready     — already true on this machine, nothing to do.
//   Needs you — refusals and unanswered questions. The install waits on these.
//   Optional  — the install runs without them, said out loud so a missing
//               optional MCP server is never mistaken for a blocker.
//
// Rows, not cards, and no decorative emoji — ✓ / ✗ / ! / ○ are status glyphs,
// always paired with the word. The line the whole flow rests on: a BLOCKING
// row is a refusal with an action and often a page that fixes it; a WARNING is
// something the user should know and never stops the install.

function GroupRows({ rows }: { rows: PreflightRow[] }) {
  return (
    <RecipeRowList>
      {rows.map((row) => (
        <RecipeRowItem
          key={row.key}
          glyph={row.glyph}
          tone={row.tone}
          label={row.label}
          detail={
            row.href?.startsWith('/') ? (
              <>
                {row.detail} <Link to={row.href}>Open {row.href}</Link>
              </>
            ) : (
              row.detail
            )
          }
          value={<span className="recipe-mono">{row.value}</span>}
        />
      ))}
    </RecipeRowList>
  );
}

/** What is already true. Rendered only when there is something to say. */
export function ReadyGroup({
  bundle,
  preflight,
}: {
  bundle: RecipeBundleWire;
  preflight: RecipePreflight | undefined;
}) {
  const { ready } = preflightGroups(bundle, preflight);
  if (ready.length === 0) return null;

  return (
    <section className="recipe-section">
      <div className="recipe-section-label">Ready</div>
      <GroupRows rows={ready} />
    </section>
  );
}

/**
 * The list that shrinks as the form fills in — the feel of the feature.
 *
 * Always rendered, including when it is empty: "nothing left" is the answer
 * the user is waiting for, and a section that vanishes cannot give it.
 */
export function NeedsYouGroup({
  bundle,
  preflight,
}: {
  bundle: RecipeBundleWire;
  preflight: RecipePreflight | undefined;
}) {
  const { needsYou } = preflightGroups(bundle, preflight);

  return (
    <section className="recipe-section">
      <div className="recipe-section-label">Needs you</div>
      {needsYou.length === 0 ? (
        <div className="recipe-field-help">Nothing — every question is answered.</div>
      ) : (
        <GroupRows rows={needsYou} />
      )}
    </section>
  );
}

/** Warnings, under the label that says what a warning actually means here. */
export function OptionalGroup({
  bundle,
  preflight,
}: {
  bundle: RecipeBundleWire;
  preflight: RecipePreflight | undefined;
}) {
  const { optional } = preflightGroups(bundle, preflight);
  if (optional.length === 0) return null;

  return (
    <section className="recipe-section">
      <div className="recipe-section-label">Optional — install works without these</div>
      <GroupRows rows={optional} />
    </section>
  );
}

/** What the bundle declares it will put on the machine. The recipe step. */
export function CreatesList({ bundle }: { bundle: RecipeBundleWire }) {
  return (
    <section className="recipe-section">
      <div className="recipe-section-label">What this creates</div>
      <RecipeRowList>
        {createsRows(bundle).map((row) => (
          <RecipeRowItem
            key={row.key}
            glyph="●"
            label={row.label}
            detail={row.detail}
            value={<span className="recipe-mono">{row.value}</span>}
          />
        ))}
      </RecipeRowList>
    </section>
  );
}

/** Every object the install would create, named. The preview step. */
export function WillCreateList({
  bundle,
  preflight,
}: {
  bundle: RecipeBundleWire;
  preflight: RecipePreflight;
}) {
  const { personality, cronJobs, mcpAttachments } = preflight.willCreate;
  const attach = bundle.personality.mode === 'attach';

  return (
    <section className="recipe-section">
      <div className="recipe-section-label">{attach ? 'Will change' : 'Will create'}</div>
      <RecipeRowList>
        <RecipeRowItem
          glyph="●"
          label={attach ? 'Attaches to' : 'Agent'}
          detail={
            attach
              ? 'its SOUL.md, toolset and filesystem reach'
              : personality.isNew
                ? undefined
                : 'already exists — reused'
          }
          value={<span className="recipe-mono">{personality.id}</span>}
        />
        {cronJobs.map((job) => (
          <RecipeRowItem
            key={job.name}
            glyph="●"
            label={`Schedule — ${job.name}`}
            detail={
              job.exists
                ? 'already exists — skipped'
                : job.nextRun
                  ? `next run ${new Date(job.nextRun).toLocaleString()}`
                  : undefined
            }
            value={<span className="recipe-mono">{job.schedule}</span>}
          />
        ))}
        {mcpAttachments.map((name) => (
          <RecipeRowItem
            key={name}
            glyph="●"
            label="MCP server"
            value={<span className="recipe-mono">{name}</span>}
          />
        ))}
      </RecipeRowList>
    </section>
  );
}

/** What the installer cannot do. Never dressed up as done (D6). */
export function PostInstallList({
  items,
  title,
}: {
  items: RecipePreflight['postInstall'];
  title: string;
}) {
  if (items.length === 0) return null;

  return (
    <section className="recipe-section">
      <div className="recipe-section-label">{title}</div>
      <RecipeRowList>
        {items.map((item) => (
          <RecipeRowItem
            key={item.label}
            glyph="○"
            tone="muted"
            label={item.label}
            detail={
              item.href?.startsWith('/') ? (
                <>
                  {item.detail} <Link to={item.href}>Open {item.href}</Link>
                </>
              ) : (
                item.detail
              )
            }
            value={<span className="recipe-mono">{item.kind}</span>}
          />
        ))}
      </RecipeRowList>
    </section>
  );
}
