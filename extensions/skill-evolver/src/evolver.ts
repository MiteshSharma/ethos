import { join } from 'node:path';
import { FsStorage } from '@ethosagent/storage-fs';
import type { LLMProvider, Message, Storage } from '@ethosagent/types';
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
  /** Storage backend. Defaults to FsStorage. */
  storage?: Storage;
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
    const storage = this.options.storage ?? new FsStorage();

    const src = await storage.read(evalOutputPath);
    if (!src) throw new Error(`eval output not found: ${evalOutputPath}`);
    const records = parseEvalJsonl(src);
    const plan = await analyzeEvalOutput(records, skillsDir, config, storage);

    await storage.mkdir(pendingDir);

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
      await storage.write(join(pendingDir, outName), `${parsed.content}\n`);
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
      const safeName = await pickAvailableName(parsed.fileName, pendingDir, skillsDir, storage);
      await storage.write(join(pendingDir, safeName), `${parsed.content}\n`);
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
  storage: Storage,
): Promise<string> {
  const taken = new Set<string>();
  for (const dir of [pendingDir, skillsDir]) {
    for (const entry of await storage.list(dir)) {
      if (entry.endsWith('.md')) taken.add(entry);
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
