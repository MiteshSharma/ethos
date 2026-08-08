// biome-ignore-all lint/suspicious/noTemplateCurlyInString: fs_reach values are
// literal substitution tokens (`${ETHOS_HOME}` etc.) resolved at runtime, not
// JS template strings.
import type {
  CompletionChunk,
  ContextInjector,
  InjectionResult,
  LLMProvider,
  Message,
  PersonalityConfig,
  PromptContext,
  Tool,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import type { AgentEvent } from '../agent-loop';
import { AgentLoop } from '../agent-loop';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

// ---------------------------------------------------------------------------
// ctx.workingDir comes from the TURN's personality, not from the loop.
//
// `fs_reach.workdir` is a per-personality declaration, but AgentLoop is
// constructed once and can serve many personalities. Deriving the working
// directory at boot would hand every personality on a loop the same cwd — so
// it is derived per turn, and every consumer inside the turn (tool contexts,
// the prompt context the injectors see) reads that one value.
// ---------------------------------------------------------------------------

const ETHOS_HOME = '/home/tester/.ethos';
const BOOT_CWD = '/work/project';

/**
 * Calls `toolName` once per turn, then finishes. Driven off the message tail
 * rather than a call counter so a single provider serves many turns on the same
 * loop.
 */
function makeToolCallLLM(toolName: string): LLMProvider {
  return {
    name: 'scripted',
    model: 'mock-model',
    maxContextTokens: 200_000,
    supportsCaching: false,
    supportsThinking: false,
    async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
      const last = messages.at(-1);
      const answered =
        Array.isArray(last?.content) && last.content.some((c) => c.type === 'tool_result');
      if (!answered) {
        const id = 'call-1';
        yield { type: 'tool_use_start', toolCallId: id, toolName };
        yield { type: 'tool_use_delta', toolCallId: id, partialJson: '{}' };
        yield { type: 'tool_use_end', toolCallId: id, inputJson: '{}' };
        yield { type: 'done', finishReason: 'tool_use' };
        return;
      }
      yield { type: 'text_delta', text: 'ok' };
      yield { type: 'done', finishReason: 'end_turn' };
    },
    async countTokens() {
      return 1;
    },
  };
}

/** A tool that reports the `workingDir` its ToolContext carried. */
function makeProbeTool(sink: string[]): Tool {
  return {
    name: 'probe',
    description: 'reports ctx.workingDir',
    schema: { type: 'object' },
    capabilities: {},
    async execute(_args, ctx): Promise<ToolResult> {
      sink.push(ctx.workingDir);
      return { ok: true, value: ctx.workingDir };
    },
  };
}

/** An injector that reports the `workingDir` its PromptContext carried. */
function makeProbeInjector(sink: string[]): ContextInjector {
  return {
    id: 'workdir-probe',
    priority: 50,
    async inject(ctx: PromptContext): Promise<InjectionResult | null> {
      sink.push(ctx.workingDir ?? '<unset>');
      return null;
    },
  };
}

function buildLoop(
  personalities: PersonalityConfig[],
  opts: { toolSink: string[]; injectorSink?: string[] },
): AgentLoop {
  const registry = new DefaultPersonalityRegistry();
  for (const p of personalities) registry.define(p);
  const first = personalities[0];
  if (first) registry.setDefault(first.id);

  const tools = new DefaultToolRegistry();
  tools.register(makeProbeTool(opts.toolSink));

  return new AgentLoop({
    llm: makeToolCallLLM('probe'),
    tools,
    personalities: registry,
    safety: createTestSafety(),
    dataDir: ETHOS_HOME,
    ...(opts.injectorSink ? { injectors: [makeProbeInjector(opts.injectorSink)] } : {}),
    options: { workingDir: BOOT_CWD },
  });
}

