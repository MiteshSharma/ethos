import { describe, expect, it } from 'vitest';
import type { RawA11yNode } from '../a11y';
import { buildA11yTree } from '../a11y';

describe('buildA11yTree', () => {
  it('returns empty text and no refs for null root', () => {
    const result = buildA11yTree(null);
    expect(result.text).toBe('');
    expect(result.refs.size).toBe(0);
  });

  it('assigns @e{n} refs to interactive elements', () => {
    const root: RawA11yNode = {
      role: 'WebArea',
      name: 'Test Page',
      children: [
        { role: 'button', name: 'Submit' },
        { role: 'link', name: 'Learn more' },
        { role: 'textbox', name: 'Email' },
      ],
    };
    const { text, refs } = buildA11yTree(root);

    expect(refs.size).toBe(3);
    expect([...refs.keys()]).toEqual(['@e1', '@e2', '@e3']);
    expect(refs.get('@e1')).toMatchObject({ role: 'button', name: 'Submit' });
    expect(refs.get('@e2')).toMatchObject({ role: 'link', name: 'Learn more' });
    expect(refs.get('@e3')).toMatchObject({ role: 'textbox', name: 'Email' });

    expect(text).toContain('@e1 [button] "Submit"');
    expect(text).toContain('@e2 [link] "Learn more"');
    expect(text).toContain('@e3 [textbox] "Email"');
  });

  it('does NOT assign refs to non-interactive elements', () => {
    const root: RawA11yNode = {
      role: 'WebArea',
      children: [
        { role: 'heading', name: 'Hello', level: 1 },
        { role: 'paragraph', children: [{ role: 'text', name: 'World' }] },
      ],
    };
    const { refs } = buildA11yTree(root);
    expect(refs.size).toBe(0);
  });

  it('renders headings with level prefix', () => {
    const root: RawA11yNode = {
      role: 'document',
      children: [{ role: 'heading', name: 'Main Title', level: 1 }],
    };
    const { text } = buildA11yTree(root);
    expect(text).toContain('[h1] Main Title');
  });

  it('renders StaticText / text nodes inline', () => {
    const root: RawA11yNode = {
      role: 'WebArea',
      children: [{ role: 'StaticText', name: 'Hello world' }],
    };
    const { text } = buildA11yTree(root);
    expect(text).toContain('Hello world');
  });

  it('skips empty text nodes', () => {
    const root: RawA11yNode = {
      role: 'WebArea',
      children: [
        { role: 'text', name: '   ' },
        { role: 'button', name: 'Go' },
      ],
    };
    const { text } = buildA11yTree(root);
    expect(text).not.toMatch(/^\s*$/); // no blank-only lines
    expect(text).toContain('@e1 [button] "Go"');
  });

  it('annotates checked state', () => {
    const root: RawA11yNode = {
      role: 'WebArea',
      children: [{ role: 'checkbox', name: 'Agree', checked: true }],
    };
    const { text } = buildA11yTree(root);
    expect(text).toContain('✓');
  });

  it('annotates disabled state', () => {
    const root: RawA11yNode = {
      role: 'WebArea',
      children: [{ role: 'button', name: 'Submit', disabled: true }],
    };
    const { text } = buildA11yTree(root);
    expect(text).toContain('[disabled]');
  });

  it('annotates expanded/collapsed state', () => {
    const root: RawA11yNode = {
      role: 'WebArea',
      children: [
        { role: 'combobox', name: 'Country', expanded: false },
        { role: 'combobox', name: 'State', expanded: true },
      ],
    };
    const { text } = buildA11yTree(root);
    expect(text).toContain('[collapsed]');
    expect(text).toContain('[expanded]');
  });

  it('renders nested children with indentation', () => {
    const root: RawA11yNode = {
      role: 'WebArea',
      children: [
        {
          role: 'list',
          children: [{ role: 'listitem', children: [{ role: 'link', name: 'Item 1' }] }],
        },
      ],
    };
    const { text } = buildA11yTree(root);
    // Link is nested, so it should have some indentation
    const lines = text.split('\n');
    const linkLine = lines.find((l) => l.includes('@e1 [link]'));
    expect(linkLine).toBeTruthy();
    expect(linkLine?.startsWith('  ')).toBe(true);
  });

  it('renders element value when present', () => {
    const root: RawA11yNode = {
      role: 'WebArea',
      children: [{ role: 'textbox', name: 'Search', value: 'hello' }],
    };
    const { text } = buildA11yTree(root);
    expect(text).toContain('= "hello"');
  });

  it('skips unnamed interactive elements (no ref assigned)', () => {
    const root: RawA11yNode = {
      role: 'WebArea',
      children: [{ role: 'button' }], // no name
    };
    const { refs } = buildA11yTree(root);
    // unnamed buttons don't get a ref
    expect(refs.size).toBe(0);
  });

  it('handles RootWebArea same as WebArea (transparent)', () => {
    const root: RawA11yNode = {
      role: 'RootWebArea',
      children: [{ role: 'button', name: 'Click me' }],
    };
    const { refs, text } = buildA11yTree(root);
    expect(refs.size).toBe(1);
    expect(text).toContain('@e1 [button] "Click me"');
  });
});
