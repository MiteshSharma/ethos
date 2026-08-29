// Desktop — connection, storage, retention, keychain & auth.
//
// Its seven cards talk to Electron IPC, not to `config.yaml`, so the category is
// only addressable in the desktop build; `visibleCategories()` drops it on web
// and `resolveSettingsRoute` therefore treats `/settings/desktop` there as an
// unknown category. Converting the cards to rows is Phase 4.

import { DesktopSettings } from '../../DesktopSettings';

export function DesktopPane() {
  return <DesktopSettings />;
}
