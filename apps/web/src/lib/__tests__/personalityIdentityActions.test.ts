import { describe, expect, it } from 'vitest';
import { canRetirePersonality, retireConfirmCopy } from '../personalityIdentityActions';

// P4 (plan/phases/personality-first-ui.md) — Identity page's Retire action.

describe('canRetirePersonality', () => {
  it('allows retiring a user-created personality', () => {
    expect(canRetirePersonality({ builtin: false })).toBe(true);
  });

  it('allows retiring a personality with no builtin flag at all', () => {
    expect(canRetirePersonality({})).toBe(true);
  });

  it('hides Retire for a built-in personality', () => {
    expect(canRetirePersonality({ builtin: true })).toBe(false);
  });
});

describe('retireConfirmCopy', () => {
  it('names the personality in the title and uses "Retire" as the ok label', () => {
    expect(retireConfirmCopy('Strategist')).toEqual({
      title: 'Retire Strategist?',
      content: 'The directory under ~/.ethos/personalities/ is removed.',
      okText: 'Retire',
    });
  });
});
