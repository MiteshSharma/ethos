import type {
  CronDeliveryTarget,
  RecipeBundleWire,
  RecipeInstallReport,
  RecipePreflight,
} from '@ethosagent/web-contracts';
import { Alert, Button } from 'antd';
import { Link } from 'react-router-dom';
import { chatTargetValue, describeDailyTime, recipeAgentName } from '../../lib/recipes';
import { PostInstallList } from './RecipePrereqs';
import { RecipeRowItem, RecipeRowList } from './RecipeRowList';

// The post-install state (plan/phases/recipes-gallery.md §5) — a persistent
// panel, not a toast that vanishes.
//
// The stage list is a COMPLETED SUMMARY read off the returned report, not a
// live progress feed: `recipes.install` is one call that returns one report
// (§4 rejected `installStream`), so there are no per-stage timings to show and
// inventing them would be theatre about work that already finished.
//
// Two failure shapes, drawn differently on purpose. `rolledBack` is
// compensation that WORKED: those objects are gone and nothing is owed. An
// `orphaned` row is compensation that itself failed — an object still on the
// machine that only a human can remove — so it names the page that deletes it.
// Collapsing the two would tell the user to go clean up things that are
// already gone, or worse, stay silent about things that are not.

export function RecipeInstallPanel({
  bundle,
  report,
  onOpenChat,
  schedules = [],
  target = null,
  agentName,
}: {
  bundle: RecipeBundleWire;
  report: RecipeInstallReport;
  onOpenChat: () => void;
  /** The resolved schedules preflight computed, for the "what happens next" facts. */
  schedules?: RecipePreflight['willCreate']['cronJobs'];
  /** The chat the user picked, when this recipe delivers into one. */
  target?: CronDeliveryTarget | null;
  /** Attach mode: the chosen personality's name. Create mode reads the bundle's. */
  agentName?: string;
}) {
  const personalityId = report.created.personality;
  const name = recipeAgentName(bundle, agentName);
  const attach = bundle.personality.mode === 'attach';

  return (
    <div className="recipe-install-panel">
      {report.failure ? (
        <Alert
          type="error"
          showIcon
          message={report.failure.message}
          description={report.failure.action}
        />
      ) : (
        <Alert
          type="success"
          showIcon
          message={attach ? `Attached to ${name}.` : `${name} is installed.`}
          description={
            report.remaining.length > 0
              ? 'Everything installable is installed. The list below is what is left for you.'
              : 'Nothing is left to do.'
          }
        />
      )}

      <section className="recipe-section">
        <div className="recipe-section-label">What was applied</div>
        <RecipeRowList>
          {personalityId ? (
            <RecipeRowItem
              glyph="✓"
              tone="ok"
              label={attach ? 'Attached to the agent' : 'Wrote the agent'}
              detail={
                attach
                  ? 'SOUL.md section · toolset · filesystem reach'
                  : 'SOUL.md · config.yaml · toolset.yaml'
              }
              value={
                <Link className="recipe-mono" to={`/p/${personalityId}/identity`}>
                  {personalityId}
                </Link>
              }
            />
          ) : null}
          {report.created.channelBot ? (
            <RecipeRowItem
              glyph="✓"
              tone="ok"
              label="Created the bot and bound it to the agent"
              detail="Communications now lists it — the install did the binding, which could not happen before the agent existed."
              value={
                <Link className="recipe-mono" to="/communications">
                  {report.created.channelBot}
                </Link>
              }
            />
          ) : null}
          {report.created.cronJobs.map((name) => (
            <RecipeRowItem
              key={name}
              glyph="✓"
              tone="ok"
              label="Scheduled the job"
              detail={name}
              value={
                personalityId ? (
                  <Link className="recipe-mono" to={`/p/${personalityId}/schedule`}>
                    scheduled
                  </Link>
                ) : (
                  <span className="recipe-mono">scheduled</span>
                )
              }
            />
          ))}
          {report.created.mcpAttachments.map((name) => (
            <RecipeRowItem
              key={name}
              glyph="✓"
              tone="ok"
              label="Attached the MCP server"
              detail={name}
              value={
                <Link className="recipe-mono" to="/mcp">
                  attached
                </Link>
              }
            />
          ))}
          {report.skipped.map((row) => (
            <RecipeRowItem
              key={row.what}
              glyph="○"
              tone="muted"
              label={`Skipped ${row.what}`}
              detail={row.because}
              value={<span className="recipe-mono">skipped</span>}
            />
          ))}
          {report.created.cronJobs.length === 0 &&
          report.created.mcpAttachments.length === 0 &&
          report.skipped.length === 0 &&
          !report.created.channelBot &&
          !personalityId ? (
            <RecipeRowItem glyph="○" tone="muted" label="Nothing — everything already existed." />
          ) : null}
        </RecipeRowList>
      </section>

      {report.rolledBack.length > 0 && (
        <section className="recipe-section">
          <div className="recipe-section-label">Rolled back</div>
          <RecipeRowList>
            {report.rolledBack.map((row) => (
              <RecipeRowItem
                key={row.what}
                glyph={row.ok ? '✓' : '✗'}
                tone={row.ok ? 'ok' : 'no'}
                label={<span className="recipe-mono">{row.what}</span>}
                value={
                  <span className="recipe-mono">{row.ok ? 'removed' : 'could not be removed'}</span>
                }
              />
            ))}
          </RecipeRowList>
        </section>
      )}

      {report.orphaned.length > 0 && (
        <section className="recipe-section">
          <div className="recipe-section-label">Left behind — delete these yourself</div>
          <RecipeRowList>
            {report.orphaned.map((row) => (
              <RecipeRowItem
                key={row.what}
                glyph="✗"
                tone="no"
                label={<span className="recipe-mono">{row.what}</span>}
                detail={
                  row.href.startsWith('/') ? <Link to={row.href}>Open {row.href}</Link> : row.href
                }
                value={<span className="recipe-mono">orphaned</span>}
              />
            ))}
          </RecipeRowList>
        </section>
      )}

      {report.ok ? (
        <div className="recipe-cols">
          <WhatHappensNext
            bundle={bundle}
            report={report}
            schedules={schedules}
            target={target}
            agentName={agentName}
          />
          <div>
            <PostInstallList items={report.remaining} title="Still on you" />
            {personalityId && report.starterPrompt ? (
              <section className="recipe-section">
                <div className="recipe-section-label">Try it now</div>
                <div className="recipe-actions">
                  <Button type="primary" onClick={onOpenChat}>
                    Open chat with {name}
                  </Button>
                </div>
                <div className="recipe-field-help">
                  The starter prompt lands in the composer. Nothing is sent for you.
                </div>
              </section>
            ) : null}
          </div>
        </div>
      ) : (
        <PostInstallList items={report.remaining} title="Still on you" />
      )}
    </div>
  );
}

