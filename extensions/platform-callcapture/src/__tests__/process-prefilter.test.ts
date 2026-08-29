import { describe, expect, it } from 'vitest';
import { KNOWN_CALLING_APP_PROCESSES, sourceLabelForProcessName } from '../process-prefilter';

// Pure lookup-table logic — no process probing left in this module (the
// pgrep-based checkAnyCallingAppRunning() was removed; the native detector
// now does its own known-app matching, see process-prefilter.ts's header
// comment).

describe('KNOWN_CALLING_APP_PROCESSES', () => {
  it('is a non-empty, easily-extended plain array', () => {
    expect(Array.isArray(KNOWN_CALLING_APP_PROCESSES)).toBe(true);
    expect(KNOWN_CALLING_APP_PROCESSES.length).toBeGreaterThan(0);
  });
});

describe('sourceLabelForProcessName', () => {
  it('maps every known calling-app process name to a clean label', () => {
    expect(sourceLabelForProcessName('zoom.us')).toBe('zoom');
    expect(sourceLabelForProcessName('Microsoft Teams')).toBe('teams');
    expect(sourceLabelForProcessName('Discord')).toBe('discord');
    expect(sourceLabelForProcessName('Skype')).toBe('skype');
    expect(sourceLabelForProcessName('FaceTime')).toBe('facetime');
    expect(sourceLabelForProcessName('Webex')).toBe('webex');
    expect(sourceLabelForProcessName('GoToMeeting')).toBe('gotomeeting');
  });

  it('falls back to the raw name for anything not in the table', () => {
    expect(sourceLabelForProcessName('SomeUnknownApp')).toBe('SomeUnknownApp');
  });
});