async function drain(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('per-turn workingDir', () => {
  it('a declared fs_reach.workdir becomes ctx.workingDir', async () => {
    const toolSink: string[] = [];
    const loop = buildLoop(
      [{ id: 'docs', name: 'Docs', fs_reach: { workdir: '${ETHOS_HOME}/workspace/${self}' } }],
      { toolSink },
    );

    await drain(loop.run('go', { sessionKey: 'wd-declared' }));

    expect(toolSink).toEqual([`${ETHOS_HOME}/workspace/docs`]);
  });

  // Backward-compat regression guard: every personality that existed before
  // `fs_reach.workdir` must keep the boot-time cwd it has always had.
  it('an undeclared personality keeps the boot-time workingDir', async () => {
    const toolSink: string[] = [];
    const loop = buildLoop([{ id: 'plain', name: 'Plain' }], { toolSink });

    await drain(loop.run('go', { sessionKey: 'wd-undeclared' }));

    expect(toolSink).toEqual([BOOT_CWD]);
  });

  it('a declared read/write list does not disturb an undeclared workdir', async () => {
    const toolSink: string[] = [];
    const loop = buildLoop(
      [{ id: 'scoped', name: 'Scoped', fs_reach: { read: ['/data'], write: ['/data/out'] } }],
      { toolSink },
    );

    await drain(loop.run('go', { sessionKey: 'wd-reach-only' }));

    expect(toolSink).toEqual([BOOT_CWD]);
  });

  // The reason the derivation moved per-turn: one loop, many personalities.
  it('two personalities on one loop each get their own workdir', async () => {
    const toolSink: string[] = [];
    const loop = buildLoop(
      [
        { id: 'alpha', name: 'Alpha', fs_reach: { workdir: '/srv/alpha' } },
        { id: 'beta', name: 'Beta', fs_reach: { workdir: '/srv/beta' } },
        { id: 'gamma', name: 'Gamma' },
      ],
      { toolSink },
    );

    await drain(loop.run('go', { sessionKey: 'wd-alpha', personalityId: 'alpha' }));
    await drain(loop.run('go', { sessionKey: 'wd-beta', personalityId: 'beta' }));
    await drain(loop.run('go', { sessionKey: 'wd-gamma', personalityId: 'gamma' }));

    expect(toolSink).toEqual(['/srv/alpha', '/srv/beta', BOOT_CWD]);
  });

  // One value per turn, not two: `AGENTS.md`/`CLAUDE.md` discovery and the
  // injectors must agree with where the tools write.
  it('the tool context and the injectors observe the same workingDir', async () => {
    const toolSink: string[] = [];
    const injectorSink: string[] = [];
    const loop = buildLoop(
      [{ id: 'docs', name: 'Docs', fs_reach: { workdir: '/srv/documents' } }],
      {
        toolSink,
        injectorSink,
      },
    );

    await drain(loop.run('go', { sessionKey: 'wd-agree' }));

    expect(injectorSink.length).toBeGreaterThan(0);
    expect(new Set([...toolSink, ...injectorSink])).toEqual(new Set(['/srv/documents']));
  });

  // `${CWD}` inside the workdir means the BOOT cwd — it must be substituted
  // exactly once. Re-deriving downstream with the resolved workdir as `cwd`
  // would compound it into `/work/project/out/out`.
  it('substitutes ${CWD} in the workdir exactly once', async () => {
    const toolSink: string[] = [];
    const loop = buildLoop([{ id: 'rel', name: 'Rel', fs_reach: { workdir: '${CWD}/out' } }], {
      toolSink,
    });

    await drain(loop.run('go', { sessionKey: 'wd-cwd-token' }));

    expect(toolSink).toEqual([`${BOOT_CWD}/out`]);
  });

  // A declared path naming a variable that resolves to empty is a config error.
  // The turn refuses the way a blown budget cap does — an error event and a
  // done — rather than throwing out of the generator mid-turn.
  it('refuses the turn when a declared fs_reach path has an empty substitution', async () => {
    const toolSink: string[] = [];
    const registry = new DefaultPersonalityRegistry();
    registry.define({ id: 'bad', name: 'Bad', fs_reach: { workdir: '${CWD}/out' } });
    registry.setDefault('bad');
    const tools = new DefaultToolRegistry();
    tools.register(makeProbeTool(toolSink));

    const loop = new AgentLoop({
      llm: makeToolCallLLM('probe'),
      tools,
      personalities: registry,
      safety: createTestSafety(),
      dataDir: ETHOS_HOME,
      // No cwd to substitute into the declared `${CWD}/out`.
      options: { workingDir: '' },
    });

    const events = await drain(loop.run('go', { sessionKey: 'wd-empty-sub' }));

    const error = events.find((e) => e.type === 'error');
    expect(error).toMatchObject({ code: 'FS_REACH_INVALID' });
    expect(events.at(-1)?.type).toBe('done');
    expect(toolSink).toEqual([]);
  });
});
