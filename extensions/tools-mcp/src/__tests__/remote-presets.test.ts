import { describe, expect, it } from 'vitest';
import { getRemotePreset, MCP_REMOTE_PRESETS } from '../remote-presets';

// Shape invariants, not assertions about today's slate — these must keep
// holding as catalog entries are added. The one entry-specific test is
// `linear`, which is the pattern every OAuth entry copies.

describe('MCP_REMOTE_PRESETS', () => {
  it('every entry keys itself by its own name', () => {
    for (const [key, preset] of Object.entries(MCP_REMOTE_PRESETS)) {
      expect(preset.name).toBe(key);
    }
  });

  it('every entry carries non-empty label, description, and category', () => {
    for (const preset of Object.values(MCP_REMOTE_PRESETS)) {
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
      expect(preset.category.length).toBeGreaterThan(0);
    }
  });

  it('every url is a valid https URL', () => {
    for (const preset of Object.values(MCP_REMOTE_PRESETS)) {
      const url = new URL(preset.url);
      expect(url.protocol).toBe('https:');
    }
  });

  it('every entry is streamable-http', () => {
    for (const preset of Object.values(MCP_REMOTE_PRESETS)) {
      expect(preset.transport).toBe('streamable-http');
    }
  });

  it('every authType is one of the three the backend accepts', () => {
    for (const preset of Object.values(MCP_REMOTE_PRESETS)) {
      expect(['oauth', 'none', 'bearer']).toContain(preset.authType);
    }
  });

  it('every docsUrl, when present, is a valid URL', () => {
    for (const preset of Object.values(MCP_REMOTE_PRESETS)) {
      const docsUrl = preset.docsUrl;
      if (docsUrl === undefined) continue;
      expect(() => new URL(docsUrl)).not.toThrow();
    }
  });

  it('includes linear as an OAuth entry', () => {
    const linear = MCP_REMOTE_PRESETS.linear;
    expect(linear).toBeDefined();
    expect(linear?.authType).toBe('oauth');
  });
});

describe('MCP_REMOTE_PRESETS v1 slate', () => {
  it('contains exactly the ten v1 entries', () => {
    expect(Object.keys(MCP_REMOTE_PRESETS).sort()).toEqual(
      [
        'asana',
        'aws-knowledge',
        'context7',
        'deepwiki',
        'linear',
        'microsoft-learn',
        'notion',
        'sentry',
        'vercel',
        'wolfram',
      ].sort(),
    );
  });

  it('does not include github', () => {
    // github.com/login/oauth publishes no `registration_endpoint` in its RFC 8414
    // or OpenID metadata, so Ethos's DCR-based install (`registerOAuthClient` in
    // ../oauth) throws `DcrUnsupported`. A one-click catalog install can only
    // fail; GitHub needs a pre-registered App via the `ethos mcp add --url` path.
    expect(MCP_REMOTE_PRESETS.github).toBeUndefined();
    expect(getRemotePreset('github')).toBeUndefined();
  });

  it('does not include supabase', () => {
    // Its authorization server advertises only client_secret_basic /
    // client_secret_post — confidential clients, which Ethos rejects with
    // `ConfidentialClientUnsupported`.
    expect(MCP_REMOTE_PRESETS.supabase).toBeUndefined();
  });

  it('uses only the three allowed categories', () => {
    for (const preset of Object.values(MCP_REMOTE_PRESETS)) {
      expect(['Docs & knowledge', 'Developer tools', 'Productivity']).toContain(preset.category);
    }
  });

  it('assigns each entry to its intended category', () => {
    const byCategory: Record<string, string[]> = {};
    for (const preset of Object.values(MCP_REMOTE_PRESETS)) {
      const bucket = byCategory[preset.category] ?? [];
      bucket.push(preset.name);
      byCategory[preset.category] = bucket;
    }
    expect(byCategory['Docs & knowledge']?.sort()).toEqual([
      'aws-knowledge',
      'context7',
      'deepwiki',
      'microsoft-learn',
      'wolfram',
    ]);
    expect(byCategory['Developer tools']?.sort()).toEqual(['sentry', 'vercel']);
    expect(byCategory.Productivity?.sort()).toEqual(['asana', 'linear', 'notion']);
  });

  it('pins the no-auth entries to their verified urls', () => {
    // These four are the ones most likely to be silently "corrected" to a
    // wrong-but-plausible value, so each is pinned with the reason.
    expect(MCP_REMOTE_PRESETS.deepwiki?.url).toBe('https://mcp.deepwiki.com/mcp');
    expect(MCP_REMOTE_PRESETS.context7?.url).toBe('https://mcp.context7.com/mcp');
    // Bare origin: there is NO `/mcp` path on knowledge-mcp.global.api.aws.
    expect(MCP_REMOTE_PRESETS['aws-knowledge']?.url).toBe('https://knowledge-mcp.global.api.aws');
    expect(MCP_REMOTE_PRESETS['microsoft-learn']?.url).toBe('https://learn.microsoft.com/api/mcp');
    // Host must be agenttools.wolfram.com. The commonly-cited
    // services.wolfram.com/api/mcp 401s and needs a Wolfram account token.
    expect(MCP_REMOTE_PRESETS.wolfram?.url).toBe('https://agenttools.wolfram.com/mcp');
  });

  it('marks every no-auth entry authType none', () => {
    for (const name of ['deepwiki', 'context7', 'aws-knowledge', 'microsoft-learn', 'wolfram']) {
      // context7 in particular sends `WWW-Authenticate: Bearer ...` on a 200 —
      // advisory, not a challenge. It is genuinely anonymous today.
      expect(MCP_REMOTE_PRESETS[name]?.authType).toBe('none');
    }
  });

  it('pins the OAuth entries to their verified urls', () => {
    expect(MCP_REMOTE_PRESETS.sentry?.url).toBe('https://mcp.sentry.dev/mcp');
    expect(MCP_REMOTE_PRESETS.notion?.url).toBe('https://mcp.notion.com/mcp');
    // Bare origin: no `/mcp` path on mcp.vercel.com.
    expect(MCP_REMOTE_PRESETS.vercel?.url).toBe('https://mcp.vercel.com');
    // `/mcp`, not the `/sse` path most Asana docs show — `/mcp` is a real route
    // and speaks streamable-http, which is what this preset type models.
    expect(MCP_REMOTE_PRESETS.asana?.url).toBe('https://mcp.asana.com/mcp');
  });

  it('marks every OAuth entry authType oauth', () => {
    for (const name of ['linear', 'sentry', 'notion', 'vercel', 'asana']) {
      expect(MCP_REMOTE_PRESETS[name]?.authType).toBe('oauth');
    }
  });
});

describe('getRemotePreset', () => {
  it('returns the preset for a known name', () => {
    const preset = getRemotePreset('linear');
    expect(preset).toBeDefined();
    expect(preset?.name).toBe('linear');
    expect(preset?.url).toBe('https://mcp.linear.app/mcp');
  });

  it('returns undefined for an unknown name', () => {
    expect(getRemotePreset('does-not-exist')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(getRemotePreset('')).toBeUndefined();
  });
});
