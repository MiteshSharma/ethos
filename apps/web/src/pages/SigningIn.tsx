import { Spin } from 'antd';

// The server's /auth/exchange route does the real work — it validates the
// ?t=<token>, sets the cookie, rotates the token, then 302s to /.
// This page exists so a user who lands on /signing-in directly (e.g. an
// outdated bookmark or a paste of the post-redirect URL with the cookie
// not yet set) sees something coherent rather than a blank screen.

export function SigningIn() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', height: '100%', gap: 12 }}>
      <Spin />
      <span className="empty-pane">Signing in…</span>
    </div>
  );
}
