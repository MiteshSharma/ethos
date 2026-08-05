import { DefaultToolRegistry } from '@ethosagent/core';
import type { PersonalityConfig, Tool } from '@ethosagent/types';
import { evaluateToolSchemaBudget, measureStaticFloor } from '@ethosagent/wiring';
import { describe, expect, it } from 'vitest';
import { measurePersonalityStatic } from '../commands/bench';

const makeTool = (name: string, description = `Test tool ${name}`): Tool => ({
  name,
  description,
  schema: { type: 'object', properties: { path: { type: 'string' } } },
  capabilities: {},
  execute: async () => ({ ok: true, value: name }),
});

const makePersonality = (id: string, toolset?: string[]): PersonalityConfig => ({
  id,
  name: id,
  ...(toolset ? { toolset } : {}),
});

describe('measurePersonalityStatic', () => {
  it('counts SOUL chars and only the tools in the personality toolset', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('read_file'));
    registry.register(makeTool('write_file'));
    registry.register(makeTool('web_search'));

    const soul = 'I am a reader.';
    const row = measurePersonalityStatic(makePersonality('reader', ['read_file']), soul, registry);

    expect(row.id).toBe('reader');
    expect(row.soulChars).toBe(soul.length);
    expect(row.toolCount).toBe(1);
    const expectedChars = JSON.stringify(registry.toDefinitions(['read_file'])).length;
    expect(row.toolSchemaChars).toBe(expectedChars);
    expect(row.estStaticTokens).toBe(Math.ceil((soul.length + expectedChars) / 4));
  });

  it('an unrestricted toolset sees every registered tool', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('a'));
    registry.register(makeTool('b'));

    const row = measurePersonalityStatic(makePersonality('open'), '', registry);
    expect(row.toolCount).toBe(2);
    expect(row.soulChars).toBe(0);
    expect(row.toolSchemaChars).toBe(JSON.stringify(registry.toDefinitions(undefined)).length);
  });

  it('a bigger schema costs more estimated tokens than a smaller one', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('tiny', 'x'));
    registry.register(makeTool('verbose', 'A long description. '.repeat(50)));

    const tiny = measurePersonalityStatic(makePersonality('p1', ['tiny']), '', registry);
    const verbose = measurePersonalityStatic(makePersonality('p2', ['verbose']), '', registry);
    expect(verbose.toolSchemaChars).toBeGreaterThan(tiny.toolSchemaChars);
    expect(verbose.estStaticTokens).toBeGreaterThan(tiny.estStaticTokens);
  });

  it('degrades without a tool registry: toolset name count, zero schema chars', () => {
    const soul = 'soul body';
    const row = measurePersonalityStatic(makePersonality('bare', ['read_file', 'terminal']), soul);
    expect(row.toolCount).toBe(2);
    expect(row.toolSchemaChars).toBe(0);
    expect(row.estStaticTokens).toBe(Math.ceil(soul.length / 4));
  });

  // D8 cross-check — bench and build-agent-loop share ONE static-floor
  // arithmetic: fed the same inputs, `measurePersonalityStatic` reports the
  // exact number `measureStaticFloor` (which build-agent-loop consumes)
  // produces, prelude included.
  it('produces the same static-floor number as the shared wiring helper', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('read_file'));
    registry.register(makeTool('bash'));

    const soul = 'I am the cross-check personality.';
    const preludeChars = 1_337;
    const row = measurePersonalityStatic(
      makePersonality('xcheck', ['read_file', 'bash']),
      soul,
      registry,
      preludeChars,
    );
    const floor = measureStaticFloor({
      soulChars: soul.length,
      toolSchemaChars: JSON.stringify(registry.toDefinitions(['read_file', 'bash'])).length,
      toolCount: 2,
      preludeChars,
    });
    expect(row.estStaticTokens).toBe(floor.tokens);
    expect(row.toolCount).toBe(floor.toolCount);
  });

  // Lane 3(b) cross-check — the schema-budget warning threshold and the bench
  // measurement agree: for one personality, the chars/tokens the bench table
  // reports ARE the numbers `evaluateToolSchemaBudget` (the startup warning,
  // also wired into `ethos bench context`) divides by the served window.
  it('the schema-budget warning reads the same measurement the bench reports', () => {
    const registry = new DefaultToolRegistry();
    registry.register(makeTool('read_file', 'A long description. '.repeat(400)));
    registry.register(makeTool('bash', 'Another long description. '.repeat(400)));

    const personality = makePersonality('budget-xcheck', ['read_file', 'bash']);
    const row = measurePersonalityStatic(personality, '', registry);
    const verdict = evaluateToolSchemaBudget({
      personalityId: personality.id,
      windowTokens: 8_000,
      toolDefinitions: registry.toDefinitions(personality.toolset),
    });

    expect(verdict.toolSchemaChars).toBe(row.toolSchemaChars);
    expect(verdict.toolSchemaTokens).toBe(Math.ceil(row.toolSchemaChars / 4));
    expect(verdict.share).toBe(verdict.toolSchemaTokens / 8_000);
    // Over the 0.4 default on an 8k window → the warning names the personality.
    expect(verdict.message).toContain('budget-xcheck');
  });
});
