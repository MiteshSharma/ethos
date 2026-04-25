import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkSsrf } from '../ssrf';

// Module-level mock — hoisted by Vitest so ssrf.ts gets the mock on import
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(),
}));

import * as dnsPromises from 'node:dns/promises';

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// IP literal URLs — no DNS lookup needed
// ---------------------------------------------------------------------------

describe('checkSsrf — IP literal addresses', () => {
  it.each([
    ['loopback', 'http://127.0.0.1/'],
    ['loopback high', 'http://127.255.0.1/'],
    ['link-local / AWS metadata', 'http://169.254.169.254/latest/meta-data'],
    ['RFC1918 10.x', 'http://10.0.0.1/'],
    ['RFC1918 172.16.x', 'http://172.16.0.1/'],
    ['RFC1918 172.31.x', 'http://172.31.255.255/'],
    ['RFC1918 192.168.x', 'http://192.168.1.1/'],
    ['unspecified 0.0.0.0', 'http://0.0.0.0/'],
    ['IPv6 loopback', 'http://[::1]/'],
    ['IPv6 link-local', 'http://[fe80::1]/'],
    ['IPv6 unique local fc', 'http://[fc00::1]/'],
    ['IPv6 unique local fd', 'http://[fd12:3456:789a::1]/'],
    // WHATWG URL parser normalizes ::ffff:192.168.1.1 → ::ffff:c0a8:101 (hex)
    ['IPv4-mapped IPv6 (normalized hex)', 'http://[::ffff:c0a8:101]/'],
  ])('blocks %s (%s)', async (_label, url) => {
    const result = await checkSsrf(url);
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.reason).toMatch(/SSRF blocked/);
  });

  it.each([
    'http://1.1.1.1/',
    'http://8.8.8.8/',
    'https://93.184.216.34/',
  ])('allows public IP: %s', async (url) => {
    // DNS lookup would be called for a hostname, not an IP literal — skip mock
    vi.mocked(dnsPromises.lookup).mockResolvedValue([] as never);
    const result = await checkSsrf(url);
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Blocked hostnames
// ---------------------------------------------------------------------------

describe('checkSsrf — blocked hostnames', () => {
  it.each([
    'localhost',
    '0.0.0.0',
    'metadata.google.internal',
  ])('blocks hostname: %s', async (host) => {
    const result = await checkSsrf(`http://${host}/`);
    expect(result.blocked).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Hostname DNS resolution (mocked)
// ---------------------------------------------------------------------------

describe('checkSsrf — DNS resolution', () => {
  it('blocks when hostname resolves to private IP', async () => {
    vi.mocked(dnsPromises.lookup).mockResolvedValue([{ address: '10.0.0.1', family: 4 }] as never);
    const result = await checkSsrf('http://internal.example.com/');
    expect(result.blocked).toBe(true);
    if (result.blocked) expect(result.reason).toMatch(/resolves to private IP/);
  });

  it('allows when hostname resolves to public IP', async () => {
    vi.mocked(dnsPromises.lookup).mockResolvedValue([
      { address: '93.184.216.34', family: 4 },
    ] as never);
    const result = await checkSsrf('http://example.com/');
    expect(result.blocked).toBe(false);
  });

  it('allows when DNS lookup throws (fail-open)', async () => {
    vi.mocked(dnsPromises.lookup).mockRejectedValue(new Error('DNS error') as never);
    const result = await checkSsrf('http://nonexistent.example.com/');
    expect(result.blocked).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('checkSsrf — edge cases', () => {
  it('returns unblocked for invalid URL (parse error)', async () => {
    const result = await checkSsrf('not-a-url');
    expect(result.blocked).toBe(false);
  });
});
