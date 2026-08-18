import { describe, expect, it } from 'vitest';
import {
  NotificationGate,
  type TerminalNotifierRunFn,
  type TerminalNotifierRunResult,
} from '../notification';
import type { PreflightResult } from '../preflight';

function availablePreflight(): Promise<PreflightResult> {
  return Promise.resolve({ available: true });
}

function makeFakeRun(behavior?: (args: string[]) => TerminalNotifierRunResult) {
  const calls: string[][] = [];
  const runFn: TerminalNotifierRunFn = async (args) => {
    calls.push(args);
    return behavior ? behavior(args) : { ok: true };
  };
  return { runFn, calls };
}

/** Extracts the click-listener URL from the `-execute "curl -fsS <url>"` arg
 * a captured `-show` call was invoked with. */
function urlFromShowCall(args: string[]): string {
  const execIndex = args.indexOf('-execute');
  const execCommand = args[execIndex + 1] ?? '';
  return execCommand.replace(/^curl -fsS /, '');
}

describe('NotificationGate.presentCaptureOffer', () => {
  it('resolves accepted when the click-listener URL is hit', async () => {
    const { runFn, calls } = makeFakeRun();
    const gate = new NotificationGate({ runFn, checkAvailable: availablePreflight });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-1',
      title: 'Ethos',
      message: 'call detected',
    });

    await fetch(urlFromShowCall(calls[0]));

    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'accepted' });
  });

  it('expire() resolves expired and issues terminal-notifier -remove with the group id', async () => {
    const { runFn, calls } = makeFakeRun();
    const gate = new NotificationGate({ runFn, checkAvailable: availablePreflight });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-2',
      title: 'Ethos',
      message: 'call detected',
    });

    await handle.expire();

    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'expired' });
    const removeCall = calls.find((args) => args[0] === '-remove');
    expect(removeCall).toEqual(['-remove', 'ethos-callcapture-call-2']);
  });

  it('expire() after acceptance is a no-op and does not flip the outcome', async () => {
    const { runFn, calls } = makeFakeRun();
    const gate = new NotificationGate({ runFn, checkAvailable: availablePreflight });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-2b',
      title: 'Ethos',
      message: 'call detected',
    });

    await fetch(urlFromShowCall(calls[0]));
    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'accepted' });

    await handle.expire();

    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'accepted' });
    expect(calls.find((args) => args[0] === '-remove')).toBeUndefined();
  });

  it('resolves the error outcome when terminal-notifier is unavailable, never throws', async () => {
    const { runFn } = makeFakeRun();
    const gate = new NotificationGate({
      runFn,
      checkAvailable: () =>
        Promise.resolve({ available: false, error: 'terminal-notifier not found on PATH' }),
    });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-3',
      title: 'Ethos',
      message: 'call detected',
    });

    await expect(handle.waitForOutcome()).resolves.toEqual({
      outcome: 'error',
      message: 'terminal-notifier not found on PATH',
    });
  });

  it('resolves the error outcome when the show command itself fails to spawn/deliver', async () => {
    const { runFn } = makeFakeRun((args) =>
      args[0] === '-remove' ? { ok: true } : { ok: false, error: 'spawn ENOENT' },
    );
    const gate = new NotificationGate({ runFn, checkAvailable: availablePreflight });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-4',
      title: 'Ethos',
      message: 'call detected',
    });

    await expect(handle.waitForOutcome()).resolves.toEqual({
      outcome: 'error',
      message: 'spawn ENOENT',
    });
  });

  it('gives two independent offers independent group ids that do not cross-resolve', async () => {
    const { runFn, calls } = makeFakeRun();
    const gate = new NotificationGate({ runFn, checkAvailable: availablePreflight });

    const handleA = await gate.presentCaptureOffer({
      callId: 'call-a',
      title: 't',
      message: 'm',
    });
    const handleB = await gate.presentCaptureOffer({
      callId: 'call-b',
      title: 't',
      message: 'm',
    });

    const groupIds = calls
      .filter((args) => args.includes('-group'))
      .map((args) => args[args.indexOf('-group') + 1]);
    expect(new Set(groupIds).size).toBe(2);

    await fetch(urlFromShowCall(calls[0]));
    await expect(handleA.waitForOutcome()).resolves.toEqual({ outcome: 'accepted' });

    let bSettled = false;
    handleB.waitForOutcome().then(() => {
      bSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bSettled).toBe(false);

    await handleB.expire();
    await expect(handleB.waitForOutcome()).resolves.toEqual({ outcome: 'expired' });
  });
});
