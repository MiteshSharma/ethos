// vision_analyze — P3 integration test.
//
// Scope (per the plan): a personality whose toolset includes `vision_analyze`
// runs prompts with a real image fixture *and* a real PDF fixture against a
// (test-mocked) LLMProvider; assert the request block shapes and the usage
// aggregation surfaced on `ToolResult.cost_usd`.
//
// What this exercises end-to-end:
//   - createVisionTools() factory wires correctly with a `resolveProvider`
//     callback (mirroring what wiring/index.ts does in production).
//   - The tool registers under toolset 'vision' and survives
//     DefaultToolRegistry.executeParallel() gating against a personality
//     toolset that explicitly includes `vision_analyze`.
//   - Image fixture → `{ type: 'image', mediaType: 'image/png', data }` block
//     in the provider request; PDF fixture → `{ type: 'document', ... }`.
//   - Aggregate `cost_usd` summed across multiple tool calls in the same
//     session matches the per-call usage chunks the stub provider emits.
//
// What this does NOT do (out of scope, per the plan's wording):
//   - Spin up a full AgentLoop turn cycle. The plan explicitly says request
//     block shapes + usage aggregation, not a full chat session simulation.
//   - Exercise the real auxiliary-provider wiring in packages/wiring — that
//     would pull SQLite / Docker / MCP into a tool-extension test.
//     The wiring path itself is a 30-line lambda over the same factory
//     signature this test stubs.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CapabilityBackends } from '@ethosagent/core';
import { DefaultToolRegistry } from '@ethosagent/core';
import type {
  CompletionChunk,
  CompletionOptions,
  LLMProvider,
  Message,
  Tool,
  ToolContext,
  ToolDefinitionLite,
} from '@ethosagent/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createVisionTools } from '../index';

// ---------------------------------------------------------------------------
// Capability backends — vision_analyze declares fs_reach, so
// resolveCapabilities creates a ScopedFsImpl from this storage.
// The storage reads files as latin1 so binary data (images, PDFs)
// round-trips without loss through the string-returning ScopedFs interface.
// ---------------------------------------------------------------------------

import { existsSync, statSync } from 'node:fs';
import type { Storage } from '@ethosagent/types';

const latin1Storage: Storage = {
  async read(path: string) {
    try {
      return readFileSync(path, 'latin1');
    } catch {
      return null;
    }
  },
  async readBytes(path: string) {
    try {
      return readFileSync(path);
    } catch {
      return null;
    }
  },
  async write() {},
  async exists(path: string) {
    return existsSync(path);
  },
  async list() {
    return [];
  },
  async mtime(path: string) {
    try {
      return statSync(path).mtimeMs;
    } catch {
      return null;
    }
  },
  async listEntries() {
    return [];
  },
  async append() {},
  async writeAtomic() {},
  async mkdir() {},
  async remove() {},
  async rename() {},
  async chmod() {},
};

const testBackends: CapabilityBackends = {
  storage: latin1Storage,
  personalityFsReach: () => ({ read: ['/'], write: ['/'] }),
};

// Minimal valid fixtures — same byte sequences the unit tests use.
const TINY_PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
  'hex',
);
const TINY_PDF = Buffer.from('%PDF-1.4\n%%EOF\n', 'utf8');

// ---------------------------------------------------------------------------
// Stub LLMProvider — records every call, yields canned chunks.
// ---------------------------------------------------------------------------

interface StubCall {
  messages: Message[];
  tools: ToolDefinitionLite[];
  options: CompletionOptions;
}

function makeStubProvider(
  chunks: CompletionChunk[],
  calls: StubCall[],
  model = 'claude-opus-4-7',
): LLMProvider {
  return {
    name: 'stub-anthropic',
    model,
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(
      messages: Message[],
      tools: ToolDefinitionLite[],
      options: CompletionOptions,
    ): AsyncIterable<CompletionChunk> {
      calls.push({ messages, tools, options });
      for (const c of chunks) yield c;
    },
    async countTokens() {
      return 0;
    },
  };
}

function usageChunk(inputTokens: number, outputTokens: number, cost: number): CompletionChunk {
  return {
    type: 'usage',
    usage: {
      inputTokens,
      outputTokens,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      estimatedCostUsd: cost,
    },
  };
}

