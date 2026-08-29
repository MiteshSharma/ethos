// Verifies the Lane B post-review fix: runSupervisor's Dispatcher is built
// with a real, live HookRegistry (not `hooks: undefined`), and that firing
// the three hooks Dispatcher.tick() actually fires from this process
// (ticket_claimed, ticket_stale_reclaimed, dispatch_tick) invokes the
// framework-internal logging handlers registerDispatcherHookLogging wires up.
//
// runSupervisor itself spawns child processes, acquires a PID file, and
// blocks forever, so it isn't a practical target for a unit test (see
// supervisor-crash.test.ts / supervisor-launch.test.ts for the same
// extract-and-test-directly pattern used elsewhere in this file's siblings).
// This test instead drives registerDispatcherHookLogging — the exact
// function runSupervisor calls — against a real DefaultHookRegistry.

import { DefaultHookRegistry } from '@ethosagent/core';
import type { Logger } from '@ethosagent/types';
import { describe, expect, it, vi } from 'vitest';
import { registerDispatcherHookLogging } from '../supervisor';

describe('registerDispatcherHookLogging', () => {
  function makeLogger() {
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
    logger.child.mockReturnValue(logger);
    return logger as unknown as Logger & typeof logger;
  }

  it('registers handlers on a real HookRegistry, not a stub', async () => {
    const hooks = new DefaultHookRegistry();
    const logger = makeLogger();

    // Sanity: a genuinely empty registry fires void hooks to zero listeners
    // without throwing or logging anything.
    await hooks.fireVoid('ticket_claimed', { taskId: 't1', assignee: 'engineer', runId: 'r1' });
    expect(logger.debug).not.toHaveBeenCalled();

    registerDispatcherHookLogging(hooks, logger, 'acme');
    await hooks.fireVoid('ticket_claimed', { taskId: 't2', assignee: 'engineer', runId: 'r2' });
    expect(logger.debug).toHaveBeenCalledTimes(1);
  });

  it('logs ticket_claimed with recognizable task/assignee/run content', async () => {
    const hooks = new DefaultHookRegistry();
    const logger = makeLogger();
    registerDispatcherHookLogging(hooks, logger, 'acme');

    await hooks.fireVoid('ticket_claimed', {
      taskId: 'task-1',
      assignee: 'engineer',
      runId: 'run-1',
    });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.debug.mock.calls[0] ?? [];
    expect(message).toContain('task-1');
    expect(message).toContain('engineer');
    expect(meta).toMatchObject({
      team: 'acme',
      taskId: 'task-1',
      assignee: 'engineer',
      runId: 'run-1',
    });
  });

  it('logs ticket_stale_reclaimed with recognizable task/reason content', async () => {
    const hooks = new DefaultHookRegistry();
    const logger = makeLogger();
    registerDispatcherHookLogging(hooks, logger, 'acme');

    await hooks.fireVoid('ticket_stale_reclaimed', {
      taskId: 'task-2',
      previousAssignee: 'researcher',
      reason: 'orphan_stale',
    });

    expect(logger.info).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.info.mock.calls[0] ?? [];
    expect(message).toContain('task-2');
    expect(message).toContain('orphan_stale');
    expect(meta).toMatchObject({
      team: 'acme',
      taskId: 'task-2',
      previousAssignee: 'researcher',
      reason: 'orphan_stale',
    });
  });

  it('logs dispatch_tick with recognizable claimed/reclaimed counts', async () => {
    const hooks = new DefaultHookRegistry();
    const logger = makeLogger();
    registerDispatcherHookLogging(hooks, logger, 'acme');

    await hooks.fireVoid('dispatch_tick', { teamId: 'acme', claimedCount: 2, reclaimedCount: 1 });

    expect(logger.debug).toHaveBeenCalledTimes(1);
    const [message, meta] = logger.debug.mock.calls[0] ?? [];
    expect(message).toContain('claimed=2');
    expect(message).toContain('reclaimed=1');
    expect(meta).toMatchObject({ team: 'acme', claimedCount: 2, reclaimedCount: 1 });
  });
});
