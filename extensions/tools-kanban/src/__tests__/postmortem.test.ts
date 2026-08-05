import { DefaultHookRegistry } from '@ethosagent/core';
import type {
  AfterTicketRevisionPayload,
  MemoryContext,
  MemoryEntry,
  MemoryEntryRef,
  MemoryProvider,
  MemoryUpdate,
} from '@ethosagent/types';
import { beforeEach, describe, expect, it } from 'vitest';
import { registerPostmortemHandler } from '../postmortem';

class StubMemoryProvider implements MemoryProvider {
  readonly entries = new Map<string, string>();

  async prefetch(_ctx: MemoryContext) {
    return null;
  }

  async read(key: string, _ctx: MemoryContext): Promise<MemoryEntry | null> {
    const content = this.entries.get(key);
    if (content === undefined) return null;
    return { key, content };
  }

  async search(_query: string, _ctx: MemoryContext) {
    return [];
  }

  async sync(updates: MemoryUpdate[], _ctx: MemoryContext) {
    for (const u of updates) {
      // Faithful double: real providers reject keys outside this charset
      // (see isSafeKey in @ethosagent/memory-markdown). A permissive stub is
      // why the `postmortems/<id>.md` key shipped writing to nowhere.
      if (!/^[a-zA-Z0-9_.-]+$/.test(u.key) || u.key.includes('..') || u.key.startsWith('.')) {
        throw new Error(`unsafe memory key: ${u.key}`);
      }
      if (u.action === 'replace') {
        this.entries.set(u.key, u.content);
      }
    }
  }

  async list(_ctx: MemoryContext): Promise<MemoryEntryRef[]> {
    return [...this.entries.keys()].map((key) => ({ key }));
  }
}

describe('postmortem handler', () => {
  let hooks: DefaultHookRegistry;
  let memory: StubMemoryProvider;

  beforeEach(() => {
    hooks = new DefaultHookRegistry();
    memory = new StubMemoryProvider();
  });

  const payload: AfterTicketRevisionPayload = {
    taskId: 'bda3f812',
    summary: 'Implemented OAuth refresh flow',
    acceptanceCriteria: 'no refresh tokens in logs',
    reason: 'logger middleware was logging full request body',
    assignee: 'engineer',
  };

  it('writes postmortem to team memory on revision', async () => {
    registerPostmortemHandler({ teamName: 'myteam', memory, hooks });
    await hooks.fireVoid('after_ticket_revision', payload);

    const key = 'postmortem-bda3f812.md';
    const content = memory.entries.get(key);
    expect(content).toBeDefined();
    expect(content).toContain('bda3f812 — needs revision');
    expect(content).toContain('**Assignee:** engineer');
    expect(content).toContain('logger middleware was logging full request body');
    expect(content).toContain('no refresh tokens in logs');
  });

  it('omits acceptance criteria when not set', async () => {
    registerPostmortemHandler({ teamName: 'myteam', memory, hooks });
    const { acceptanceCriteria: _, ...noAc } = payload;
    await hooks.fireVoid('after_ticket_revision', noAc as AfterTicketRevisionPayload);

    const key = 'postmortem-bda3f812.md';
    const content = memory.entries.get(key);
    expect(content).toBeDefined();
    expect(content).not.toContain('Acceptance criteria');
  });

  it('uses a key the memory provider accepts (no path separators)', async () => {
    registerPostmortemHandler({ teamName: 'myteam', memory, hooks });
    await hooks.fireVoid('after_ticket_revision', payload);

    const keys = [...memory.entries.keys()];
    expect(keys.length).toBe(1);
    for (const key of keys) {
      expect(key).not.toContain('/');
      expect(key).toMatch(/^[a-zA-Z0-9_.-]+$/);
    }
  });

  it('does not fire when handler is not registered', async () => {
    await hooks.fireVoid('after_ticket_revision', payload);
    expect(memory.entries.size).toBe(0);
  });
});
