import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleLogger, NoopLogger, noopLogger } from '../index';

describe('NoopLogger', () => {
  it('silently swallows every level', () => {
    const log = new NoopLogger();
    // No assertions on output — the contract is "doesn't throw, doesn't write".
    // Vitest will surface any unexpected console writes through its own redirects.
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
  });

  it('child() returns a no-op logger that ignores meta', () => {
    const log = new NoopLogger();
    const child = log.child({ component: 'whatever' });
    expect(child).toBeInstanceOf(NoopLogger);
  });

  it('exports a singleton', () => {
    expect(noopLogger).toBeInstanceOf(NoopLogger);
  });
});

describe('ConsoleLogger', () => {
  const spies = {
    log: vi.spyOn(console, 'log'),
    warn: vi.spyOn(console, 'warn'),
    error: vi.spyOn(console, 'error'),
    debug: vi.spyOn(console, 'debug'),
  };

  beforeEach(() => {
    for (const spy of Object.values(spies)) {
      spy.mockClear();
      spy.mockImplementation(() => {});
    }
  });

  afterEach(() => {
    for (const spy of Object.values(spies)) {
      spy.mockClear();
    }
  });

  it('routes each level to the matching console method', () => {
    const log = new ConsoleLogger();
    log.info('hello info');
    log.warn('hello warn');
    log.error('hello error');
    log.debug('hello debug');

    expect(spies.log).toHaveBeenCalledWith('hello info');
    expect(spies.warn).toHaveBeenCalledWith('hello warn');
    expect(spies.error).toHaveBeenCalledWith('hello error');
    expect(spies.debug).toHaveBeenCalledWith('hello debug');
  });

  it('prefixes with [component] when meta.component is set', () => {
    const log = new ConsoleLogger({ component: 'cron' });
    log.warn('clock skewed');
    expect(spies.warn).toHaveBeenCalledWith('[cron] clock skewed');
  });

  it('child() merges base meta with new meta', () => {
    const base = new ConsoleLogger({ component: 'parent' });
    const child = base.child({ component: 'child' });
    child.info('hello');
    expect(spies.log).toHaveBeenCalledWith('[child] hello');
  });

  it('renders non-component meta as key=value suffix', () => {
    const log = new ConsoleLogger({ component: 'cron' });
    log.warn('job late', { jobId: 'sweep', delayMs: 250 });
    expect(spies.warn).toHaveBeenCalledWith('[cron] job late jobId=sweep delayMs=250');
  });

  it('renders err meta as a stack-bearing line', () => {
    const log = new ConsoleLogger();
    const err = new Error('boom');
    err.stack = 'Error: boom\n    at /fake/path:1:1';
    log.error('caught', { err });
    expect(spies.error).toHaveBeenCalledWith('caught Error: boom\n    at /fake/path:1:1');
  });

  it('renders non-Error err values via formatValue fallback', () => {
    const log = new ConsoleLogger();
    log.error('strange', { err: 'a string' });
    expect(spies.error).toHaveBeenCalledWith('strange err=a string');
  });
});

describe('ConsoleLogger — logs.level gate', () => {
  const spies = {
    log: vi.spyOn(console, 'log'),
    warn: vi.spyOn(console, 'warn'),
    error: vi.spyOn(console, 'error'),
    debug: vi.spyOn(console, 'debug'),
  };

  beforeEach(() => {
    for (const spy of Object.values(spies)) {
      spy.mockClear();
      spy.mockImplementation(() => {});
    }
  });

  afterEach(() => {
    for (const spy of Object.values(spies)) {
      spy.mockClear();
    }
  });

  it("level 'warn' suppresses debug and info but still prints warn and error", () => {
    const log = new ConsoleLogger({}, 'warn');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledWith('w');
    expect(spies.error).toHaveBeenCalledWith('e');
  });

  it("level 'error' suppresses everything below error", () => {
    const log = new ConsoleLogger({}, 'error');
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(spies.debug).not.toHaveBeenCalled();
    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.warn).not.toHaveBeenCalled();
    expect(spies.error).toHaveBeenCalledWith('e');
  });

  it('defaults to printing every level, exactly as before the gate existed', () => {
    const log = new ConsoleLogger();
    log.debug('d');
    log.info('i');
    log.warn('w');
    log.error('e');

    expect(spies.debug).toHaveBeenCalledWith('d');
    expect(spies.log).toHaveBeenCalledWith('i');
    expect(spies.warn).toHaveBeenCalledWith('w');
    expect(spies.error).toHaveBeenCalledWith('e');
  });

  it('child() inherits the parent level', () => {
    const child = new ConsoleLogger({ component: 'cron' }, 'warn').child({ jobId: 'sweep' });
    child.info('quiet');
    child.warn('loud');

    expect(spies.log).not.toHaveBeenCalled();
    expect(spies.warn).toHaveBeenCalledWith('[cron] loud jobId=sweep');
  });
});
