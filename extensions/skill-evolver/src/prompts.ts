import type { NewSkillCandidate, RewriteCandidate, TaskSummary } from './types';

// Per-transcript content cap. Skills are about *how to approach* a task — full
// responses bloat the prompt without adding signal. 600 chars covers prompt +
// the start of any code/answer.
const TRANSCRIPT_CHAR_CAP = 600;

function clip(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n).trimEnd()}…`;
}

function renderTaskBlock(t: TaskSummary, idx: number): string {
  return [
    `### Task ${idx + 1} (id: ${t.taskId}, score: ${t.score.toFixed(2)})`,
    `**Prompt:** ${clip(t.prompt, TRANSCRIPT_CHAR_CAP)}`,
    `**Response:** ${clip(t.response, TRANSCRIPT_CHAR_CAP)}`,
  ].join('\n');
}

const SKILL_FORMAT_GUIDE = [
  'A skill is a short markdown file (typically 80-300 words) that gets injected into',
  'the agent system prompt. It guides *how* the agent should approach a class of',
  'task. Skills should be:',
  '- Imperative and concrete ("When asked to X, do Y")',
  '- Free of meta-commentary ("This skill helps you...") — the agent does not narrate',
  '- Free of frontmatter, headings deeper than `##`, or links',
  '- A standalone instruction, not a tutorial',
].join('\n');

export function renderRewritePrompt(candidate: RewriteCandidate): string {
  const transcripts = candidate.lowScoringTasks.map((t, i) => renderTaskBlock(t, i)).join('\n\n');

  return [
    'You are improving an underperforming agent skill.',
    '',
    `The skill below has averaged a score of ${candidate.stats.avgScore.toFixed(2)} across`,
    `${candidate.stats.runs} runs in our eval harness (1.0 = perfect, 0.0 = wrong).`,
    'Below the current skill are the lowest-scoring task transcripts where this skill was active.',
    'Rewrite the skill to address the failure modes you see in those transcripts.',
    '',
    '## Current skill',
    '',
    candidate.currentContent.trim(),
    '',
    '## Low-scoring transcripts',
    '',
    transcripts,
    '',
    '## Format requirements',
    '',
    SKILL_FORMAT_GUIDE,
    '',
    'Output ONLY the rewritten skill, wrapped in <skill>...</skill> tags. No preamble, no explanation.',
    'If the transcripts do not reveal a fixable pattern (e.g., the failures are unrelated to',
    'this skill), output exactly NO_REWRITE on its own line.',
  ].join('\n');
}

export function renderNewSkillPrompt(candidate: NewSkillCandidate): string {
  const transcripts = candidate.tasks.map((t, i) => renderTaskBlock(t, i)).join('\n\n');

  return [
    'You are synthesizing a new agent skill from successful task completions.',
    '',
    `The ${candidate.tasks.length} task(s) below scored highly in our eval harness even though`,
    'no skill was active. Look for a *generalizable approach* that the agent stumbled into',
    'and could be codified as an explicit skill — not a fact, not a one-off solution.',
    '',
    '## High-scoring transcripts (no skill was active)',
    '',
    transcripts,
    '',
    '## Format requirements',
    '',
    SKILL_FORMAT_GUIDE,
    '',
    'Output the new skill in this exact shape:',
    '',
    '<filename>some-kebab-case-name.md</filename>',
    '<skill>',
    '...markdown body...',
    '</skill>',
    '',
    'The filename must be kebab-case, end in .md, and describe the skill (e.g., "json-schema-design.md").',
    '',
    'If the tasks are too dissimilar or the success looks accidental rather than methodological,',
    'output exactly NO_PATTERN on its own line.',
  ].join('\n');
}

export interface ParsedRewrite {
  kind: 'rewrite';
  content: string;
}
export interface ParsedSkip {
  kind: 'skip';
  reason: string;
}
export interface ParsedNewSkill {
  kind: 'new';
  fileName: string;
  content: string;
}

export function parseRewriteResponse(raw: string): ParsedRewrite | ParsedSkip {
  const trimmed = raw.trim();
  if (trimmed === 'NO_REWRITE') return { kind: 'skip', reason: 'NO_REWRITE' };
  const match = trimmed.match(/<skill>([\s\S]*?)<\/skill>/);
  if (!match) return { kind: 'skip', reason: 'malformed-output' };
  const content = (match[1] ?? '').trim();
  if (!content) return { kind: 'skip', reason: 'empty-skill' };
  return { kind: 'rewrite', content };
}

export function parseNewSkillResponse(raw: string): ParsedNewSkill | ParsedSkip {
  const trimmed = raw.trim();
  if (trimmed === 'NO_PATTERN') return { kind: 'skip', reason: 'NO_PATTERN' };
  const fileMatch = trimmed.match(/<filename>([\s\S]*?)<\/filename>/);
  const skillMatch = trimmed.match(/<skill>([\s\S]*?)<\/skill>/);
  if (!fileMatch || !skillMatch) return { kind: 'skip', reason: 'malformed-output' };
  const fileName = (fileMatch[1] ?? '').trim();
  const content = (skillMatch[1] ?? '').trim();
  if (!isSafeKebabFilename(fileName)) return { kind: 'skip', reason: 'invalid-filename' };
  if (!content) return { kind: 'skip', reason: 'empty-skill' };
  return { kind: 'new', fileName, content };
}

function isSafeKebabFilename(name: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.test(name);
}
