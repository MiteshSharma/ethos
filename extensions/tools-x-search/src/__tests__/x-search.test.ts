import { describe, expect, it } from 'vitest';
import { createXSearchTool, xSearchTool } from '../index';

// ---------------------------------------------------------------------------
// Fixtures — mirrors extensions/tools-web/src/__tests__/tools-web.test.ts's
// mockSecrets/mockFetch/ctx conventions (plain-object ScopedSecretsResolver +
// ScopedFetch stubs, never a real network call).
// ---------------------------------------------------------------------------

const mockSecrets = {
  get: async (_ref: string) => 'test-api-key',
};

type ScopedFetchLike = {
  fetch: (url: string | URL, init?: RequestInit) => Promise<Response>;
};

const mockFetch: ScopedFetchLike = {
  fetch: async (_url, _init) => new Response('OK', { status: 200 }),
};

const ctx = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
  secretsResolver: mockSecrets,
  scopedFetch: mockFetch,
};

const ctxWithoutCapabilities = {
  sessionId: 'test',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

function makeRecordingFetch(responseBody: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetch = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    calls.push({ url: typeof url === 'string' ? url : url.toString(), init });
    return new Response(JSON.stringify(responseBody), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { scopedFetch: { fetch }, calls };
}

function ctxWith(scopedFetch: ScopedFetchLike, secrets = mockSecrets) {
  return { ...ctx, scopedFetch, secretsResolver: secrets };
}

// ---------------------------------------------------------------------------

describe('x_search — availability', () => {
  it('isAvailable always returns true, regardless of key presence', () => {
    expect(xSearchTool.isAvailable?.()).toBe(true);
  });

  it('returns not_available when capability backends are missing', async () => {
    const result = await xSearchTool.execute({ query: 'test' }, ctxWithoutCapabilities);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('not_available');
  });
});

describe('x_search — input validation', () => {
  it('returns input_invalid if query is missing', async () => {
    const result = await xSearchTool.execute({}, ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
  });

  it('rejects allowed_x_handles + excluded_x_handles both set, before any network call', async () => {
    const rec = makeRecordingFetch({});
    const result = await xSearchTool.execute(
      { query: 'q', allowed_x_handles: ['a'], excluded_x_handles: ['b'] },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
    expect(rec.calls).toHaveLength(0);
  });

  it('rejects allowed_x_handles over 20 entries, before any network call', async () => {
    const rec = makeRecordingFetch({});
    const result = await xSearchTool.execute(
      { query: 'q', allowed_x_handles: Array.from({ length: 21 }, (_, i) => `h${i}`) },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('input_invalid');
    expect(rec.calls).toHaveLength(0);
  });
});

describe('x_search — no key configured', () => {
  it('produces a clear error, not a raw fetch failure', async () => {
    const rec = makeRecordingFetch({});
    const noKeySecrets = { get: async (_ref: string) => '' };
    const result = await xSearchTool.execute(
      { query: 'q' },
      ctxWith(rec.scopedFetch, noKeySecrets),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toMatch(/xAI key/i);
    }
    expect(rec.calls).toHaveLength(0);
  });
});

describe('x_search — named-secret binding', () => {
  function makeRecordingSecrets(value = 'bound-key') {
    const refs: string[] = [];
    return {
      refs,
      get: async (ref: string) => {
        refs.push(ref);
        return value;
      },
    };
  }
  const withPersonality = (
    scopedFetch: ScopedFetchLike,
    secrets: typeof mockSecrets,
    pid: string,
  ) =>
    ({ ...ctxWith(scopedFetch, secrets), personalityId: pid }) as typeof ctx & {
      personalityId: string;
    };

  it('a bound secret NAME resolves providers/xai/<name>, never a value', async () => {
    const rec = makeRecordingFetch({ output: [], citations: [] });
    const secrets = makeRecordingSecrets('super-secret');
    const tool = createXSearchTool({
      resolvePersonalitySetting: (pid) => (pid === 'scout' ? { secret: 'xai-main' } : undefined),
    });
    const result = await tool.execute(
      { query: 'q' },
      withPersonality(rec.scopedFetch, secrets, 'scout'),
    );
    expect(result.ok).toBe(true);
    expect(secrets.refs).toEqual(['providers/xai/xai-main']);
    expect(new Headers(rec.calls[0]?.init?.headers).get('Authorization')).toBe(
      'Bearer super-secret',
    );
  });

  it('personality tools.yaml wins over global toolSettings[pid] and _default', async () => {
    const rec = makeRecordingFetch({ output: [], citations: [] });
    const secrets = makeRecordingSecrets();
    const tool = createXSearchTool({
      resolvePersonalitySetting: () => ({ secret: 'from-file' }),
      toolSettings: {
        scout: { x_search: { secret: 'from-slot' } },
        _default: { x_search: { secret: 'from-default' } },
      },
    });
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    expect(secrets.refs).toEqual(['providers/xai/from-file']);
  });

  it('falls through to toolSettings[pid], then _default', async () => {
    const rec = makeRecordingFetch({ output: [], citations: [] });
    const secrets = makeRecordingSecrets();
    const tool = createXSearchTool({
      resolvePersonalitySetting: () => undefined,
      toolSettings: {
        scout: { x_search: { secret: 'from-slot' } },
        _default: { x_search: { secret: 'from-default' } },
      },
    });
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'scout'));
    await tool.execute({ query: 'q' }, withPersonality(rec.scopedFetch, secrets, 'other'));
    expect(secrets.refs).toEqual(['providers/xai/from-slot', 'providers/xai/from-default']);
  });

  it('no binding anywhere → the default providers/xai/apiKey', async () => {
    const rec = makeRecordingFetch({ output: [], citations: [] });
    const secrets = makeRecordingSecrets();
    await createXSearchTool().execute({ query: 'q' }, ctxWith(rec.scopedFetch, secrets));
    expect(secrets.refs).toEqual(['providers/xai/apiKey']);
  });

  it('a bound name that resolves to nothing names the exact dialog to fix it', async () => {
    const rec = makeRecordingFetch({});
    const tool = createXSearchTool({ resolvePersonalitySetting: () => ({ secret: 'missing' }) });
    const result = await tool.execute(
      { query: 'q' },
      withPersonality(rec.scopedFetch, { get: async () => '' }, 'scout'),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('not_available');
      expect(result.error).toContain('Settings → Security → Named Secrets (provider xAI)');
      expect(result.error).toContain('XAI_API_KEY');
    }
    expect(rec.calls).toHaveLength(0);
  });
});

describe('x_search — API call shape', () => {
  it('POSTs to the Responses API with model, input, and the x_search tool entry', async () => {
    const rec = makeRecordingFetch({
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A' }] },
      ],
      citations: ['https://x.com/i/status/1'],
    });
    const result = await xSearchTool.execute(
      {
        query: 'cats',
        from_date: '2026-01-01',
        to_date: '2026-01-31',
        enable_image_understanding: true,
      },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    expect(rec.calls[0]?.url).toBe('https://api.x.ai/v1/responses');
    expect(rec.calls[0]?.init?.method).toBe('POST');
    expect(new Headers(rec.calls[0]?.init?.headers).get('Authorization')).toBe(
      'Bearer test-api-key',
    );
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect(body.model).toBe('grok-4.6');
    expect(body.input).toEqual([{ role: 'user', content: 'cats' }]);
    expect(body.tools).toEqual([
      {
        type: 'x_search',
        from_date: '2026-01-01',
        to_date: '2026-01-31',
        enable_image_understanding: true,
      },
    ]);
  });

  it('a non-ok xAI response produces a clear error including status and body', async () => {
    const rec = makeRecordingFetch({ error: 'bad request' }, 400);
    const result = await xSearchTool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('execution_failed');
      expect(result.error).toContain('400');
      expect(result.error).toContain('bad request');
    }
  });
});

describe('x_search — response parsing', () => {
  it('parses a successful response: output_text answer + string-array citations', async () => {
    const rec = makeRecordingFetch({
      output: [
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'Here is what people are saying.' }],
        },
      ],
      citations: ['https://x.com/i/status/1', 'https://x.ai/news'],
    });
    const result = await xSearchTool.execute({ query: 'xAI' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('Here is what people are saying.');
      expect(result.value).toContain('https://x.com/i/status/1');
      expect(result.value).toContain('https://x.ai/news');
    }
  });

  it('also accepts object-shaped citations ({ url, title }) defensively', async () => {
    const rec = makeRecordingFetch({
      output: [],
      citations: [{ url: 'https://x.com/i/status/2', title: 'A post' }],
    });
    const result = await xSearchTool.execute({ query: 'xAI' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('A post');
      expect(result.value).toContain('https://x.com/i/status/2');
    }
  });

  it('caps formatted citations at num_results', async () => {
    const rec = makeRecordingFetch({
      output: [],
      citations: Array.from({ length: 10 }, (_, i) => `https://x.com/i/status/${i}`),
    });
    const result = await xSearchTool.execute(
      { query: 'xAI', num_results: 3 },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.match(/https:\/\/x\.com/g)?.length).toBe(3);
    }
  });

  it('caps num_results at the 25 max even if a larger value is requested', async () => {
    const rec = makeRecordingFetch({
      output: [],
      citations: Array.from({ length: 30 }, (_, i) => `https://x.com/i/status/${i}`),
    });
    const result = await xSearchTool.execute(
      { query: 'xAI', num_results: 1000 },
      ctxWith(rec.scopedFetch),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.match(/https:\/\/x\.com/g)?.length).toBe(25);
    }
  });

  it('returns a "no results" message when both output and citations are empty', async () => {
    const rec = makeRecordingFetch({ output: [], citations: [] });
    const result = await xSearchTool.execute({ query: 'xAI' }, ctxWith(rec.scopedFetch));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe('No results found for: xAI');
  });
});

