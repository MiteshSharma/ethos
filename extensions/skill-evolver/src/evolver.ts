import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LLMProvider, Message } from '@ethosagent/types';
import { analyzeEvalOutput, parseEvalJsonl } from './analyze';
import {
  parseNewSkillResponse,
  parseRewriteResponse,
  renderNewSkillPrompt,
  renderRewritePrompt,
} from './prompts';
import type { EvolutionPlan, EvolveConfig } from './types';

export interface EvolveOptions {
  evalOutputPath: string;
  skillsDir: string;
  pendingDir: string;
  config: EvolveConfig;
  llm: LLMProvider;
}

export interface EvolveResult {
  plan: EvolutionPlan;
  rewritesWritten: string[];
  newSkillsWritten: string[];
  skipped: Array<{ kind: 'rewrite' | 'new'; target: string; reason: string }>;
}

export class SkillEvolver {
  constructor(private readonly options: EvolveOptions) {}

  async evolve(): Promise<EvolveResult> {
    const { evalOutputPath, skillsDir, pendingDir, config, llm } = this.options;

    const src = await readFile(evalOutputPath, 'utf-8');
    const records = parseEvalJsonl(src);
    const plan = await analyzeEvalOutput(records, skillsDir, config);

    await mkdir(pendingDir, { recursive: true });

    const rewritesWritten: string[] = [];
    const newSkillsWritten: string[] = [];
    const skipped: EvolveResult['skipped'] = [];

    for (const candidate of plan.rewriteCandidates) {
      const prompt = renderRewritePrompt(candidate);
      const raw = await callLLM(llm, prompt);
      const parsed = parseRewriteResponse(raw);
      if (parsed.kind === 'skip') {
        skipped.push({ kind: 'rewrite', target: candidate.fileName, reason: parsed.reason });
        continue;
      }
      const outName = candidate.fileName;
      await writeFile(join(pendingDir, outName), `${parsed.content}\n`, 'utf-8');
      rewritesWritten.push(outName);
    }

    for (const candidate of plan.newSkillCandidates) {
      const prompt = renderNewSkillPrompt(candidate);
      const raw = await callLLM(llm, prompt);
      const parsed = parseNewSkillResponse(raw);
      if (parsed.kind === 'skip') {
        skipped.push({ kind: 'new', target: 'pattern-bundle', reason: parsed.reason });
        continue;
      }
      const safeName = await pickAvailableName(parsed.fileName, pendingDir, skillsDir);
      await writeFile(join(pendingDir, safeName), `${parsed.content}\n`, 'utf-8');
      newSkillsWritten.push(safeName);
    }

    return { plan, rewritesWritten, newSkillsWritten, skipped };
  }
}

async function callLLM(llm: LLMProvider, prompt: string): Promise<string> {
  const messages: Message[] = [{ role: 'user', content: prompt }];
  let text = '';
  for await (const chunk of llm.complete(messages, [], { maxTokens: 2048, temperature: 0.2 })) {
    if (chunk.type === 'text_delta') text += chunk.text;
  }
  return text;
}

// If the LLM picks a filename already used by an existing skill (or already
// queued in pending/), suffix it with -2, -3, ... so we don't silently clobber.
async function pickAvailableName(
  proposed: string,
  pendingDir: string,
  skillsDir: string,
): Promise<string> {
  const taken = new Set<string>();
  for (const dir of [pendingDir, skillsDir]) {
    try {
      for (const entry of await readdir(dir)) {
        if (entry.endsWith('.md')) taken.add(entry);
      }
    } catch {
      /* dir missing — fine */
    }
  }
  if (!taken.has(proposed)) return proposed;
  const base = proposed.replace(/\.md$/, '');
  for (let i = 2; i < 100; i++) {
    const candidate = `${base}-${i}.md`;
    if (!taken.has(candidate)) return candidate;
  }
  // Improbable, but bail safely with a timestamp suffix.
  return `${base}-${Date.now()}.md`;
}
