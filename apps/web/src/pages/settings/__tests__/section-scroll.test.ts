import { describe, expect, it } from 'vitest';
import { shouldScrollToSection } from '../lib/section-scroll';

describe('shouldScrollToSection', () => {
  it('does not scroll on first mount (no previous route)', () => {
    expect(shouldScrollToSection(undefined, { category: 'general', section: 'basics' })).toBe(
      false,
    );
  });

  it('does not scroll when neither category nor section changed', () => {
    const route = { category: 'general', section: 'basics' };
    expect(shouldScrollToSection(route, { ...route })).toBe(false);
  });

  it('does not scroll on a category switch, even though the section also changed', () => {
    expect(
      shouldScrollToSection(
        { category: 'general', section: 'onboarding' },
        { category: 'voice', section: 'basics' },
      ),
    ).toBe(false);
  });

  it('scrolls on an in-category section change — the SectionNav tab click', () => {
    expect(
      shouldScrollToSection(
        { category: 'voice', section: 'basics' },
        { category: 'voice', section: 'trunk' },
      ),
    ).toBe(true);
  });
});
