import type {
  ContextEngine,
  ContextEngineCompactInput,
  ContextEngineCompactOutput,
  Message,
  PersonalityConfig,
} from '@ethosagent/types';
import { isStandingInstruction, messageDirectiveText } from './standing-instructions';

export interface ConformanceResult {
  passed: boolean;
  failures: string[];
}

const personality: PersonalityConfig = { id: 'test', name: 'Test' };
const sessionMetadata = { sessionId: 's', sessionKey: 'cli:s', turnNumber: 0 };

function userMsg(text: string): Message {
  return { role: 'user', content: text };
}

function assistantMsg(text: string): Message {
  return { role: 'assistant', content: text };
}

function validateOutput(
  output: ContextEngineCompactOutput,
  originalMessages: Message[],
  failures: string[],
  prefix: string,
): void {
  // 1. messages is an array (never undefined/null)
  if (!Array.isArray(output.messages)) {
    failures.push(`${prefix}: messages is not an array`);
    return; // can't validate further
  }

  // 2. notes is a non-empty string
  if (typeof output.notes !== 'string' || output.notes.length === 0) {
    failures.push(`${prefix}: notes must be a non-empty string`);
  }

  // 3. If summaryText is set, it's a non-empty string
  if (output.summaryText !== undefined) {
    if (typeof output.summaryText !== 'string' || output.summaryText.length === 0) {
      failures.push(`${prefix}: summaryText, when set, must be a non-empty string`);
    }
  }

  // 4. If cacheBreakpoints is set, every value is a valid index
  if (output.cacheBreakpoints !== undefined) {
    for (const bp of output.cacheBreakpoints) {
      if (typeof bp !== 'number' || bp < 0 || bp >= output.messages.length) {
        failures.push(
          `${prefix}: cacheBreakpoint ${bp} out of range [0, ${output.messages.length})`,
        );
      }
    }
  }

  // 5. If cacheAnchor is set, it's a valid index
  if (output.cacheAnchor !== undefined) {
    if (
      typeof output.cacheAnchor !== 'number' ||
      output.cacheAnchor < 0 ||
      output.cacheAnchor >= output.messages.length
    ) {
      failures.push(
        `${prefix}: cacheAnchor ${output.cacheAnchor} out of range [0, ${output.messages.length})`,
      );
    }
  }

  // 6. Every message has a valid role ('user' or 'assistant')
  for (let i = 0; i < output.messages.length; i++) {
    const msg = output.messages[i];
    if (!msg) continue;
    if (msg.role !== 'user' && msg.role !== 'assistant') {
      failures.push(
        `${prefix}: message[${i}].role is '${msg.role}', expected 'user' or 'assistant'`,
      );
    }
  }

  // 7. Every message has non-empty content
  for (let i = 0; i < output.messages.length; i++) {
    const msg = output.messages[i];
    if (!msg) continue;
    if (typeof msg.content === 'string') {
      if (msg.content.length === 0) {
        failures.push(`${prefix}: message[${i}].content is empty`);
      }
    } else if (Array.isArray(msg.content)) {
      if (msg.content.length === 0) {
        failures.push(`${prefix}: message[${i}].content is an empty array`);
      }
    } else {
      failures.push(`${prefix}: message[${i}].content is not a string or array`);
    }
  }

  // 8. If removed is set, validate entries
  if (output.removed !== undefined) {
    const validReasons = new Set(['trimmed', 'summarized', 'paged_out']);
    for (let i = 0; i < output.removed.length; i++) {
      const entry = output.removed[i];
      if (!entry) continue;
      if (
        typeof entry.index !== 'number' ||
        entry.index < 0 ||
        entry.index >= originalMessages.length
      ) {
        failures.push(
          `${prefix}: removed[${i}].index ${entry.index} out of range [0, ${originalMessages.length})`,
        );
      }
      if (!validReasons.has(entry.reason)) {
        failures.push(`${prefix}: removed[${i}].reason '${entry.reason}' is invalid`);
      }
    }
  }

  // 9. If summaries is set, validate entries
  if (output.summaries !== undefined) {
    for (let i = 0; i < output.summaries.length; i++) {
      const entry = output.summaries[i];
      if (!entry) continue;
      if (typeof entry.text !== 'string' || entry.text.length === 0) {
        failures.push(`${prefix}: summaries[${i}].text must be a non-empty string`);
      }
      if (!Array.isArray(entry.sourceRange) || entry.sourceRange.length !== 2) {
        failures.push(`${prefix}: summaries[${i}].sourceRange must be a 2-element tuple`);
      } else {
        const [start, end] = entry.sourceRange;
        if (
          typeof start !== 'number' ||
          typeof end !== 'number' ||
          start >= end ||
          start < 0 ||
          end > originalMessages.length
        ) {
          failures.push(
            `${prefix}: summaries[${i}].sourceRange [${start}, ${end}) invalid for ${originalMessages.length} messages`,
          );
        }
      }
    }
  }

  // 10. If externalWrites is set, validate entries
  if (output.externalWrites !== undefined) {
    for (let i = 0; i < output.externalWrites.length; i++) {
      const entry = output.externalWrites[i];
      if (!entry) continue;
      if (typeof entry.key !== 'string' || entry.key.length === 0) {
        failures.push(`${prefix}: externalWrites[${i}].key must be a non-empty string`);
      }
      if (typeof entry.tokenCount !== 'number' || entry.tokenCount < 0) {
        failures.push(`${prefix}: externalWrites[${i}].tokenCount must be >= 0`);
      }
    }
  }
}

