// The child route element: resolve `/settings/:category/:section` to a real
// target, then render that category's pane.
//
// It is a child of `SettingsShell`, so it mounts and unmounts BELOW the single
// `<Form>` — which is the whole point of the shape (§5.3). It owns no state.

import { Navigate, useParams } from 'react-router-dom';
import { isDesktop } from '../../lib/desktop';
import { resolveSettingsRoute, settingsRoutePath } from './lib/resolve-settings-route';
import { visibleCategories } from './lib/taxonomy';
import { AutomationPane } from './panes/automation';
import { ChatPane } from './panes/chat';
import { DataPane } from './panes/data';
import { DesktopPane } from './panes/desktop';
import { DeveloperPane } from './panes/developer';
import { GeneralPane } from './panes/general';
import { JobsPane } from './panes/jobs';
import { KeysPane } from './panes/keys';
import { MemoryPane } from './panes/memory';
import { ModelsPane } from './panes/models';
import { SecurityPane } from './panes/security';
import { VoicePane } from './panes/voice';

const PANES: Record<string, () => React.JSX.Element | null> = {
  general: GeneralPane,
  models: ModelsPane,
  memory: MemoryPane,
  chat: ChatPane,
  voice: VoicePane,
  automation: AutomationPane,
  jobs: JobsPane,
  data: DataPane,
  security: SecurityPane,
  keys: KeysPane,
  developer: DeveloperPane,
  desktop: DesktopPane,
};

export function SettingsPaneRoute() {
  const params = useParams<{ category?: string; section?: string }>();
  const categories = visibleCategories(isDesktop);
  const resolved = resolveSettingsRoute(params, categories);
  if (resolved.redirect) {
    return <Navigate to={settingsRoutePath(resolved)} replace={resolved.replace} />;
  }
  const Pane = PANES[resolved.category];
  return Pane ? <Pane /> : null;
}
