import type { MemoryProvider, SessionStore, Tool, ToolResult } from '@ethosagent/types';

// ---------------------------------------------------------------------------
// memory_read
// ---------------------------------------------------------------------------

export function createMemoryReadTool(memory: MemoryProvider): Tool {
  return {
    name: 'memory_read',
    description:
      'Read the current memory files (MEMORY.md and USER.md). Use to recall past context, user preferences, or project notes before starting a new task.',
    toolset: 'memory',
    maxResultChars: 20_000,
    schema: {
      type: 'object',
      properties: {
        store: {
          type: 'string',
          enum: ['memory', 'user', 'both'],
          description: 'Which memory file to read (default: both)',
        },
      },
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { store = 'both' } = args as { store?: 'memory' | 'user' | 'both' };

      const result = await memory.prefetch({
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        platform: ctx.platform,
        workingDir: ctx.workingDir,
        personalityId: ctx.personalityId,
        memoryScope: ctx.memoryScope,
      });

      if (!result) {
        return { ok: true, value: 'Memory is empty. No notes recorded yet.' };
      }

      // Filter by requested store
      if (store === 'memory') {
        const memSection = extractSection(result.content, '## Memory');
        return { ok: true, value: memSection ?? 'MEMORY.md is empty.' };
      }
      if (store === 'user') {
        const userSection = extractSection(result.content, '## About You');
        return { ok: true, value: userSection ?? 'USER.md is empty.' };
      }

      return {
        ok: true,
        value: result.truncated ? `${result.content}\n\n[truncated]` : result.content,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// memory_write
// ---------------------------------------------------------------------------

export function createMemoryWriteTool(memory: MemoryProvider): Tool {
  return {
    name: 'memory_write',
    description:
      'Update the memory files. Use "add" to append a new fact, "replace" to overwrite the entire file, "remove" to delete a specific line. The "memory" store holds project context; "user" holds information about the user.',
    toolset: 'memory',
    schema: {
      type: 'object',
      properties: {
        store: {
          type: 'string',
          enum: ['memory', 'user'],
          description: 'Which file to update: "memory" = MEMORY.md, "user" = USER.md',
        },
        action: {
          type: 'string',
          enum: ['add', 'replace', 'remove'],
          description: '"add" appends, "replace" overwrites, "remove" deletes matching lines',
        },
        content: {
          type: 'string',
          description: 'Content to add/replace (or the line to search for when action="remove")',
        },
        substring_match: {
          type: 'string',
          description: 'For action="remove": delete lines containing this substring',
        },
      },
      required: ['store', 'action', 'content'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { store, action, content, substring_match } = args as {
        store: 'memory' | 'user';
        action: 'add' | 'replace' | 'remove';
        content: string;
        substring_match?: string;
      };

      if (!store || !['memory', 'user'].includes(store)) {
        return { ok: false, error: 'store must be "memory" or "user"', code: 'input_invalid' };
      }
      if (!action || !['add', 'replace', 'remove'].includes(action)) {
        return {
          ok: false,
          error: 'action must be "add", "replace", or "remove"',
          code: 'input_invalid',
        };
      }

      const syncCtx = {
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey,
        platform: ctx.platform,
        workingDir: ctx.workingDir,
        personalityId: ctx.personalityId,
        memoryScope: ctx.memoryScope,
      };

      await memory.sync(syncCtx, [
        {
          store,
          action,
          content,
          substringMatch: substring_match,
        },
      ]);

      const label = store === 'memory' ? 'MEMORY.md' : 'USER.md';
      const verb = action === 'add' ? 'Appended to' : action === 'replace' ? 'Replaced' : 'Updated';
      return { ok: true, value: `${verb} ${label}` };
    },
  };
}

// ---------------------------------------------------------------------------
// session_search
// ---------------------------------------------------------------------------

export function createSessionSearchTool(session: SessionStore): Tool {
  return {
    name: 'session_search',
    description:
      'Search the session history using full-text search. Returns messages matching the query across all sessions.',
    toolset: 'memory',
    maxResultChars: 10_000,
    schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: {
          type: 'number',
          description: 'Maximum number of results (default 10)',
        },
      },
      required: ['query'],
    },
    async execute(args, ctx): Promise<ToolResult> {
      const { query, limit } = args as { query: string; limit?: number };

      if (!query) return { ok: false, error: 'query is required', code: 'input_invalid' };

      const results = await session.search(query, {
        limit: Math.min(limit ?? 10, 50),
        sessionId: ctx.sessionId,
      });

      if (results.length === 0) {
        return { ok: true, value: `No session history matches "${query}"` };
      }

      const formatted = results
        .map((r, i) => `${i + 1}. [${r.timestamp.toISOString().slice(0, 16)}] ${r.snippet}`)
        .join('\n\n');

      return {
        ok: true,
        value: `${results.length} result${results.length === 1 ? '' : 's'} for "${query}":\n\n${formatted}`,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMemoryTools(memory: MemoryProvider, session: SessionStore): Tool[] {
  return [
    createMemoryReadTool(memory),
    createMemoryWriteTool(memory),
    createSessionSearchTool(session),
  ];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractSection(content: string, header: string): string | null {
  const idx = content.indexOf(header);
  if (idx < 0) return null;
  const nextHeader = content.indexOf('\n## ', idx + 1);
  const section = nextHeader > 0 ? content.slice(idx, nextHeader) : content.slice(idx);
  return section.trim() || null;
}
