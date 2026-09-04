// `personalityNetworkPolicy` used to be `activePerson.safety?.network ?? {}` —
// ONE snapshot of ONE personality, captured at wiring time and applied to every
// personality in the process. A user who set `safety.network.allow: ['*']` on a
// non-default personality got nothing: their policy was never read, and every
// tool declaring `allowedHosts: ['*']` (web_extract, the browser tools, the
// delegation tools) resolved to an empty host set and answered
// HOST_NOT_ALLOWED on every URL. Editing the config did not help either — the
// snapshot outlived the edit. These tests pin the resolver behaviour that
// replaced it, mirroring personality-fs-reach.test.ts.

import { resolveCapabilities, ScopedFetchImpl } from '@ethosagent/core';
import { createPersonalityRegistry } from '@ethosagent/personalities';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import type { Logger, ToolCapabilities } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { createPersonalityNetworkPolicyResolver } from '../build-infrastructure';

const warnings: string[] = [];
const logStub: Logger = {
  debug: () => {},
  info: () => {},
  warn: (msg: string) => warnings.push(msg),
  error: () => {},
  child: () => logStub,
};

const response = new Response('ok');
const safeFetch = async (url: string) => ({
  ok: true as const,
  response,
  finalUrl: url,
  hops: 0,
});

// `engineer` is the deployment default and declares no safety block — the
// shape that made every other personality's policy invisible.
const makeRegistry = async () => {
  const registry = await createPersonalityRegistry(new InMemoryStorage());
  registry.define({ id: 'engineer', name: 'Engineer' });
  registry.define({
    id: 'briefer',
    name: 'Briefer',
    safety: { network: { allow: ['*'] } },
  });
  registry.define({
    id: 'narrow',
    name: 'Narrow',
    safety: { network: { allow: ['api.open-meteo.com'] } },
  });
  registry.setDefault('engineer');
  return registry;
};

describe('createPersonalityNetworkPolicyResolver', () => {
  it('resolves each personality own policy, not the default one', async () => {
    const resolve = createPersonalityNetworkPolicyResolver(await makeRegistry(), logStub);

    expect(resolve('briefer')).toEqual({ allow: ['*'] });
    expect(resolve('narrow')).toEqual({ allow: ['api.open-meteo.com'] });
    expect(resolve('engineer')).toEqual({});
    // An absent id keeps today's behaviour: the default personality.
    expect(resolve()).toEqual({});
  });

  it('reflects a safety.network edit without reconstructing anything', async () => {
    const registry = await makeRegistry();
    const resolve = createPersonalityNetworkPolicyResolver(registry, logStub);

    expect(resolve('narrow')).toEqual({ allow: ['api.open-meteo.com'] });

    // The edit a user makes to ~/.ethos/personalities/narrow/config.yaml, as
    // the refreshed registry sees it.
    registry.define({
      id: 'narrow',
      name: 'Narrow',
      safety: { network: { allow: ['api.open-meteo.com', 'docs.ethosagent.ai'] } },
    });

    expect(
      resolve('narrow'),
      'the network policy must hot-reload: the same resolver, called again with nothing rebuilt, still returned the process-start policy',
    ).toEqual({ allow: ['api.open-meteo.com', 'docs.ethosagent.ai'] });
  });

  it('degrades an unknown id to the empty policy with a warning', async () => {
    warnings.length = 0;
    const resolve = createPersonalityNetworkPolicyResolver(await makeRegistry(), logStub);

    expect(resolve('ghost')).toEqual({});
    expect(warnings).toHaveLength(1);
  });
});

describe('personality network policy at the tool boundary', () => {
  const makeBackends = async () => ({
    personalityNetworkPolicy: createPersonalityNetworkPolicyResolver(await makeRegistry(), logStub),
    safeFetch,
  });

  // web_extract, the browser tools and the delegation tools all declare this.
  const wildcardTool: ToolCapabilities = { network: { allowedHosts: ['*'] } };

  it('gives the turn the policy of the personality running it', async () => {
    const backends = await makeBackends();

    const forBriefer = resolveCapabilities(
      'web_extract',
      wildcardTool,
      { sessionId: 's', personalityId: 'briefer' },
      backends,
    );
    const forEngineer = resolveCapabilities(
      'web_extract',
      wildcardTool,
      { sessionId: 's', personalityId: 'engineer' },
      backends,
    );

    expect(forBriefer.scopedFetch).toBeInstanceOf(ScopedFetchImpl);
    await expect(
      forBriefer.scopedFetch?.fetch('https://example.com/article'),
      "briefer declares allow: ['*'] — its own policy must reach the resolver even though the default personality declares none",
    ).resolves.toBe(response);

    // The other half of the same rule: the default's (absent) policy still
    // applies to the default's own turns.
    await expect(forEngineer.scopedFetch?.fetch('https://example.com/article')).rejects.toThrow(
      /HOST_NOT_ALLOWED/,
    );
  });

  it('holds a narrow personality to its own list through a wildcard tool', async () => {
    const backends = await makeBackends();
    const resolved = resolveCapabilities(
      'web_extract',
      wildcardTool,
      { sessionId: 's', personalityId: 'narrow' },
      backends,
    );

    await expect(
      resolved.scopedFetch?.fetch('https://api.open-meteo.com/v1/forecast'),
    ).resolves.toBe(response);
    await expect(resolved.scopedFetch?.fetch('https://example.com/article')).rejects.toThrow(
      /HOST_NOT_ALLOWED/,
    );
  });

  it('narrows a tool with declared hosts, never widens it', async () => {
    const backends = await makeBackends();
    // web_search's shape: the tool names its own hosts.
    const declared: ToolCapabilities = {
      network: { allowedHosts: ['api.open-meteo.com', 'api.exa.ai'] },
    };

    const forNarrow = resolveCapabilities(
      'web_search',
      declared,
      { sessionId: 's', personalityId: 'narrow' },
      backends,
    );
    // Intersection: the personality allows only one of the two declared hosts.
    await expect(
      forNarrow.scopedFetch?.fetch('https://api.open-meteo.com/v1/forecast'),
    ).resolves.toBe(response);
    await expect(forNarrow.scopedFetch?.fetch('https://api.exa.ai/search')).rejects.toThrow(
      /HOST_NOT_ALLOWED/,
    );

    // And the reverse direction: `allow: ['*']` cannot widen a tool past the
    // hosts it declared for itself.
    const forBriefer = resolveCapabilities(
      'web_search',
      declared,
      { sessionId: 's', personalityId: 'briefer' },
      backends,
    );
    await expect(forBriefer.scopedFetch?.fetch('https://api.exa.ai/search')).resolves.toBe(
      response,
    );
    await expect(forBriefer.scopedFetch?.fetch('https://example.com/article')).rejects.toThrow(
      /HOST_NOT_ALLOWED/,
    );
  });
});
