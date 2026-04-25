---
sidebar_position: 5
title: Custom Memory Providers
---

# Custom Memory Providers

The default memory provider reads and writes two Markdown files: `MEMORY.md` (rolling project context) and `USER.md` (who you are). If you need a different backend — a database, a vector store, a remote API — you can implement `MemoryProvider` and swap it in.

## The `MemoryProvider` interface

```typescript
interface MemoryProvider {
  prefetch(sessionId: string, personality?: string): Promise<MemoryContext | null>;
  sync(sessionId: string, updates: MemoryUpdate[], personality?: string): Promise<void>;
}

interface MemoryContext {
  projectMemory: string | null;
  userMemory: string | null;
}

type MemoryUpdate =
  | { action: 'add';     content: string }
  | { action: 'replace'; content: string }
  | { action: 'remove';  substringMatch: string }
```

`prefetch()` runs at the start of each turn to load memory into the system prompt. Return `null` if there's nothing to inject — the system prompt is built without a memory section.

`sync()` runs after each turn to apply the updates the LLM decided to make. Updates are incremental by default (`add`) but can overwrite (`replace`) or delete lines (`remove`).

## Example: PostgreSQL provider

```typescript
import { Pool } from 'pg';
import type { MemoryProvider, MemoryContext, MemoryUpdate } from '@ethosagent/types';

export class PostgresMemoryProvider implements MemoryProvider {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({ connectionString });
  }

  async prefetch(sessionId: string, personality?: string): Promise<MemoryContext | null> {
    const key = personality ? `${sessionId}:${personality}` : sessionId;
    const res = await this.pool.query(
      'SELECT project_memory, user_memory FROM memory WHERE key = $1',
      [key],
    );
    if (res.rows.length === 0) return null;
    return {
      projectMemory: res.rows[0].project_memory ?? null,
      userMemory: res.rows[0].user_memory ?? null,
    };
  }

  async sync(sessionId: string, updates: MemoryUpdate[], personality?: string): Promise<void> {
    const key = personality ? `${sessionId}:${personality}` : sessionId;
    const current = await this.prefetch(sessionId, personality);
    let projectMemory = current?.projectMemory ?? '';

    for (const update of updates) {
      if (update.action === 'add') {
        projectMemory += '\n' + update.content;
      } else if (update.action === 'replace') {
        projectMemory = update.content;
      } else if (update.action === 'remove') {
        projectMemory = projectMemory
          .split('\n')
          .filter(line => !line.includes(update.substringMatch))
          .join('\n');
      }
    }

    await this.pool.query(
      `INSERT INTO memory (key, project_memory) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET project_memory = $2, updated_at = NOW()`,
      [key, projectMemory.trim() || null],
    );
  }
}
```

## Wiring it in

```typescript
import { PostgresMemoryProvider } from './postgres-memory';

const loop = new AgentLoop({
  ...config,
  memoryProvider: new PostgresMemoryProvider(process.env.DATABASE_URL!),
});
```

## Memory scope and personality isolation

The `personality` argument in `prefetch()` and `sync()` supports the `per-personality` memory scope. When a personality has `memoryScope: per-personality`, the agent calls these methods with the personality ID — so each personality gets its own isolated memory bucket.

When `memoryScope: global`, the agent passes `undefined` for personality — all personalities share the same memory.

Your implementation decides what to do with the personality argument. The simplest approach is to use `${sessionId}:${personality}` as the storage key when personality is present, and just `sessionId` when it's not.

## Vector memory

For semantic search over long conversation histories, a vector store provider looks like:

```typescript
async prefetch(sessionId: string): Promise<MemoryContext | null> {
  // Embed the current turn's likely query (passed via sessionId convention or ctx)
  // Retrieve top-K semantically relevant memories
  const results = await vectorStore.search(sessionId, { topK: 5 });
  return {
    projectMemory: results.map(r => r.content).join('\n\n'),
    userMemory: null,
  };
}
```

The interface doesn't expose the current query — if you need it, use a wrapper that accepts it as a constructor arg or read it from a context you manage.

## Performance notes

`prefetch()` runs on every turn, before the LLM call. Keep it fast:

- Cache frequently-read memory in memory (hot path)
- Use indexes on `sessionId` + `personality`
- Return `null` immediately when the store is empty — don't make the LLM prompt include an empty section
