// Ground-truth verification config (plan/phases/ground-truth-verification.md,
// §Config). Six keys across two nesting levels, one of them a list — the only
// list-valued key in the config that sits two levels down, and the only one
// whose elements contain spaces.

import { join } from 'node:path';
import { InMemorySecretsResolver, InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { configParseNotices, ethosDir, readRawConfig, writeConfig } from '../index';

describe('grounding config parsing', () => {
  async function load(yaml: string) {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(join(ethosDir(), 'config.yaml'), yaml);
    return readRawConfig(storage);
  }

  const base = ['provider: ollama', 'model: llama3.2', 'apiKey: sk', 'personality: p'];

  it('parses all six keys, flat and nested', async () => {
    const cfg = await load(
      [
        ...base,
        'grounding.enabled: true',
        'grounding.onFinding: correct',
        'grounding.showUnsupported: true',
        'grounding.memoryTag: true',
        'grounding.kanban.checks: true',
        'grounding.kanban.allowedCheckCommands: pnpm test, pnpm typecheck',
      ].join('\n'),
    );
    expect(cfg?.grounding).toEqual({
      enabled: true,
      onFinding: 'correct',
      showUnsupported: true,
      memoryTag: true,
      kanban: { checks: true, allowedCheckCommands: ['pnpm test', 'pnpm typecheck'] },
    });
  });

  it('splits the command list on commas only, so multi-word commands survive', async () => {
    const cfg = await load(
      [...base, 'grounding.kanban.allowedCheckCommands: pnpm test,  pnpm run lint ,'].join('\n'),
    );
    expect(cfg?.grounding?.kanban?.allowedCheckCommands).toEqual(['pnpm test', 'pnpm run lint']);
  });

  it('parses false as false, not as absent', async () => {
    const cfg = await load(
      [...base, 'grounding.enabled: false', 'grounding.kanban.checks: false'].join('\n'),
    );
    expect(cfg?.grounding).toEqual({ enabled: false, kanban: { checks: false } });
  });

  it('keeps the nested block independent of the flat keys', async () => {
    const cfg = await load([...base, 'grounding.kanban.checks: true'].join('\n'));
    expect(cfg?.grounding).toEqual({ kanban: { checks: true } });
  });

  it('leaves grounding undefined when no keys are present', async () => {
    const cfg = await load(base.join('\n'));
    expect(cfg?.grounding).toBeUndefined();
  });

  it('refuses an onFinding value that is neither annotate nor correct', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    await storage.write(
      join(ethosDir(), 'config.yaml'),
      [...base, 'grounding.onFinding: rewrite'].join('\n'),
    );
    const cfg = await readRawConfig(storage);
    expect(cfg).not.toBeNull();
    if (!cfg) return;
    // Loud, not lenient: the two modes do materially different things, so a
    // typo must not fall back to `annotate` and leave the operator believing
    // they had `correct`.
    expect(configParseNotices(cfg).errors).toContain(
      "grounding.onFinding: invalid value 'rewrite' (expected one of: annotate, correct).",
    );
    expect(cfg.grounding).toBeUndefined();
  });

  it('round-trips every key through writeConfig', async () => {
    const storage = new InMemoryStorage();
    await storage.mkdir(ethosDir());
    const original = {
      provider: 'ollama',
      model: 'llama3.2',
      apiKey: 'sk',
      personality: 'researcher',
      grounding: {
        enabled: true,
        onFinding: 'correct' as const,
        showUnsupported: false,
        memoryTag: true,
        kanban: { checks: false, allowedCheckCommands: ['pnpm test', 'pnpm typecheck'] },
      },
    };
    await writeConfig(storage, original, new InMemorySecretsResolver());
    const roundTripped = await readRawConfig(storage);
    expect(roundTripped?.grounding).toEqual(original.grounding);
  });
});