// ---------------------------------------------------------------------------
// Tool context helper — ScopedFs rooted at a per-test tmp dir.
// ---------------------------------------------------------------------------

function makeCtx(workingDir: string): ToolContext {
  // scopedFs is not set here — resolveCapabilities() in DefaultToolRegistry
  // creates a ScopedFsImpl from testBackends.storage + personalityFsReach
  // when the tool declares capabilities.fs_reach.
  return {
    sessionId: 'sess-int',
    sessionKey: 'cli:int-test',
    platform: 'test',
    workingDir,
    currentTurn: 0,
    messageCount: 0,
    abortSignal: new AbortController().signal,
    emit: () => undefined,
    resultBudgetChars: 80_000,
  };
}

// ---------------------------------------------------------------------------
// Fixtures setup
// ---------------------------------------------------------------------------

let tmpDir = '';
beforeEach(async () => {
  // Canonicalize through realpath — on macOS tmpdir() returns /var/folders/...
  // which is a symlink to /private/var/folders/...; the resolver canonicalizes
  // the request path, so the ScopedStorage allowlist prefix must already be
  // canonical or the boundary check sees a /private/var path against a /var
  // prefix (matches the unit test pattern in input-resolver.test.ts).
  tmpDir = await realpath(mkdtempSync(join(tmpdir(), 'vision-integ-')));
});
afterEach(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Register `vision_analyze` into a DefaultToolRegistry, mirroring the wiring
 * path: same factory, same resolveProvider shape. The single registry then
 * gates by personality toolset just like AgentLoop does at the turn boundary.
 */
function buildRegistryWithVision(opts: {
  primary: LLMProvider;
  defaultModel: string;
  auxProvider?: LLMProvider;
  auxModel?: string;
}): { registry: DefaultToolRegistry; tool: Tool } {
  const registry = new DefaultToolRegistry(testBackends);
  const tools = createVisionTools({
    resolveProvider: (model) => {
      if (model === opts.defaultModel) return opts.primary;
      if (opts.auxProvider && opts.auxModel && model === opts.auxModel) return opts.auxProvider;
      return null;
    },
    defaultModel: opts.defaultModel,
    ...(opts.auxModel ? { auxiliaryVisionModel: opts.auxModel } : {}),
  });
  for (const t of tools) registry.register(t);
  const tool = registry.getAvailable().find((t) => t.name === 'vision_analyze');
  if (!tool) throw new Error('vision_analyze did not register');
  return { registry, tool };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('vision_analyze — P3 wiring integration', () => {
  it('routes through the wiring factory and is gated by the personality toolset', async () => {
    // A personality whose toolset.yaml has only `vision_analyze` listed.
    const personalityToolset = ['vision_analyze'];

    const path = join(tmpDir, 'pic.png');
    writeFileSync(path, TINY_PNG);

    const calls: StubCall[] = [];
    const provider = makeStubProvider(
      [
        { type: 'text_delta', text: 'a single pixel' },
        usageChunk(120, 8, 0.00234),
        { type: 'done', finishReason: 'end_turn' },
      ],
      calls,
    );
    const { registry } = buildRegistryWithVision({
      primary: provider,
      defaultModel: 'claude-opus-4-7',
    });

    const results = await registry.executeParallel(
      [{ toolCallId: 'tc-1', name: 'vision_analyze', args: { file_path: path, prompt: 'what?' } }],
      makeCtx(tmpDir),
      personalityToolset,
    );

    expect(results).toHaveLength(1);
    const r = results[0]?.result;
    if (!r?.ok) throw new Error(`expected ok result, got ${JSON.stringify(r)}`);

    const envelope = JSON.parse(r.value);
    expect(envelope.text).toBe('a single pixel');
    expect(envelope.model).toBe('claude-opus-4-7');
    expect(envelope.cost_usd).toBe(0.00234);
    expect(envelope.input_tokens).toBe(120);
    expect(envelope.output_tokens).toBe(8);

    // The provider received exactly one user message with the image block + the prompt.
    expect(calls).toHaveLength(1);
    const content = calls[0]?.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected content array');
    expect(content).toEqual([
      { type: 'image', mediaType: 'image/png', data: TINY_PNG.toString('base64') },
      { type: 'text', text: 'what?' },
    ]);
    expect(calls[0]?.options.modelOverride).toBe('claude-opus-4-7');
  });

  // Regression: a real JPEG (non-UTF-8 magic bytes) read via file_path through
  // the REAL FsStorage. Previously vision_analyze read attachments via
  // Storage.read() which decodes as UTF-8 — every JPEG/PNG/PDF byte sequence
  // hit the U+FFFD replacement and the tool reported UNSUPPORTED_FILE_TYPE.
  // This test would have failed against the old code path; the latin1Storage
  // mock in other tests papered over the bug.
  it('reads a real JPEG via file_path through FsStorage (binary round-trip)', async () => {
    const { FsStorage } = await import('@ethosagent/storage-fs');
    const personalityToolset = ['vision_analyze'];

    // Minimal valid JFIF JPEG: SOI + APP0(JFIF) + EOI. The 0xFF bytes are
    // not valid UTF-8, so the old utf-8 decode would have replaced them
    // with U+FFFD and the magic-byte sniff would have failed.
    const realJpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x01, 0x00,
      0x60, 0x00, 0x60, 0x00, 0x00, 0xff, 0xd9,
    ]);
    const path = join(tmpDir, 'photo.jpg');
    writeFileSync(path, realJpeg);

    const calls: StubCall[] = [];
    const provider = makeStubProvider(
      [
        { type: 'text_delta', text: 'a tiny JFIF stub' },
        usageChunk(50, 4, 0.0001),
        { type: 'done', finishReason: 'end_turn' },
      ],
      calls,
    );

    // Build a registry rooted on the REAL FsStorage — exercises the path the
    // gateway uses in production. The previous tests in this file use a
    // hand-rolled latin1Storage mock that papered over the encoding bug.
    const registry = new DefaultToolRegistry({
      storage: new FsStorage(),
      personalityFsReach: () => ({ read: ['/'], write: ['/'] }),
    });
    const tools = createVisionTools({
      resolveProvider: (model) => (model === 'claude-opus-4-7' ? provider : null),
      defaultModel: 'claude-opus-4-7',
    });
    for (const t of tools) registry.register(t);

    const results = await registry.executeParallel(
      [
        {
          toolCallId: 'tc-jpg',
          name: 'vision_analyze',
          args: { file_path: path, prompt: 'describe' },
        },
      ],
      makeCtx(tmpDir),
      personalityToolset,
    );

    const r = results[0]?.result;
    if (!r?.ok) throw new Error(`expected ok result, got ${JSON.stringify(r)}`);

    // The provider received the image block with the unmangled JPEG bytes
    // base64-encoded. Any UTF-8 decode in the read path would have replaced
    // 0xFF/0xD8/0xE0/0xD9 with the U+FFFD bytes (EF BF BD) and the base64
    // would not match the original.
    const content = calls[0]?.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected content array');
    expect(content[0]).toEqual({
      type: 'image',
      mediaType: 'image/jpeg',
      data: realJpeg.toString('base64'),
    });
  });

  it('rejects vision_analyze when the personality toolset omits it', async () => {
    // Same wiring, but the personality only allows read_file. The registry
    // returns a not_available error result without ever invoking the provider.
    const path = join(tmpDir, 'pic.png');
    writeFileSync(path, TINY_PNG);

    const calls: StubCall[] = [];
    const provider = makeStubProvider(
      [
        { type: 'text_delta', text: 'should not reach' },
        usageChunk(1, 1, 0.0001),
        { type: 'done', finishReason: 'end_turn' },
      ],
      calls,
    );
    const { registry } = buildRegistryWithVision({
      primary: provider,
      defaultModel: 'claude-opus-4-7',
    });

    const results = await registry.executeParallel(
      [{ toolCallId: 'tc-1', name: 'vision_analyze', args: { file_path: path, prompt: 'x' } }],
      makeCtx(tmpDir),
      ['read_file'],
    );

    const r = results[0]?.result;
    if (!r || r.ok) throw new Error('expected rejection');
    expect(r.code).toBe('not_available');
    expect(r.error).toContain('not permitted');
    expect(calls).toHaveLength(0);
  });

  it('emits a document block for PDF inputs and surfaces PDF usage', async () => {
    const personalityToolset = ['vision_analyze'];
    const path = join(tmpDir, 'doc.pdf');
    writeFileSync(path, TINY_PDF);

    const calls: StubCall[] = [];
    const provider = makeStubProvider(
      [
        { type: 'text_delta', text: 'one page, empty body' },
        usageChunk(540, 12, 0.0089),
        { type: 'done', finishReason: 'end_turn' },
      ],
      calls,
    );
    const { registry } = buildRegistryWithVision({
      primary: provider,
      defaultModel: 'claude-opus-4-7',
    });

    const results = await registry.executeParallel(
      [
        {
          toolCallId: 'tc-pdf',
          name: 'vision_analyze',
          args: { file_path: path, prompt: 'summarize' },
        },
      ],
      makeCtx(tmpDir),
      personalityToolset,
    );

    const r = results[0]?.result;
    if (!r?.ok) throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
    const envelope = JSON.parse(r.value);
    expect(envelope.text).toBe('one page, empty body');
    expect(envelope.cost_usd).toBe(0.0089);
    expect(envelope.input_tokens).toBe(540);
    expect(envelope.output_tokens).toBe(12);

    const content = calls[0]?.messages[0]?.content;
    if (!Array.isArray(content)) throw new Error('expected content array');
    expect(content[0]).toEqual({
      type: 'document',
      mediaType: 'application/pdf',
      data: TINY_PDF.toString('base64'),
    });
    expect(content[1]).toEqual({ type: 'text', text: 'summarize' });
  });

  it('aggregates cost across an image-then-PDF sequence in the same session', async () => {
    // Two sequential tool calls (executeParallel coalesces N calls in one
    // assistant turn). Each provider response carries its own usage chunk;
    // each ToolResult carries its own `cost_usd`. The sum is what `/usage`
    // accumulates upstream — the test asserts the per-call costs are
    // surfaced honestly and add up.
    const personalityToolset = ['vision_analyze'];

    const imgPath = join(tmpDir, 'pic.png');
    writeFileSync(imgPath, TINY_PNG);
    const pdfPath = join(tmpDir, 'doc.pdf');
    writeFileSync(pdfPath, TINY_PDF);

    // One stub provider that branches its response on the media-type block —
    // the request shape (`image` vs `document`) determines which canned
    // usage chunk gets emitted. Same model id for both routes, since model
    // routing isn't what this test is asserting; what matters is that two
    // distinct usage chunks flow through and `ToolResult.cost_usd` carries
    // them honestly. Running the two calls in parallel via executeParallel
    // makes any order-based provider toggling racy, so the routing key
    // here is the content of the request, not its arrival order.
    const imgCalls: StubCall[] = [];
    const pdfCalls: StubCall[] = [];
    const routingProvider: LLMProvider = {
      name: 'stub-routing',
      model: 'claude-opus-4-7',
      maxContextTokens: 200_000,
      supportsCaching: false,
      supportsThinking: false,
      async *complete(
        messages: Message[],
        tools: ToolDefinitionLite[],
        options: CompletionOptions,
      ): AsyncIterable<CompletionChunk> {
        const content = messages[0]?.content;
        const firstBlock = Array.isArray(content) ? content[0] : null;
        const isImage =
          firstBlock !== null &&
          typeof firstBlock === 'object' &&
          'type' in firstBlock &&
          firstBlock.type === 'image';
        if (isImage) {
          imgCalls.push({ messages, tools, options });
          yield { type: 'text_delta', text: 'image answer' };
          yield usageChunk(100, 10, 0.003);
          yield { type: 'done', finishReason: 'end_turn' };
        } else {
          pdfCalls.push({ messages, tools, options });
          yield { type: 'text_delta', text: 'pdf answer' };
          yield usageChunk(400, 20, 0.012);
          yield { type: 'done', finishReason: 'end_turn' };
        }
      },
      async countTokens() {
        return 0;
      },
    };
    const registry = new DefaultToolRegistry(testBackends);
    const tools = createVisionTools({
      resolveProvider: () => routingProvider,
      defaultModel: 'claude-opus-4-7',
    });
    for (const t of tools) registry.register(t);

    const results = await registry.executeParallel(
      [
        {
          toolCallId: 'tc-img',
          name: 'vision_analyze',
          args: { file_path: imgPath, prompt: 'q1' },
        },
        {
          toolCallId: 'tc-pdf',
          name: 'vision_analyze',
          args: { file_path: pdfPath, prompt: 'q2' },
        },
      ],
      makeCtx(tmpDir),
      personalityToolset,
    );

    expect(results).toHaveLength(2);
    const r1 = results.find((r) => r.toolCallId === 'tc-img')?.result;
    const r2 = results.find((r) => r.toolCallId === 'tc-pdf')?.result;
    if (!r1?.ok || !r2?.ok) throw new Error('expected both ok');

    // Per-call cost on the ToolResult (this is what AgentLoop reads to bump
    // the session-cost counter rendered by /usage).
    expect(r1.cost_usd).toBe(0.003);
    expect(r2.cost_usd).toBe(0.012);
    const total = (r1.cost_usd ?? 0) + (r2.cost_usd ?? 0);
    expect(total).toBeCloseTo(0.015, 6);

    // Envelope payloads also carry the usage breakdown for the LLM to read.
    const env1 = JSON.parse(r1.value);
    const env2 = JSON.parse(r2.value);
    expect(env1.input_tokens).toBe(100);
    expect(env1.output_tokens).toBe(10);
    expect(env2.input_tokens).toBe(400);
    expect(env2.output_tokens).toBe(20);

    // Confirm both request shapes landed on the provider: one image, one PDF.
    expect(imgCalls).toHaveLength(1);
    expect(pdfCalls).toHaveLength(1);
    expect((imgCalls[0]?.messages[0]?.content as unknown[] | undefined)?.[0]).toMatchObject({
      type: 'image',
      mediaType: 'image/png',
    });
    expect((pdfCalls[0]?.messages[0]?.content as unknown[] | undefined)?.[0]).toMatchObject({
      type: 'document',
      mediaType: 'application/pdf',
    });
  });

  it('routes to the auxiliary vision provider when auxiliary.vision.model is set', async () => {
    // Personality is configured with a non-vision primary model
    // (llama3:8b — not in the capability table). Wiring sets
    // auxiliary.vision.model = claude-sonnet-4-6 with a separate provider.
    // The tool's fallback chain picks the aux model, the resolveProvider
    // hands back the aux provider, and the request lands there — *not* on
    // the primary. This is the production code path that lets a Llama-routed
    // personality still analyze images via a cheap aux model.
    const personalityToolset = ['vision_analyze'];
    const path = join(tmpDir, 'pic.png');
    writeFileSync(path, TINY_PNG);

    const primaryCalls: StubCall[] = [];
    const auxCalls: StubCall[] = [];
    const primary = makeStubProvider(
      [
        { type: 'text_delta', text: 'should not be reached' },
        usageChunk(1, 1, 0.0001),
        { type: 'done', finishReason: 'end_turn' },
      ],
      primaryCalls,
      'llama3:8b',
    );
    const aux = makeStubProvider(
      [
        { type: 'text_delta', text: 'aux answered' },
        usageChunk(50, 5, 0.0005),
        { type: 'done', finishReason: 'end_turn' },
      ],
      auxCalls,
      'claude-sonnet-4-6',
    );
    const { registry } = buildRegistryWithVision({
      primary,
      defaultModel: 'llama3:8b',
      auxProvider: aux,
      auxModel: 'claude-sonnet-4-6',
    });

    const results = await registry.executeParallel(
      [{ toolCallId: 'tc-aux', name: 'vision_analyze', args: { file_path: path, prompt: 'q' } }],
      makeCtx(tmpDir),
      personalityToolset,
    );

    const r = results[0]?.result;
    if (!r?.ok) throw new Error(`expected ok result, got ${JSON.stringify(r)}`);
    const envelope = JSON.parse(r.value);
    expect(envelope.model).toBe('claude-sonnet-4-6');
    expect(envelope.text).toBe('aux answered');
    expect(primaryCalls).toHaveLength(0);
    expect(auxCalls).toHaveLength(1);
  });
});
