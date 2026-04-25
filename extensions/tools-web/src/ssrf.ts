import { lookup } from 'node:dns/promises';

// ---------------------------------------------------------------------------
// IP validation helpers
// ---------------------------------------------------------------------------

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isValidIpv4(s: string): boolean {
  const m = s.match(IPV4_RE);
  if (!m) return false;
  return m.slice(1).every((octet) => Number(octet) <= 255);
}

function isValidIpv6(s: string): boolean {
  // Minimal heuristic: contains at least two colons or is '::1'
  return s.includes(':');
}

function isIpLiteral(s: string): boolean {
  return isValidIpv4(s) || isValidIpv6(s);
}

// ---------------------------------------------------------------------------
// Private IP range detection
// ---------------------------------------------------------------------------

function ip4ToInt(ip: string): number {
  return (
    ip
      .split('.')
      .reduce((acc: number, octet: string) => (acc << 8) | Number.parseInt(octet, 10), 0) >>> 0
  );
}

const PRIVATE_RANGES_V4: Array<{ start: number; end: number; label: string }> = [
  { start: ip4ToInt('0.0.0.0'), end: ip4ToInt('0.255.255.255'), label: 'unspecified' },
  { start: ip4ToInt('10.0.0.0'), end: ip4ToInt('10.255.255.255'), label: 'RFC1918' },
  { start: ip4ToInt('100.64.0.0'), end: ip4ToInt('100.127.255.255'), label: 'shared-address' },
  { start: ip4ToInt('127.0.0.0'), end: ip4ToInt('127.255.255.255'), label: 'loopback' },
  {
    start: ip4ToInt('169.254.0.0'),
    end: ip4ToInt('169.254.255.255'),
    label: 'link-local/metadata',
  },
  { start: ip4ToInt('172.16.0.0'), end: ip4ToInt('172.31.255.255'), label: 'RFC1918' },
  { start: ip4ToInt('192.0.0.0'), end: ip4ToInt('192.0.0.255'), label: 'IETF-protocol' },
  { start: ip4ToInt('192.168.0.0'), end: ip4ToInt('192.168.255.255'), label: 'RFC1918' },
  { start: ip4ToInt('198.18.0.0'), end: ip4ToInt('198.19.255.255'), label: 'benchmarking' },
  { start: ip4ToInt('240.0.0.0'), end: ip4ToInt('255.255.255.255'), label: 'reserved' },
];

function isPrivateIpv4(ip: string): boolean {
  const n = ip4ToInt(ip);
  return PRIVATE_RANGES_V4.some(({ start, end }) => n >= start && n <= end);
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();

  // IPv4-mapped IPv6 in normalized hex form: ::ffff:c0a8:101 = ::ffff:192.168.1.1
  // The WHATWG URL parser normalizes ::ffff:192.168.1.1 → ::ffff:c0a8:101
  const hexMapped = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexMapped) {
    const high = Number.parseInt(hexMapped[1], 16);
    const low = Number.parseInt(hexMapped[2], 16);
    const a = (high >> 8) & 0xff;
    const b = high & 0xff;
    const c = (low >> 8) & 0xff;
    const d = low & 0xff;
    return isPrivateIpv4(`${a}.${b}.${c}.${d}`);
  }

  return (
    lower === '::1' || // loopback
    lower.startsWith('fe80:') || // link-local
    lower.startsWith('fc') || // unique local
    lower.startsWith('fd') // unique local
  );
}

/**
 * Returns true only if `ip` is a valid IP literal AND falls in a private range.
 * Plain hostnames are not IP literals and always return false here.
 */
function isPrivateIpLiteral(ip: string): boolean {
  // IPv4-mapped IPv6 e.g. ::ffff:192.168.1.1
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped && isValidIpv4(mapped[1])) return isPrivateIpv4(mapped[1]);

  if (isValidIpv4(ip)) return isPrivateIpv4(ip);
  if (isValidIpv6(ip)) return isPrivateIpv6(ip);
  return false;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set(['localhost', '0.0.0.0', 'metadata.google.internal']);

export type SsrfCheckResult = { blocked: false } | { blocked: true; reason: string };

export async function checkSsrf(url: string): Promise<SsrfCheckResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: false };
  }

  // Strip IPv6 brackets so [::1] → ::1
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Blocked hostnames (checked before IP literal to handle '0.0.0.0' here)
  if (BLOCKED_HOSTNAMES.has(hostname)) {
    return { blocked: true, reason: `SSRF blocked: '${hostname}' is a blocked hostname` };
  }

  // IP literals (only for valid IPv4/IPv6 strings)
  if (isIpLiteral(hostname) && isPrivateIpLiteral(hostname)) {
    return { blocked: true, reason: `SSRF blocked: '${hostname}' is a private IP address` };
  }

  // For hostnames: resolve via DNS and check each address
  if (!isIpLiteral(hostname)) {
    try {
      const records = await lookup(hostname, { all: true });
      for (const { address } of records) {
        if (isPrivateIpLiteral(address)) {
          return {
            blocked: true,
            reason: `SSRF blocked: '${parsed.host}' resolves to private IP ${address}`,
          };
        }
      }
    } catch {
      // DNS lookup failed — allow the request to fail naturally
    }
  }

  return { blocked: false };
}
