import { useLocation, useNavigate } from 'react-router-dom';
import { usePersonalityList } from '../features/personalities/api/queries';
import { createActionForPathname, createActionHref } from '../lib/createActions';
import { capitalize, extractWorkspacePersonalityId, resolveBreadcrumb } from '../lib/scopeNav';

// P1b — plan/phases/personality-first-ui.md. The breadcrumb that lives "in
// every stage header" — chrome, not page body: rendered by App.tsx in its
// own grid row above the routed content, so no page component changes to
// get it. "Engineer / Skills" on the accented column at the workspace
// altitude; "◎ Library / All skills" neutral at the Library altitude. The
// `--accent` custom property (undefined at Library, set by the workspace
// wrapper in App.tsx) is what actually recolors `.stage-header-scope` — see
// `var(--accent, var(--ethos-info))` in styles.css.
//
// P5 — "Per-list create actions": the trailing button, when the current
// route has one (`../lib/createActions.ts`). StageHeader never renders a
// modal itself; clicking just navigates to the pane's own create trigger.

export function StageHeader() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const personalityId = extractWorkspacePersonalityId(pathname);
  const { data } = usePersonalityList();
  const name = personalityId
    ? (data?.items.find((p) => p.id === personalityId)?.name ?? capitalize(personalityId))
    : null;

  const crumb = resolveBreadcrumb(pathname, name);
  if (!crumb) return null;

  const createAction = createActionForPathname(pathname);
  const createHref = createAction ? createActionHref(createAction, personalityId) : null;

  return (
    <header className="stage-header">
      {crumb.altitude === 'library' && (
        <span className="stage-header-ring" aria-hidden="true">
          ◎
        </span>
      )}
      <span className="stage-header-scope">{crumb.scopeLabel}</span>
      <span className="stage-header-sep" aria-hidden="true">
        /
      </span>
      <span className="stage-header-pane">{crumb.paneLabel}</span>
      {createAction && createHref && (
        <>
          <span style={{ flex: 1 }} />
          <button type="button" className="page-action-btn" onClick={() => navigate(createHref)}>
            {createAction.label}
          </button>
        </>
      )}
    </header>
  );
}
