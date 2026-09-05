// The text a clarify is presented as, for surfaces that can only render text.
//
// D3 (plan/phases/stealth-browsing-and-takeover.md) — a `browser_takeover`
// clarify is not a question, and a channel cannot answer it: the browser being
// handed over is open on the machine running Ethos, and the hand-back button
// lives in the web chat. So Telegram / Slack / Discord / WhatsApp render one
// sentence that says where the agent is stuck and where to go, instead of a
// prompt that looks answerable in the chat it arrived in.
//
// One function rather than four copies of the same sentence: the wording is a
// contract with the user, and four surfaces drifting apart on it is exactly the
// kind of divergence that makes a takeover unrecoverable on the third channel.

import type { PendingClarify } from '@ethosagent/types';

/**
 * The prompt body for a row, on a text surface. An ordinary question is its own
 * question — unchanged, which is why every call site can pass every row through
 * this without special-casing.
 */
export function clarifyPromptText(row: PendingClarify): string {
  // Absent `kind` means `question` (rows written before D3, and every ordinary
  // clarify since).
  if ((row.kind ?? 'question') !== 'browser_takeover') return row.question;

  const host = hostOf(row.meta?.url);
  const where = host ? ` at ${host}` : '';
  const link = row.meta?.handbackUrl;
  const handback = link
    ? `open the web chat to hand back: ${link}`
    : 'open the web chat to hand back';
  return `I'm stuck on a login${where} — the browser window is open on the machine running Ethos; ${handback}`;
}

/**
 * The hand-back address for a deployment whose web UI is reachable at
 * `webBaseUrl` (`EthosConfig.webBaseUrl`, itself `ETHOS_PUBLIC_URL` first).
 * `/chat` is the web app's own permanent chat entry point, so this names a
 * page that exists rather than inventing a per-session deep link: a row's
 * `sessionId` is a session KEY (`telegram:12345`) on every channel surface,
 * and the web router resolves `?session=` against web session ids, so a
 * composed deep link would 404 exactly the user it was built for.
 *
 * Returns undefined when nothing is configured, or when the configured value
 * is not an absolute http(s) URL. The text form then degrades to naming the
 * web chat without a link — honest, and unchanged from a deployment that
 * never set the key. Never guess a scheme, host or port.
 */
export function handbackUrlFor(webBaseUrl: string | undefined): string | undefined {
  if (!webBaseUrl) return undefined;
  let base: URL;
  try {
    base = new URL(webBaseUrl);
  } catch {
    return undefined;
  }
  if (base.protocol !== 'http:' && base.protocol !== 'https:') return undefined;
  // `webBaseUrl` may carry a path prefix (the origin check in web-api's
  // rpc-origin allows one); keep it, drop only a trailing slash.
  return `${base.origin}${base.pathname.replace(/\/+$/, '')}/chat`;
}

/** The host of a URL, or undefined when there isn't one worth naming. */
function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = new URL(url).host;
    return host.length > 0 ? host : undefined;
  } catch {
    return undefined;
  }
}