/**
 * The facts about the run that has not happened yet.
 *
 * Deliberately NOT a sample of the agent's output. Every line here is
 * something the install actually produced or the user actually chose — the
 * resolved schedule, the next fire time preflight computed, the chat that was
 * stamped as the destination, and the bundle's own starter prompt. A mocked-up
 * briefing in a chat bubble would be the one thing on this screen that never
 * happened, and the header says as much.
 */
function WhatHappensNext({
  bundle,
  report,
  schedules,
  target,
  agentName,
}: {
  bundle: RecipeBundleWire;
  report: RecipeInstallReport;
  schedules: RecipePreflight['willCreate']['cronJobs'];
  target: CronDeliveryTarget | null;
  agentName?: string;
}) {
  const scheduled = schedules.filter((job) => report.created.cronJobs.includes(job.name));

  return (
    <div>
      <div className="recipe-section-label">Example — not your data</div>
      <div className="recipe-sample">
        <div className="recipe-sample-bar">
          <span className="recipe-sample-avatar" />
          <span className="recipe-sample-name">{recipeAgentName(bundle, agentName)}</span>
          <span className="recipe-sample-badge recipe-mono">example</span>
        </div>
        <RecipeRowList>
          {scheduled.map((job) => {
            const when = describeDailyTime(job.schedule);
            return (
              <RecipeRowItem
                key={job.name}
                glyph="●"
                label={job.name}
                detail={`${when ? `${when}, ` : ''}server local time${
                  job.nextRun ? ` · next run ${new Date(job.nextRun).toLocaleString()}` : ''
                }`}
                value={<span className="recipe-mono">{job.schedule}</span>}
              />
            );
          })}
          {target ? (
            <RecipeRowItem
              glyph="●"
              label="Delivers to"
              detail={target.label}
              value={<span className="recipe-mono">{chatTargetValue(target)}</span>}
            />
          ) : null}
          {report.starterPrompt ? (
            <RecipeRowItem
              glyph="●"
              label="Ask it this first"
              detail={report.starterPrompt}
              value={<span className="recipe-mono">prompt</span>}
            />
          ) : null}
        </RecipeRowList>
        <div className="recipe-sample-stamp recipe-mono">
          nothing has run yet — this is the schedule, not a delivered message
        </div>
      </div>
    </div>
  );
}
