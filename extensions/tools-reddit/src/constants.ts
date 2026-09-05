// ---------------------------------------------------------------------------
// Shared between reddit_search (index.ts) and reddit_thread (thread.ts):
// the two Reddit hosts every call touches, the named-secret refs both tools
// resolve credentials from, and the settings help text both render.
// ---------------------------------------------------------------------------

export const SEARCH_HOST = 'oauth.reddit.com';
export const TOKEN_HOST = 'www.reddit.com';

export const DEFAULT_CLIENT_ID_REF = 'providers/reddit/client_id';
export const DEFAULT_CLIENT_SECRET_REF = 'providers/reddit/client_secret';

export const HELP_TEXT = `1. Go to reddit.com/prefs/apps while logged into the Reddit account you want this tool to act under.
2. Click "create app" (or "create another app" if you have existing ones).
3. Choose type "script".
4. Give it a name (e.g. "ethos-marketing-research") and set the redirect uri field to http://localhost:8080 — required by Reddit's form even though script apps don't use it.
5. Click "create app".
6. The string shown under the app's name (a short id, not labeled) is the client_id.
7. The field labeled "secret" is the client_secret.`;
