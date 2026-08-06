// Post-review FIX 9 — golden request-body baselines for the two hosted
// variants the plan names but Lane 2 had not yet captured:
//
//   (a) the Gemini alias — interesting because `normalizeGeminiSchema`
//       rewrites tool parameter schemas and interacts with the deterministic
//       tool sort, and
//   (b) an Azure config — inherits the sort via the shared openai-compat
//       transport, with a distinct URL (deployment path + api-version query)
//       that no other baseline captures.
//
// Baselines are POST-fix bytes (captured on this branch, after the FIX 1–8
// changes). Regenerate deliberately with UPDATE_GOLDEN=1 — never by hand.

import { join } from 'node:path';
import type { Tool, ToolResult } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import {
  assertGoldenRequests,
  captureRequestBodies,
  toolNamesInBody,
} from './helpers/golden-request-harness';

const FIXTURES = join(import.meta.dirname, 'golden');

/** Tools whose schemas exercise `normalizeGeminiSchema` (fields Gemini
 *  rejects: format/minLength/additionalProperties, array `type`). */
function makeRichTool(name: string): Tool {
  return {
    name,
    description: `${name} tool`,
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', format: 'uri', minLength: 1 },
        note: { type: ['string', 'null'] },
      },
    },
    capabilities: {},
    async execute(): Promise<ToolResult> {
      return { ok: true, value: `${name} ran` };
    },
  };
}

// Deliberately non-alphabetical registration so the baseline proves the sort.
const TOOLS = () => [makeRichTool('write_file'), makeRichTool('bash'), makeRichTool('read_file')];

describe('FIX 9 — golden request bodies for uncaptured hosted variants', () => {
  it('gemini alias — normalizeGeminiSchema + the stable tool sort produce the baseline bytes', async () => {
    const captured = await captureRequestBodies({
      provider: 'openai-compat',
      openaiCompat: {
        name: 'gemini',
        model: 'gemini-2.0-flash',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
      },
      tools: TOOLS(),
      turns: [{ text: 'hello' }],
    });
    expect(captured).toHaveLength(1);
    expect(toolNamesInBody(captured[0] ?? { url: '', body: '{}' })).toEqual([
      'bash',
      'read_file',
      'write_file',
    ]);
    // Gemini normalization stripped the rejected schema fields on the wire.
    const body = captured[0]?.body ?? '';
    expect(body).not.toContain('minLength');
    expect(body).not.toContain('additionalProperties');
    assertGoldenRequests(captured, join(FIXTURES, 'gemini-default.json'));
  });

  it('azure — the deployment URL/api-version path with the stable tool sort produces the baseline bytes', async () => {
    const captured = await captureRequestBodies({
      provider: 'openai-compat',
      openaiCompat: {
        name: 'azure',
        model: 'gpt-4o',
        baseUrl: 'https://myresource.openai.azure.com',
      },
      tools: TOOLS(),
      turns: [{ text: 'hello' }],
    });
    expect(captured).toHaveLength(1);
    expect(toolNamesInBody(captured[0] ?? { url: '', body: '{}' })).toEqual([
      'bash',
      'read_file',
      'write_file',
    ]);
    // The Azure deployment path and api-version query are part of the capture.
    expect(captured[0]?.url).toContain('/openai/deployments/gpt-4o/');
    expect(captured[0]?.url).toContain('api-version=');
    assertGoldenRequests(captured, join(FIXTURES, 'azure-default.json'));
  });
});
