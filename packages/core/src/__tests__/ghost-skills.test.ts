// Item 7 stage 3 — ghost-skill defense.
//
// A "ghost skill" is a skill whose index stub still sits in the system prompt
// while its BODY — which arrived as a `get_skill` tool_result in the message
// array — has been pruned away. The model then believes it has a capability it
// cannot actually read, and confabulates the procedure. Three shipped pruners
// can create one, and none of them was skill-aware:
//
//   1. tool-result aging hard-clear
//   2. the compaction prefix drop (watermark reconstruct) — no marker at all
//   3. tool-result dedup — points back at a copy compaction may have dropped
//
// Each gets its own assertion below, plus the two scoping rules: nothing runs
// under `injection_mode: 'full'`, and the signal is the `get_skill` call, not
// `activeSkillFiles`.

import type {
  CompletionChunk,
  CompressionEvent,
  LLMProvider,
  Message,
  StoredMessage,
  ToolResult,
} from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { AgentLoop } from '../agent-loop';
import {
  droppedSkillNames,
  ghostSkillMarker,
  skillCallsFromHistory,
  skillCallsFromMessages,
  usesSkillIndexMode,
} from '../agent-loop/ghost-skills';
import { dedupHistory } from '../agent-loop/history';
import { reconstructFromWatermark } from '../agent-loop/manual-compact';
import { advanceAgingState, applyAgingToView } from '../agent-loop/tool-result-aging';
import { InMemorySessionStore } from '../defaults/in-memory-session';
import { DefaultPersonalityRegistry } from '../defaults/noop-personality';
import { DefaultToolRegistry } from '../tool-registry';
import { createTestSafety } from './helpers/test-safety';

const SKILL = 'ethos/grounded-citations';
const BODY = `# Grounded citations\n${'step. '.repeat(600)}`;

function storedGetSkill(n: number, name = SKILL, body = BODY): StoredMessage[] {
  const id = `toolu_skill_${n}`;
  return [
    { id: `u${n}`, sessionId: 's', role: 'user', content: `use ${name}`, timestamp: new Date(0) },
    {
      id: `a${n}`,
      sessionId: 's',
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'get_skill', input: { name } }],
      timestamp: new Date(0),
    },
    {
      id: `t${n}`,
      sessionId: 's',
      role: 'tool_result',
      content: body,
      toolCallId: id,
      toolName: 'get_skill',
      timestamp: new Date(0),
    },
    { id: `r${n}`, sessionId: 's', role: 'assistant', content: `ok ${n}`, timestamp: new Date(0) },
  ];
}

function storedPlainTool(n: number, path = '/f'): StoredMessage[] {
  const id = `toolu_plain_${n}`;
  return [
    { id: `pu${n}`, sessionId: 's', role: 'user', content: `read ${n}`, timestamp: new Date(0) },
    {
      id: `pa${n}`,
      sessionId: 's',
      role: 'assistant',
      content: '',
      toolCalls: [{ id, name: 'read_file', input: { path } }],
      timestamp: new Date(0),
    },
    {
      id: `pt${n}`,
      sessionId: 's',
      role: 'tool_result',
      content: 'x'.repeat(5_000),
      toolCallId: id,
      toolName: 'read_file',
      timestamp: new Date(0),
    },
    {
      id: `pr${n}`,
      sessionId: 's',
      role: 'assistant',
      content: `done ${n}`,
      timestamp: new Date(0),
    },
  ];
}

/** The LLM view of a `get_skill` load, as `toLLMMessages` would build it. */
function llmGetSkill(n: number, name = SKILL, body = BODY): Message[] {
  const id = `toolu_skill_${n}`;
  return [
    { role: 'user', content: `use ${name}` },
    { role: 'assistant', content: [{ type: 'tool_use', id, name: 'get_skill', input: { name } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: body }] },
    { role: 'assistant', content: `ok ${n}` },
  ];
}

function watermark(keptFromMessageId: string, summaryText?: string): CompressionEvent {
  return {
    id: 'c1',
    sessionId: 's',
    engineName: summaryText ? 'semantic_summary' : 'drop_oldest',
    originalCount: 10,
    keptCount: 4,
    keptFromMessageId,
    summaryTokens: 0,
    preTotalTokens: 0,
    postTotalTokens: 0,
    durationMs: 1,
    createdAt: new Date(0),
    ...(summaryText ? { summaryText } : {}),
  } as CompressionEvent;
}

