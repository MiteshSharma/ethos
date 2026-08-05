import type { AfterTicketRevisionPayload, HookRegistry, MemoryProvider } from '@ethosagent/types';

export interface PostmortemHandlerOptions {
  teamName: string;
  memory: MemoryProvider;
  hooks: HookRegistry;
}

export function registerPostmortemHandler(opts: PostmortemHandlerOptions): () => void {
  const { teamName, memory, hooks } = opts;
  const ctx = {
    scopeId: `team:${teamName}`,
    sessionId: 'postmortem',
    sessionKey: 'postmortem',
    platform: 'system' as const,
    workingDir: '',
  };

  return hooks.registerVoid(
    'after_ticket_revision',
    async (payload: AfterTicketRevisionPayload) => {
      // Flat key, no `/`: memory keys are file names within the scope dir and
      // path separators are rejected by the provider.
      const key = `postmortem-${payload.taskId}.md`;
      const shortId = payload.taskId.slice(0, 8);
      const content = [
        `# ${shortId} — needs revision`,
        '',
        `**Ticket:** ${payload.taskId}`,
        `**Assignee:** ${payload.assignee}`,
        ...(payload.autonomyTier
          ? [`**Tier:** ${payload.autonomyTier} (ratio ${(payload.successRatio ?? 0).toFixed(2)})`]
          : []),
        `**Why it bounced:** ${payload.reason}`,
        '',
        `**Summary submitted:** ${payload.summary}`,
        ...(payload.acceptanceCriteria
          ? ['', `**Acceptance criteria:** ${payload.acceptanceCriteria}`]
          : []),
        '',
      ].join('\n');

      await memory.sync([{ action: 'replace', key, content }], ctx);
    },
  );
}
