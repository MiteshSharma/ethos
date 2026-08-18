import { CallCaptureBindingError, type PersonalityConfig } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { validateCallCaptureBinding } from '../call-capture-binding';

// plan/phases/call-capture-extension.md decision 3 — exactly one personality,
// system-wide, may declare the `call_capture` toolset capability, and it must
// match `callCapture.personalityId`.

function personality(id: string, toolset?: string[]): PersonalityConfig {
  return { id, name: id, ...(toolset ? { toolset } : {}) };
}

describe('validateCallCaptureBinding', () => {
  it('is a no-op when zero personalities hold the capability and no config is set', () => {
    const personalities = [personality('assistant', ['file', 'web']), personality('researcher')];
    expect(() => validateCallCaptureBinding(personalities, undefined)).not.toThrow();
  });

  it('throws when zero personalities hold the capability but the config names one', () => {
    const personalities = [personality('assistant', ['file', 'web'])];
    expect(() => validateCallCaptureBinding(personalities, { personalityId: 'assistant' })).toThrow(
      CallCaptureBindingError,
    );
  });

  it('does not throw when exactly one holder matches the configured id', () => {
    const personalities = [
      personality('receptionist', ['call_capture']),
      personality('assistant', ['file']),
    ];
    expect(() =>
      validateCallCaptureBinding(personalities, { personalityId: 'receptionist' }),
    ).not.toThrow();
  });

  it('throws when exactly one personality holds the capability but no config is set', () => {
    const personalities = [personality('receptionist', ['call_capture'])];
    expect(() => validateCallCaptureBinding(personalities, undefined)).toThrow(
      CallCaptureBindingError,
    );
  });

  it('throws when two or more personalities hold the capability, even if config matches one', () => {
    const personalities = [
      personality('receptionist', ['call_capture']),
      personality('frontdesk', ['call_capture']),
    ];
    let thrown: unknown;
    try {
      validateCallCaptureBinding(personalities, { personalityId: 'receptionist' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CallCaptureBindingError);
    expect((thrown as CallCaptureBindingError).message).toContain('2 personalities');
  });

  it('throws when the configured id names a personality other than the sole holder', () => {
    const personalities = [
      personality('receptionist', ['call_capture']),
      personality('assistant', ['file']),
    ];
    let thrown: unknown;
    try {
      validateCallCaptureBinding(personalities, { personalityId: 'assistant' });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(CallCaptureBindingError);
    expect((thrown as CallCaptureBindingError).message).toContain('assistant');
  });
});
