import type { VoiceMode } from '@ethosagent/types';
import { createElement, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VoiceModeControl, type VoiceModeView, voiceModeView } from '../VoiceModeToggle';

// The chat header's per-conversation voice mode. Two halves, tested apart:
//
//  • `voiceModeView` — the whole decision (which mode, is it the lane's own,
//    can it be written to, what does the tooltip say).
//  • `VoiceModeControl` — hook-free, so it renders with `renderToStaticMarkup`
//    and its handler can be reached by walking the element tree. The apps/web
//    suite has no DOM: same constraint `personality-bar.test.ts` works under.

function view(over: Partial<VoiceModeView> = {}): VoiceModeView {
  return {
    mode: 'mirror_inbound',
    inherited: false,
    disabled: false,
    hint: 'Set for this conversation.',
    ...over,
  };
}

function markup(over: Partial<VoiceModeView> = {}): string {
  return renderToStaticMarkup(
    createElement(VoiceModeControl, { view: view(over), onChange: () => {} }),
  );
}

/** Every element's props in the tree, in visit order. */
function allProps(node: ReactNode): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (n: ReactNode): void => {
    if (Array.isArray(n)) {
      for (const child of n) visit(child);
      return;
    }
    if (!isValidElement(n)) return;
    if (typeof n.props !== 'object' || n.props === null) return;
    const props: Record<string, unknown> = { ...n.props };
    out.push(props);
    visit(props.children as ReactNode);
  };
  visit(node);
  return out;
}

/** The one element carrying both `options` and `onChange` — the Segmented. */
function segmented(props: {
  view: VoiceModeView;
  onChange: (mode: VoiceMode) => void;
}): Record<string, unknown> {
  const match = allProps(VoiceModeControl(props)).find(
    (p) => Array.isArray(p.options) && typeof p.onChange === 'function',
  );
  if (!match) throw new Error('no segmented control found in the rendered tree');
  return match;
}

describe('voiceModeView', () => {
  it('is disabled with no session, and says why rather than failing silently', () => {
    const v = voiceModeView({ sessionId: null, data: undefined });
    expect(v.disabled).toBe(true);
    expect(v.hint).toContain('send a message');
  });

  it('is disabled while the lane mode is still being read', () => {
    expect(voiceModeView({ sessionId: 's1', data: undefined }).disabled).toBe(true);
  });

  it('reads as INHERITED when the lane mode equals the deployment default', () => {
    const v = voiceModeView({
      sessionId: 's1',
      data: { mode: 'mirror_inbound', default: 'mirror_inbound' },
    });
    expect(v).toMatchObject({ mode: 'mirror_inbound', inherited: true, disabled: false });
    expect(v.hint).toContain('deployment default');
  });

  it('reads as EXPLICIT when the lane mode differs from the default', () => {
    const v = voiceModeView({ sessionId: 's1', data: { mode: 'all', default: 'mirror_inbound' } });
    expect(v).toMatchObject({ mode: 'all', inherited: false });
    expect(v.hint).toContain('this conversation');
  });
});

describe('VoiceModeControl', () => {
  it('shows all three states as mono labels, not one behind a menu', () => {
    const html = markup();
    expect(html).toContain('>off<');
    expect(html).toContain('>mirror_inbound<');
    expect(html).toContain('>all<');
    // Three of them, each in the mono state-word treatment.
    expect(html.match(/voice-mode-opt/g)).toHaveLength(3);
  });

  it('marks an inherited value distinctly — in words, not only in colour', () => {
    const inherited = markup({ inherited: true });
    expect(inherited).toContain('voice-mode-toggle-inherited');
    expect(inherited).toContain('voice · default');

    const explicit = markup({ inherited: false });
    expect(explicit).not.toContain('voice-mode-toggle-inherited');
    expect(explicit).not.toContain('· default');
  });

  it('names itself and its state for a screen reader', () => {
    expect(markup({ mode: 'all' })).toContain(
      'aria-label="Voice replies in this conversation — all',
    );
  });

  it('writes the picked mode through on change', () => {
    const onChange = vi.fn();
    const props = segmented({ view: view(), onChange });
    const handler = props.onChange;
    if (typeof handler !== 'function') throw new Error('onChange is not a function');
    handler('all');
    expect(onChange).toHaveBeenCalledWith('all');
  });

  it('is disabled — not merely unhelpful — when there is no lane to write to', () => {
    const props = segmented({
      view: voiceModeView({ sessionId: null, data: undefined }),
      onChange: () => {},
    });
    expect(props.disabled).toBe(true);
  });
});
