import type { LLMProvider, Message } from '@ethosagent/types';
import type { EvalExpected } from './types';

export type Scorer = (response: string, expected: EvalExpected) => Promise<number>;

export async function exactMatchScorer(response: string, expected: EvalExpected): Promise<number> {
  return response.trim() === expected.expected.trim() ? 1 : 0;
}

export async function containsScorer(response: string, expected: EvalExpected): Promise<number> {
  return response.toLowerCase().includes(expected.expected.toLowerCase()) ? 1 : 0;
}

export async function regexScorer(response: string, expected: EvalExpected): Promise<number> {
  try {
    return new RegExp(expected.expected, 'i').test(response) ? 1 : 0;
  } catch {
    return 0;
  }
}

export function llmJudgeScorer(llm: LLMProvider): Scorer {
  return async (response: string, expected: EvalExpected): Promise<number> => {
    const messages: Message[] = [
      {
        role: 'user',
        content: `Criteria: ${expected.expected}\n\nResponse:\n${response}\n\nDoes the response meet the criteria? Reply with only "1" (yes) or "0" (no).`,
      },
    ];
    let text = '';
    for await (const chunk of llm.complete(messages, [], { maxTokens: 5, temperature: 0 })) {
      if (chunk.type === 'text_delta') text += chunk.text;
    }
    return text.trim().startsWith('1') ? 1 : 0;
  };
}
