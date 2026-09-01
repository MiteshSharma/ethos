// `kanban.maxInProgress` / `kanban.maxInProgressPerProfile` — WIP caps enforced
// on the transition into `running`, the only transition that opens a run.

import { describe, expect, it } from 'vitest';
import { KanbanStore } from '../index';

describe('KanbanStore WIP limits', () => {
  it('lets claims through until the global cap, then rejects the excess', () => {
    const store = new KanbanStore(':memory:', { maxInProgress: 2 });
    try {
      const a = store.createTask({ title: 'a' });
      const b = store.createTask({ title: 'b' });
      const c = store.createTask({ title: 'c' });

      expect(store.updateStatus(a.id, 'running').status).toBe('running');
      expect(store.updateStatus(b.id, 'running').status).toBe('running');
      expect(() => store.updateStatus(c.id, 'running')).toThrow(/WIP limit reached/);

      // The refused task is untouched — not claimed, no run opened.
      const refused = store.getTask(c.id);
      expect(refused?.status).toBe('todo');
      expect(refused?.currentRunId).toBeNull();
      expect(store.listTasks({ status: 'running' })).toHaveLength(2);
    } finally {
      store.close();
    }
  });

  it('frees a slot when a running task leaves running', () => {
    const store = new KanbanStore(':memory:', { maxInProgress: 1 });
    try {
      const a = store.createTask({ title: 'a' });
      const b = store.createTask({ title: 'b' });
      store.updateStatus(a.id, 'running');
      expect(() => store.updateStatus(b.id, 'running')).toThrow(/WIP limit reached/);

      store.updateStatus(a.id, 'done');
      expect(store.updateStatus(b.id, 'running').status).toBe('running');
    } finally {
      store.close();
    }
  });

  it('caps per assignee independently of other assignees', () => {
    const store = new KanbanStore(':memory:', { maxInProgressPerProfile: 1 });
    try {
      const a1 = store.createTask({ title: 'a1', assignee: 'engineer' });
      const a2 = store.createTask({ title: 'a2', assignee: 'engineer' });
      const b1 = store.createTask({ title: 'b1', assignee: 'researcher' });

      expect(store.updateStatus(a1.id, 'running').status).toBe('running');
      expect(() => store.updateStatus(a2.id, 'running')).toThrow(/WIP limit reached for engineer/);
      // A different profile still has its own slot.
      expect(store.updateStatus(b1.id, 'running').status).toBe('running');
    } finally {
      store.close();
    }
  });

  it('never counts an unassigned task against the per-profile cap', () => {
    const store = new KanbanStore(':memory:', { maxInProgressPerProfile: 1 });
    try {
      const a = store.createTask({ title: 'a' });
      const b = store.createTask({ title: 'b' });
      expect(store.updateStatus(a.id, 'running').status).toBe('running');
      expect(store.updateStatus(b.id, 'running').status).toBe('running');
    } finally {
      store.close();
    }
  });

  it('is uncapped when neither option is set (unchanged behaviour)', () => {
    const store = new KanbanStore(':memory:');
    try {
      for (let i = 0; i < 5; i++) {
        const t = store.createTask({ title: `t${i}`, assignee: 'engineer' });
        expect(store.updateStatus(t.id, 'running').status).toBe('running');
      }
      expect(store.listTasks({ status: 'running' })).toHaveLength(5);
    } finally {
      store.close();
    }
  });
});