describe('x_search — model override', () => {
  it('createXSearchTool({ model }) overrides the default model in the request body', async () => {
    const rec = makeRecordingFetch({ output: [], citations: [] });
    const tool = createXSearchTool({ model: 'grok-custom' });
    await tool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
    const body = JSON.parse(String(rec.calls[0]?.init?.body));
    expect(body.model).toBe('grok-custom');
  });

  it('XAI_X_SEARCH_MODEL env var overrides the default when no opts.model is given', async () => {
    const saved = process.env.XAI_X_SEARCH_MODEL;
    process.env.XAI_X_SEARCH_MODEL = 'grok-env-override';
    try {
      const rec = makeRecordingFetch({ output: [], citations: [] });
      const tool = createXSearchTool();
      await tool.execute({ query: 'q' }, ctxWith(rec.scopedFetch));
      const body = JSON.parse(String(rec.calls[0]?.init?.body));
      expect(body.model).toBe('grok-env-override');
    } finally {
      if (saved === undefined) delete process.env.XAI_X_SEARCH_MODEL;
      else process.env.XAI_X_SEARCH_MODEL = saved;
    }
  });
});

describe('x_search — capability declarations', () => {
  it('declares capabilities.network.allowedHosts = [api.x.ai]', () => {
    expect(xSearchTool.capabilities.network?.allowedHosts).toEqual(['api.x.ai']);
  });

  it('declares a prefix grant over providers/xai/* so any bound name stays inside it', () => {
    expect(xSearchTool.capabilities.secrets).toEqual(['providers/xai/*']);
  });

  it('declares toolset "web"', () => {
    expect(xSearchTool.toolset).toBe('web');
  });

  it('marks output as untrusted', () => {
    expect(xSearchTool.outputIsUntrusted).toBe(true);
  });
});

describe('x_search settingsSchema', () => {
  it('declares exactly one secret-binding field with secretKind "x-search"', () => {
    const schema = xSearchTool.settingsSchema;
    if (!schema) throw new Error('expected x_search to declare a settingsSchema');
    expect(schema.fields).toHaveLength(1);
    const field = schema.fields[0];
    if (field?.kind !== 'secret-binding') throw new Error('expected a secret-binding field');
    // Keyed `secret` like web_search's binding — the tool-settings wire shape
    // (`values.x_search.secret`) and tools.yaml both read that key.
    expect(field.key).toBe('secret');
    expect(field.secretKind).toBe('x-search');
  });
});
