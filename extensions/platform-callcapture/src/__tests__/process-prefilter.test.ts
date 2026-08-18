import { describe, expect, it, vi } from 'vitest';
import type { CheckProcessRunning } from '../process-prefilter';
import {
  checkAnyCallingAppRunning,
  KNOWN_CALLING_APP_PROCESSES,
  sourceLabelForProcessName,
} from '../process-prefilter';

// Pure logic over an injected process probe — mirrors preflight.test.ts's
// injectable-spawn idiom. Never shells out to real `pgrep` in a test.

describe('KNOWN_CALLING_APP_PROCESSES', () => {
  it('is a non-empty, easily-extended plain array', () => {
    expect(Array.isArray(KNOWN_CALLING_APP_PROCESSES)).toBe(true);
    expect(KNOWN_CALLING_APP_PROCESSES.length).toBeGreaterThan(0);
  });
});

describe('checkAnyCallingAppRunning', () => {
  it('resolves the matched process name when the first process name matches', async () => {
    const probe: CheckProcessRunning = vi.fn(async (name) => name === 'zoom.us');
    const result = await checkAnyCallingAppRunning(['zoom.us', 'Discord'], probe);
    expect(result).toBe('zoom.us');
    expect(probe).toHaveBeenCalledTimes(1); // short-circuits on first match
  });

  it('resolves the matched process name when a later process name matches, checking every candidate up to it', async () => {
    const probe: CheckProcessRunning = vi.fn(async (name) => name === 'Discord');
    const result = await checkAnyCallingAppRunning(['zoom.us', 'Discord', 'Skype'], probe);
    expect(result).toBe('Discord');
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('resolves null when none of the process names match', async () => {
    const probe: CheckProcessRunning = vi.fn(async () => false);
    const result = await checkAnyCallingAppRunning(['zoom.us', 'Discord'], probe);
    expect(result).toBeNull();
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('defaults to KNOWN_CALLING_APP_PROCESSES when no list is supplied', async () => {
    const seen: string[] = [];
    const probe: CheckProcessRunning = async (name) => {
      seen.push(name);
      return false;
    };
    const result = await checkAnyCallingAppRunning(undefined, probe);
    expect(result).toBeNull();
    expect(seen).toEqual(KNOWN_CALLING_APP_PROCESSES);
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
