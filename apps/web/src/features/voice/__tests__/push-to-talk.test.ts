import { describe, expect, it } from 'vitest';
import { createPushToTalkHandlers, isTypingTarget } from '../push-to-talk';
import { MIC_DENIED_CODE } from '../voice-call-reducer';
import { classifyVoiceStartError, MIC_DENIED_MESSAGE } from '../voice-start-error';

// Keyboard control of a live call (DR5): hold Space to talk, Esc ends it.

function recorder() {
  const calls: string[] = [];
  const handlers = createPushToTalkHandlers({
    onHold: () => calls.push('hold'),
    onRelease: () => calls.push('release'),
    onEnd: () => calls.push('end'),
  });
  return { calls, handlers };
}

describe('push-to-talk', () => {
  it('opens the mic while Space is held and closes it on release', () => {
    const { calls, handlers } = recorder();
    expect(handlers.keyDown({ key: ' ' })).toBe(true);
    expect(handlers.keyUp({ key: ' ' })).toBe(true);
    expect(calls).toEqual(['hold', 'release']);
  });

  it('ignores auto-repeat — a held key must not re-open the mic per repeat', () => {
    const { calls, handlers } = recorder();
    handlers.keyDown({ key: ' ' });
    handlers.keyDown({ key: ' ', repeat: true });
    handlers.keyDown({ key: ' ', repeat: true });
    handlers.keyUp({ key: ' ' });
    expect(calls).toEqual(['hold', 'release']);
  });

  it('Esc ends the call', () => {
    const { calls, handlers } = recorder();
    expect(handlers.keyDown({ key: 'Escape' })).toBe(true);
    expect(calls).toEqual(['end']);
  });

  it('never steals Space (or Esc) from the composer', () => {
    const { calls, handlers } = recorder();
    const target = { tagName: 'TEXTAREA' };
    expect(handlers.keyDown({ key: ' ', target })).toBe(false);
    expect(handlers.keyDown({ key: 'Escape', target })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('releases a hold even when focus moved into an input mid-press', () => {
    const { calls, handlers } = recorder();
    handlers.keyDown({ key: ' ' });
    expect(handlers.keyUp({ key: ' ', target: { tagName: 'INPUT' } })).toBe(true);
    expect(calls).toEqual(['hold', 'release']);
  });

  it('prevents Space from scrolling the page', () => {
    const { handlers } = recorder();
    let prevented = 0;
    handlers.keyDown({ key: ' ', preventDefault: () => (prevented += 1) });
    expect(prevented).toBe(1);
  });

  it('leaves other keys alone', () => {
    const { calls, handlers } = recorder();
    expect(handlers.keyDown({ key: 'a' })).toBe(false);
    expect(handlers.keyUp({ key: 'a' })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('treats contenteditable as typing', () => {
    expect(isTypingTarget({ isContentEditable: true })).toBe(true);
    expect(isTypingTarget({ tagName: 'DIV' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

describe('classifyVoiceStartError', () => {
  it('turns a refused mic into guidance with the re-grant path', () => {
    const err = Object.assign(new Error('Permission denied'), { name: 'NotAllowedError' });
    expect(classifyVoiceStartError(err)).toEqual({
      type: 'error',
      error: MIC_DENIED_MESSAGE,
      code: MIC_DENIED_CODE,
    });
    expect(MIC_DENIED_MESSAGE).toContain('site settings');
  });

  it('treats an insecure-origin refusal the same way', () => {
    const err = Object.assign(new Error('nope'), { name: 'SecurityError' });
    expect(classifyVoiceStartError(err).code).toBe(MIC_DENIED_CODE);
  });

  it('passes an ordinary failure through with its own message', () => {
    const result = classifyVoiceStartError(new Error('Could not open the voice link.'));
    expect(result).toEqual({ type: 'error', error: 'Could not open the voice link.' });
  });

  it('falls back to a plain message for a non-Error rejection', () => {
    expect(classifyVoiceStartError('boom').error).toBe('Could not start voice call');
  });
});
