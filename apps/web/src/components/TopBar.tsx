import { useQuery } from '@tanstack/react-query';
import { rpc } from '../rpc';

// v0 top bar — brand on the left, current provider/model + connection
// status on the right, plus the right-drawer toggle. The full chrome
// (session indicator, ⌘K palette, connection-status dot) keeps growing
// here as v0.5 surfaces land.

export interface TopBarProps {
  drawerOpen: boolean;
  onToggleDrawer: () => void;
}

export function TopBar({ drawerOpen, onToggleDrawer }: TopBarProps) {
  const { data, error, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
    // 30s staleTime is fine — config changes are rare and Settings tab
    // (v1) will invalidate explicitly on update.
  });

  return (
    <header className="topbar">
      <span className="topbar-brand">Ethos</span>
      <div className="topbar-right">
        <span className="topbar-status">
          {isLoading
            ? 'connecting…'
            : error
              ? 'offline'
              : data
                ? `${data.provider} · ${data.model}`
                : '—'}
        </span>
        <button
          type="button"
          className={`topbar-drawer-toggle${drawerOpen ? ' active' : ''}`}
          onClick={onToggleDrawer}
          aria-label={drawerOpen ? 'Hide activity drawer' : 'Show activity drawer'}
          aria-pressed={drawerOpen}
          title={drawerOpen ? 'Hide activity (⌘.)' : 'Show activity (⌘.)'}
        >
          {/* Stack-of-lines glyph — denotes the live stream pane */}
          <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
            <rect x="2" y="3" width="10" height="1.5" rx="0.5" fill="currentColor" />
            <rect x="2" y="6.25" width="10" height="1.5" rx="0.5" fill="currentColor" />
            <rect x="2" y="9.5" width="10" height="1.5" rx="0.5" fill="currentColor" />
          </svg>
        </button>
      </div>
    </header>
  );
}
