import { useQuery } from '@tanstack/react-query';
import { rpc } from '../rpc';

// v0 top bar — brand on the left, current provider/model + connection
// status on the right. The full chrome (session indicator, ⌘K palette,
// connection-status dot) lands with v0.5 + chat polish; here it's a
// proof-of-life surface that confirms RPC works end-to-end.

export function TopBar() {
  const { data, error, isLoading } = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
    // 30s staleTime is fine — config changes are rare and Settings tab
    // (v1) will invalidate explicitly on update.
  });

  return (
    <header className="topbar">
      <span className="topbar-brand">Ethos</span>
      <span className="topbar-status">
        {isLoading
          ? 'connecting…'
          : error
            ? 'offline'
            : data
              ? `${data.provider} · ${data.model}`
              : '—'}
      </span>
    </header>
  );
}
