// ---------------------------------------------------------------------------
// Bot-wall detection (T4)
// ---------------------------------------------------------------------------
//
// A bot wall answers a navigation with a real page: 200 or 403/429/503, HTML,
// a title. Playwright reports success and `snapshotPage` returns an
// accessibility tree of an interstitial. Without this check the agent reads
// "Just a moment..." as the article it asked for and keeps going.
//
// D2 — detection HINTS, it never acts. No silent retry, no automatic tier
// switch: escalation is an explicit tool call the personality's toolset has to
// allow.
//
// The hint names an escalation tool ONLY when the caller passes one, and a
// caller passes one only for a tool it actually registered. Naming a tool the
// process does not have is worse than naming none: the model spends a turn
// calling it, gets "unknown tool", and the user is told to reach for something
// that does not exist. The stealth tier (T7) is gated behind a spike that has
// not run, so nothing may hardcode `browser_stealth_session` here.

/** HTTP statuses a bot wall answers with. */
const BLOCK_STATUSES = new Set([403, 429, 503]);

export interface BlockSignal {
  /** Named vendor, or undefined when only the status gave it away. */
  vendor?: string;
  /** The status that triggered it, when one did. */
  status?: number;
  /** The header or phrase that matched — quoted back so the hint is checkable. */
  marker: string;
}

export interface BlockDetectorInput {
  status?: number;
  /** Response headers, lower-cased keys (Playwright's `response.headers()`). */
  headers?: Record<string, string>;
  title?: string;
  /** Rendered page text — the accessibility snapshot is enough. */
  text?: string;
}

interface VendorRule {
  vendor: string;
  /** Header name → substring that must appear in its value ('' = presence). */
  headers?: Array<[string, string]>;
  /** Case-insensitive phrases in the title or rendered text. */
  phrases?: string[];
}

// Signatures are deliberately narrow. A false positive tells the agent a page
// it CAN read is walled, which is worse than a miss: the miss is recoverable
// (the snapshot is right there), the false positive burns an escalation.
const VENDORS: VendorRule[] = [
  {
    vendor: 'Cloudflare',
    // `cf-mitigated` only, NOT `server: cloudflare` — a large fraction of the
    // web is fronted by Cloudflare and serves fine. The mitigation header is
    // the one that means "this response is the wall".
    headers: [['cf-mitigated', '']],
    phrases: [
      'just a moment',
      'attention required! | cloudflare',
      'checking your browser before accessing',
      'cloudflare ray id',
      'enable javascript and cookies to continue',
    ],
  },
  {
    vendor: 'DataDome',
    headers: [
      ['x-datadome', ''],
      ['x-dd-b', ''],
    ],
    phrases: ['captcha-delivery.com', 'datadome'],
  },
  {
    vendor: 'PerimeterX',
    headers: [['x-px-block', '']],
    phrases: ['px-captcha', 'perimeterx', 'please verify you are a human'],
  },
  {
    vendor: 'Akamai',
    // Same reasoning as Cloudflare: `server: AkamaiGHost` is on every
    // Akamai-served page. The reference block is unique to the deny page.
    phrases: ['reference #18.'],
  },
];
function matchesHeaders(rule: VendorRule, headers: Record<string, string>): string | undefined {
  for (const [name, needle] of rule.headers ?? []) {
    const value = headers[name];
    if (value === undefined) continue;
    if (needle === '' || value.toLowerCase().includes(needle)) return `header ${name}`;
  }
  return undefined;
}

function matchesPhrase(rule: VendorRule, haystack: string): string | undefined {
  for (const phrase of rule.phrases ?? []) {
    if (haystack.includes(phrase)) return `"${phrase}"`;
  }
  return undefined;
}

/**
 * Report a bot wall, or `null` for an ordinary page.
 *
 * Two independent triggers, per the plan's failure table: a named vendor
 * signature (header or on-page phrase) OR one of 403/429/503. A status with a
 * recognised vendor names the vendor; a status alone reports an unnamed wall.
 */
export function detectBlock(input: BlockDetectorInput): BlockSignal | null {
  const headers = input.headers ?? {};
  const haystack = `${input.title ?? ''}\n${input.text ?? ''}`.toLowerCase();

  for (const rule of VENDORS) {
    const marker = matchesHeaders(rule, headers) ?? matchesPhrase(rule, haystack);
    if (marker !== undefined) {
      return {
        vendor: rule.vendor,
        marker,
        ...(input.status !== undefined ? { status: input.status } : {}),
      };
    }
  }

  if (input.status !== undefined && BLOCK_STATUSES.has(input.status)) {
    return { status: input.status, marker: `HTTP ${input.status}` };
  }

  return null;
}

/**
 * The agent-facing sentence. Says the page was NOT read, names the vendor when
 * one is known, and points at a next step.
 *
 * `escalationTool` is the name of a tool the CALLER has registered in this
 * process — pass it and the hint names it, omit it and the hint says what to do
 * without one. A blocked page with no next step is the worse outcome, so the
 * no-tool wording still tells the agent what to do (report it, ask the user).
 */
export function describeBlock(url: string, signal: BlockSignal, escalationTool?: string): string {
  const who = signal.vendor ? `${signal.vendor} bot protection` : 'a bot wall';
  const status = signal.status !== undefined ? ` (HTTP ${signal.status})` : '';
  const next = escalationTool
    ? `Escalate with ${escalationTool} to hand the live browser to the user so they can clear the interstitial, then navigate again.`
    : 'No automated bypass is available in this deployment — tell the user which page is walled and ask them to fetch it or clear the interstitial themselves.';
  return (
    `Blocked by ${who}${status} at ${url} — matched ${signal.marker}. ` +
    'The page content was not read and no retry was attempted. ' +
    next
  );
}