export async function validateContextEngine(engine: ContextEngine): Promise<ConformanceResult> {
  const failures: string[] = [];

  // Scenario 1: Under-budget — 2 short messages, high target
  try {
    const msgs: Message[] = [userMsg('hello'), assistantMsg('hi there')];
    const output = await engine.compact({
      messages: msgs,
      currentSystem: '',
      targetTokens: 10000,
      personality,
      sessionMetadata,
    });
    validateOutput(output, msgs, failures, 'under-budget');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`under-budget: engine threw: ${msg}`);
  }

  // Scenario 2: Over-budget — 20 long messages, low target
  const longMessages: Message[] = [];
  for (let i = 0; i < 20; i++) {
    longMessages.push(i % 2 === 0 ? userMsg('x'.repeat(400)) : assistantMsg('x'.repeat(400)));
  }

  try {
    const output = await engine.compact({
      messages: longMessages,
      currentSystem: '',
      targetTokens: 500,
      personality,
      sessionMetadata,
    });
    validateOutput(output, longMessages, failures, 'over-budget');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`over-budget: engine threw: ${msg}`);
  }

  // Scenario 3: With all handles — same long messages, mock handles
  try {
    const output = await engine.compact({
      messages: longMessages,
      currentSystem: '',
      targetTokens: 500,
      personality,
      sessionMetadata,
      llm: { summarize: async (_msgs, _target) => 'mock summary' },
      store: {
        read: async () => null,
        write: async () => {},
        list: async () => [],
      },
      countTokens: async (msgs) => msgs.length * 100,
    });
    validateOutput(output, longMessages, failures, 'with-handles');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`with-handles: engine threw: ${msg}`);
  }

  // Scenario 4: standing-instruction preservation (context-economy Phase 2,
  // §3.4.2) — a durable user directive sits in the compactable middle. When the
  // engine compacts directive-bearing user messages away AND produces a
  // summaryText, the directive must either survive verbatim among the output
  // messages (carry-forward) or be covered by a "Standing instructions" section
  // in the summary. Engines that drop without summarizing (no summaryText) are
  // exempt — the rule targets lossy summarization, not plain trimming.
  const directive = 'From now on, always answer in French.';
  const directiveMessages: Message[] = longMessages.map((m, i) =>
    i === 9 ? userMsg(directive) : m,
  );

  try {
    const output = await engine.compact({
      messages: directiveMessages,
      currentSystem: '',
      targetTokens: 500,
      personality,
      sessionMetadata,
    });
    validateOutput(output, directiveMessages, failures, 'standing-instruction');
    if (Array.isArray(output.messages) && typeof output.summaryText === 'string') {
      const outputTexts = output.messages.map((m) => messageDirectiveText(m));
      const lost = directiveMessages.filter((m) => {
        if (m.role !== 'user') return false;
        const text = messageDirectiveText(m).trim();
        if (text.length === 0 || !isStandingInstruction(text)) return false;
        return !outputTexts.some((t) => t.includes(text));
      });
      if (lost.length > 0 && !output.summaryText.includes('Standing instructions')) {
        failures.push(
          `standing-instruction: directive "${directive}" was compacted away with no verbatim carry-forward and no "Standing instructions" section in summaryText`,
        );
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    failures.push(`standing-instruction: engine threw: ${msg}`);
  }

  // Scenario 5: shouldCompact check
  if (engine.shouldCompact) {
    try {
      const underBudgetInput: ContextEngineCompactInput = {
        messages: [userMsg('hello'), assistantMsg('hi there')],
        currentSystem: '',
        targetTokens: 10000,
        personality,
        sessionMetadata,
      };
      const underResult = engine.shouldCompact(underBudgetInput);
      if (typeof underResult !== 'boolean') {
        failures.push('shouldCompact: under-budget did not return a boolean');
      }

      const overBudgetInput: ContextEngineCompactInput = {
        messages: longMessages,
        currentSystem: '',
        targetTokens: 500,
        personality,
        sessionMetadata,
      };
      const overResult = engine.shouldCompact(overBudgetInput);
      if (typeof overResult !== 'boolean') {
        failures.push('shouldCompact: over-budget did not return a boolean');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`shouldCompact: threw: ${msg}`);
    }
  }

  // Scenario 6: onTurnComplete (Item 7). Optional, like Scenario 5 — an engine
  // that does not declare the verb skips it and still passes. When it IS
  // declared, three things are checked, each mapping to a cache-safety property
  // the framework relies on:
  //   • it resolves to an object or null (never undefined, never a throw);
  //   • every nominated id is a string that exists as a `tool_use` id in the
  //     input — index-keyed or invented nominations would drift onto unrelated
  //     messages as the array grows;
  //   • the same input twice yields the same nominations, so a turn with no
  //     state change rewrites the view byte-identically.
  if (engine.onTurnComplete) {
    const toolUseId = 'toolu_conformance_1';
    const turnMessages: Message[] = [
      userMsg('run the thing'),
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: toolUseId, name: 'read_file', input: {} }],
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'x'.repeat(4000),
            is_error: false,
          },
        ],
      },
      assistantMsg('done'),
    ];
    const input = {
      messages: turnMessages,
      currentSystem: '',
      pressureRatio: 0.9,
      personality,
      sessionMetadata,
    };
    try {
      const first = await engine.onTurnComplete(input);
      if (first !== null && (typeof first !== 'object' || Array.isArray(first))) {
        failures.push('onTurnComplete: did not resolve to an object or null');
      } else if (first !== null) {
        const nominated = [...(first.trimToolResults ?? []), ...(first.clearToolResults ?? [])];
        for (const id of nominated) {
          if (typeof id !== 'string') {
            failures.push(`onTurnComplete: nominated id ${String(id)} is not a string`);
          } else if (id !== toolUseId) {
            failures.push(
              `onTurnComplete: nominated "${id}", which is not a tool_use id in the input`,
            );
          }
        }
        const second = await engine.onTurnComplete(input);
        if (JSON.stringify(second) !== JSON.stringify(first)) {
          failures.push('onTurnComplete: is not deterministic for identical input');
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push(`onTurnComplete: threw: ${msg}`);
    }
  }

  return { passed: failures.length === 0, failures };
}
