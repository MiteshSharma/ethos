/**
 * Unit tests for ethos-plugin-hello.
 *
 * Unit tests focus on individual components in isolation — no real LLM,
 * no file system, no network. Use mockTool / ok / err from plugin-sdk.
 */

import { describe, expect, it } from 'vitest';
import { greetTool } from '../index';

const ctx = {
  sessionId: 'test-session',
  sessionKey: 'cli:test',
  platform: 'cli',
  workingDir: '/tmp',
  currentTurn: 1,
  messageCount: 1,
  abortSignal: new AbortController().signal,
  emit: () => {},
  resultBudgetChars: 80_000,
};

describe('greet tool', () => {
  it('greets in English by default', async () => {
    const result = await greetTool.execute({ name: 'Alice' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toContain('Hello');
      expect(result.value).toContain('Alice');
    }
  });

  it('greets in Spanish when language=es', async () => {
    const result = await greetTool.execute({ name: 'Carlos', language: 'es' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('Hola');
  });

  it('greets in Japanese when language=ja', async () => {
    const result = await greetTool.execute({ name: 'Yuki', language: 'ja' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('こんにちは');
  });

  it('falls back to English for unknown language code', async () => {
    const result = await greetTool.execute({ name: 'Test', language: 'zz' }, ctx);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toContain('Hello');
  });

  it('has correct tool metadata', () => {
    expect(greetTool.name).toBe('greet');
    expect(greetTool.toolset).toBe('hello');
    expect(greetTool.schema.required).toContain('name');
  });
});
