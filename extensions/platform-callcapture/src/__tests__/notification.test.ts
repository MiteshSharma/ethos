import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { type CaptureOfferCardChild, NotificationGate } from '../notification';

/** Fake spawned child — a real `Readable` (so `readline` works against it
 * unmodified) plus the minimal exit/error/kill surface `NotificationGate`
 * needs. Mirrors `detector.test.ts`'s `FakeChild` idiom exactly (this
 * package's established fake-`SpawnedChild` pattern), extended with
 * `killedWith` since `expire()`'s SIGTERM-is-the-whole-dismiss-protocol
 * design (see notification.ts's header comment) needs to be observable. */
class FakeChild implements CaptureOfferCardChild {
  readonly stdout = new Readable({ read() {} });
  readonly killedWith: NodeJS.Signals[] = [];
  private readonly exitHandlers: Array<
    (code: number | null, signal: NodeJS.Signals | null) => void
  > = [];
  private readonly errorHandlers: Array<(err: Error) => void> = [];

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): void {
    this.exitHandlers.push(listener);
  }

  onError(listener: (err: Error) => void): void {
    this.errorHandlers.push(listener);
  }

  kill(signal?: NodeJS.Signals): void {
    this.killedWith.push(signal ?? 'SIGTERM');
  }

  emitLine(line: unknown): void {
    this.stdout.push(`${JSON.stringify(line)}\n`);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const h of this.exitHandlers) h(code, signal);
  }

  emitProcessError(err: Error): void {
    for (const h of this.errorHandlers) h(err);
  }
}

function makeFakeSpawn() {
  const children: FakeChild[] = [];
  const calls: { binaryPath: string; args: string[] }[] = [];
  const spawnFn = (binaryPath: string, args: string[]): CaptureOfferCardChild => {
    calls.push({ binaryPath, args });
    const child = new FakeChild();
    children.push(child);
    return child;
  };
  return { spawnFn, children, calls };
}

describe('NotificationGate.presentCaptureOffer', () => {
  it('resolves accepted when the card emits an accepted line', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const gate = new NotificationGate({ spawnFn });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-1',
      title: 'Ethos',
      message: 'call detected',
    });

    children[0]?.emitLine({ event: 'ready' });
    children[0]?.emitLine({ event: 'accepted', callId: 'call-1' });

    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'accepted' });
  });

  it('passes callId and source as argv, in that order', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const gate = new NotificationGate({ spawnFn });

    await gate.presentCaptureOffer({
      callId: 'call-x',
      title: 'Ethos',
      message: 'call detected',
      source: 'zoom',
    });

    expect(calls[0]?.args).toEqual(['call-x', 'zoom']);
  });

  it('passes an empty string for source when none is given', async () => {
    const { spawnFn, calls } = makeFakeSpawn();
    const gate = new NotificationGate({ spawnFn });

    await gate.presentCaptureOffer({ callId: 'call-y', title: 'Ethos', message: 'call detected' });

    expect(calls[0]?.args).toEqual(['call-y', '']);
  });

  it('resolves expired (not a new outcome) when the card reports an explicit decline', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const gate = new NotificationGate({ spawnFn });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-decline',
      title: 'Ethos',
      message: 'call detected',
    });
    children[0]?.emitLine({ event: 'declined', callId: 'call-decline' });

    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'expired' });
  });

  it('expire() sends SIGTERM, waits for exit, and resolves expired', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const gate = new NotificationGate({ spawnFn });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-2',
      title: 'Ethos',
      message: 'call detected',
    });

    const expirePromise = handle.expire();
    expect(children[0]?.killedWith).toEqual(['SIGTERM']);
    // expire() awaits the child's own exit before resolving — it must not
    // settle just from sending the signal.
    let expireSettled = false;
    expirePromise.then(() => {
      expireSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(expireSettled).toBe(false);

    children[0]?.emitExit(0);
    await expirePromise;

    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'expired' });
  });

  it('expire() after acceptance is a no-op and does not flip the outcome', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const gate = new NotificationGate({ spawnFn });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-2b',
      title: 'Ethos',
      message: 'call detected',
    });

    children[0]?.emitLine({ event: 'accepted', callId: 'call-2b' });
    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'accepted' });

    await handle.expire();

    await expect(handle.waitForOutcome()).resolves.toEqual({ outcome: 'accepted' });
    expect(children[0]?.killedWith).toEqual([]);
  });

  it('resolves the error outcome when the binary fails to spawn, never throws', async () => {
    const spawnFn = (): CaptureOfferCardChild => {
      throw new Error('capture-offer-card binary not found');
    };
    const gate = new NotificationGate({ spawnFn });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-3',
      title: 'Ethos',
      message: 'call detected',
    });

    const outcome = await handle.waitForOutcome();
    expect(outcome).toEqual({
      outcome: 'error',
      message: 'capture-offer-card failed to start: capture-offer-card binary not found',
    });
  });

  it('resolves the error outcome when the card reports an error line', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const gate = new NotificationGate({ spawnFn });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-5',
      title: 'Ethos',
      message: 'call detected',
    });
    children[0]?.emitLine({ event: 'error', message: 'usage: capture-offer-card <callId>' });

    await expect(handle.waitForOutcome()).resolves.toEqual({
      outcome: 'error',
      message: 'usage: capture-offer-card <callId>',
    });
  });

  it('resolves the error outcome on an unexpected exit with no prior event', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const gate = new NotificationGate({ spawnFn });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-6',
      title: 'Ethos',
      message: 'call detected',
    });
    children[0]?.emitExit(134);

    const outcome = await handle.waitForOutcome();
    expect(outcome.outcome).toBe('error');
  });

  it('resolves the error outcome when the process errors (e.g. spawn ENOENT)', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const gate = new NotificationGate({ spawnFn });

    const handle = await gate.presentCaptureOffer({
      callId: 'call-7',
      title: 'Ethos',
      message: 'call detected',
    });
    children[0]?.emitProcessError(new Error('spawn ENOENT'));

    await expect(handle.waitForOutcome()).resolves.toEqual({
      outcome: 'error',
      message: 'capture-offer-card spawn failed: spawn ENOENT',
    });
  });

  it('gives two independent offers independent processes that do not cross-resolve', async () => {
    const { spawnFn, children } = makeFakeSpawn();
    const gate = new NotificationGate({ spawnFn });

    const handleA = await gate.presentCaptureOffer({ callId: 'call-a', title: 't', message: 'm' });
    const handleB = await gate.presentCaptureOffer({ callId: 'call-b', title: 't', message: 'm' });

    expect(children).toHaveLength(2);

    children[0]?.emitLine({ event: 'accepted', callId: 'call-a' });
    await expect(handleA.waitForOutcome()).resolves.toEqual({ outcome: 'accepted' });

    let bSettled = false;
    handleB.waitForOutcome().then(() => {
      bSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(bSettled).toBe(false);

    const expireB = handleB.expire();
    children[1]?.emitExit(0);
    await expireB;
    await expect(handleB.waitForOutcome()).resolves.toEqual({ outcome: 'expired' });
  });
});