describe('ghost-skill defense — pruner 1: tool-result aging hard-clear', () => {
  const view: Message[] = [...llmGetSkill(0), ...llmGetSkill(1, 'ethos/other', 'other body')];
  // Four tool-using turns so the first two fall outside the kept-recent window.
  const messages: Message[] = [
    ...view,
    ...llmGetSkill(2, 'ethos/third'),
    ...llmGetSkill(3, 'ethos/fourth'),
    ...llmGetSkill(4, 'ethos/fifth'),
  ];
  const hard = advanceAgingState({ level: 'none', soft: [], hard: [] }, messages, 0.9).state;
  const resultFor = (list: Message[], id: string): string => {
    for (const m of list) {
      if (m.role !== 'user' || typeof m.content === 'string') continue;
      for (const b of m.content)
        if (b.type === 'tool_result' && b.tool_use_id === id) return b.content;
    }
    return '';
  };

  it('names the skill instead of the generic placeholder (index mode)', () => {
    expect(hard.hard).toContain('toolu_skill_0');
    const out = applyAgingToView(messages, hard, { skillNames: skillCallsFromMessages(messages) });
    const cleared = resultFor(out.messages, 'toolu_skill_0');
    expect(cleared).toBe(ghostSkillMarker(SKILL));
    // The body itself is gone from the aged result.
    expect(cleared).not.toContain('# Grounded citations');
  });

  it('leaves the generic placeholder when markers are off (full mode)', () => {
    const out = applyAgingToView(messages, hard);
    const cleared = resultFor(out.messages, 'toolu_skill_0');
    expect(cleared).toContain('tool result cleared to reclaim context');
    expect(cleared).not.toContain('was loaded earlier');
  });
});

describe('ghost-skill defense — pruner 2: compaction prefix drop', () => {
  const history = [
    ...storedGetSkill(0),
    ...storedGetSkill(1, 'ethos/second'),
    ...storedPlainTool(9),
  ];
  const boundary = 'pu9'; // keep only the plain-tool turn; both skill loads drop

  it('names the dropped skills in the synthetic summary message (index mode)', () => {
    const out = reconstructFromWatermark(history, watermark(boundary, 'earlier stuff'), {
      skillMarkers: true,
    });
    expect(out.applied).toBe(true);
    const synthetic = out.history[0]?.content ?? '';
    expect(synthetic).toContain('earlier stuff');
    expect(synthetic).toContain(`"${SKILL}"`);
    expect(synthetic).toContain('"ethos/second"');
    expect(synthetic).toContain('get_skill(name) again');
  });

  it('still leaves a notice when the watermark carries no summary at all', () => {
    const out = reconstructFromWatermark(history, watermark(boundary), { skillMarkers: true });
    expect(out.applied).toBe(true);
    expect(out.history[0]?.content).toContain(`"${SKILL}"`);
    // The bodies are gone from the reconstructed history.
    expect(JSON.stringify(out.history)).not.toContain('# Grounded citations');
  });

  it('leaves no marker at all under full mode', () => {
    const summarized = reconstructFromWatermark(history, watermark(boundary, 'earlier stuff'));
    expect(summarized.history[0]?.content).not.toContain('compaction dropped');
    const dropOnly = reconstructFromWatermark(history, watermark(boundary));
    expect(JSON.stringify(dropOnly.history)).not.toContain('compaction dropped');
    // Drop-only + full mode also means no synthetic message is invented.
    expect(dropOnly.history[0]?.id).toBe('pu9');
  });
});

describe('ghost-skill defense — pruner 3: tool-result dedup', () => {
  // The same skill loaded twice — dedup replaces the second copy.
  const history = [...storedGetSkill(0), ...storedGetSkill(1)];

  it('replaces the deduped skill body with a marker naming the skill', () => {
    const out = dedupHistory(history, { skillMarkers: true });
    const second = out.find((m) => m.id === 't1');
    expect(second?.content).toBe(ghostSkillMarker(SKILL));
    // The first copy is untouched.
    expect(out.find((m) => m.id === 't0')?.content).toBe(BODY);
  });

  it('falls back to the plain backward pointer under full mode', () => {
    const out = dedupHistory(history);
    expect(out.find((m) => m.id === 't1')?.content).toContain('deduped — identical to earlier');
    expect(out.find((m) => m.id === 't1')?.content).not.toContain('was loaded earlier');
  });

  it('leaves non-skill duplicate results on the plain pointer even in index mode', () => {
    const plain = [...storedPlainTool(1), ...storedPlainTool(2)];
    const out = dedupHistory(plain, { skillMarkers: true });
    expect(out.find((m) => m.id === 'pt2')?.content).toContain('deduped — identical to earlier');
  });
});

describe('ghost-skill defense — scoping', () => {
  it('treats an absent injection_mode as index (the shipped default)', () => {
    expect(usesSkillIndexMode(undefined)).toBe(true);
    expect(usesSkillIndexMode('index')).toBe(true);
    expect(usesSkillIndexMode('full')).toBe(false);
  });

  it('keys off get_skill results, not activeSkillFiles', () => {
    // This skill was never INJECTED — `promptCtx.meta.skillFilesUsed` (the
    // source of `activeSkillFiles`) would be empty for it. It was loaded on
    // demand, which is exactly the population at risk.
    const history = storedGetSkill(0, 'ethos/never-injected');
    const activeSkillFiles: string[] = [];

    const calls = skillCallsFromHistory(history);
    expect([...calls.values()]).toEqual(['ethos/never-injected']);
    expect(droppedSkillNames(history, calls)).toEqual(['ethos/never-injected']);
    // The signal the defense does NOT use would have missed it entirely.
    expect(activeSkillFiles).toHaveLength(0);
  });

  it('ignores tool calls that are not get_skill', () => {
    expect(skillCallsFromHistory(storedPlainTool(1)).size).toBe(0);
    expect(skillCallsFromMessages([{ role: 'assistant', content: 'plain text' }]).size).toBe(0);
  });

  it('is gated end-to-end by the personality injection_mode', async () => {
    // Two turns, each loading the SAME skill: dedup collapses the second copy,
    // and the marker (or its absence) is what the LLM actually receives.
    const seen = async (mode: 'full' | 'index' | undefined): Promise<string> => {
      const personalities = new DefaultPersonalityRegistry();
      vi.spyOn(personalities, 'getDefault').mockReturnValue({
        id: 'p',
        name: 'P',
        toolset: ['get_skill'],
        ...(mode ? { skills: { injection_mode: mode } } : {}),
      });
      const tools = new DefaultToolRegistry();
      tools.register({
        name: 'get_skill',
        description: 'Load a skill body.',
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
        capabilities: {},
        async execute(): Promise<ToolResult> {
          return { ok: true, value: BODY };
        },
      });
      const captured: Message[][] = [];
      let step = 0;
      const llm: LLMProvider = {
        name: 'm',
        model: 'm',
        maxContextTokens: 200_000,
        supportsCaching: false,
        supportsThinking: false,
        async *complete(messages: Message[]): AsyncIterable<CompletionChunk> {
          captured.push(structuredClone(messages));
          if (step++ % 2 === 0) {
            const id = `toolu_gs_${step}`;
            yield { type: 'tool_use_start', toolCallId: id, toolName: 'get_skill' };
            yield {
              type: 'tool_use_end',
              toolCallId: id,
              inputJson: JSON.stringify({ name: SKILL }),
            };
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
      const loop = new AgentLoop({
        llm,
        safety: createTestSafety(),
        personalities,
        tools,
        session: new InMemorySessionStore(),
      });
      for (let i = 0; i < 3; i++) {
        for await (const _e of loop.run(`load ${SKILL}`)) {
          // discard
        }
      }
      return JSON.stringify(captured[captured.length - 1] ?? []);
    };

    const indexMode = await seen('index');
    expect(indexMode).toContain('was loaded earlier');
    expect(indexMode).toContain(SKILL);

    const fullMode = await seen('full');
    expect(fullMode).not.toContain('was loaded earlier');
    expect(fullMode).toContain('deduped — identical to earlier');

    // Absent `skills` config behaves as index — the shipped default.
    expect(await seen(undefined)).toContain('was loaded earlier');
  });

  it('dedupes names and preserves first-seen order so the notice is byte-stable', () => {
    const history = [
      ...storedGetSkill(0, 'b/second'),
      ...storedGetSkill(1, 'a/first'),
      ...storedGetSkill(2, 'b/second'),
    ];
    const names = droppedSkillNames(history, skillCallsFromHistory(history));
    expect(names).toEqual(['b/second', 'a/first']);
  });
});
