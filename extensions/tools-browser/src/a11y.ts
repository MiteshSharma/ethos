// ---------------------------------------------------------------------------
// Accessibility tree utilities
// ---------------------------------------------------------------------------

export interface A11yRef {
  ref: string; // '@e1'
  role: string; // 'button', 'link', …
  name: string; // accessible name used for locating the element later
}

export interface A11yResult {
  text: string;
  refs: Map<string, A11yRef>;
}

// Roles that should receive a clickable @e{n} reference
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'combobox',
  'listbox',
  'checkbox',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
  'switch',
  'slider',
  'spinbutton',
]);

// ---------------------------------------------------------------------------
// parseAriaSnapshot — Playwright 1.44+ ariaSnapshot() returns YAML like:
//   - heading "Title" [level=1]
//   - button "Submit"
//   - link "Learn More":
//       - /url: https://example.com
// We scan for interactive role lines and inject @e{n} refs.
// ---------------------------------------------------------------------------

const ROLE_RE = new RegExp(`^(\\s*- )(${[...INTERACTIVE_ROLES].join('|')}) "([^"]+)"(.*)$`, 'i');

export function parseAriaSnapshot(yaml: string): A11yResult {
  const refs = new Map<string, A11yRef>();
  let counter = 1;

  const lines = yaml.split('\n').map((line) => {
    const m = line.match(ROLE_RE);
    if (!m) return line;
    const [, prefix, rolePart, name, rest] = m;
    const role = rolePart.toLowerCase();
    const ref = `@e${counter++}`;
    refs.set(ref, { ref, role, name });
    return `${prefix}${ref} [${role}] "${name}"${rest}`;
  });

  return { text: lines.join('\n'), refs };
}

// ---------------------------------------------------------------------------
// buildA11yTree — for testing and JSON-tree based snapshots
// ---------------------------------------------------------------------------

export interface RawA11yNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  focused?: boolean;
  level?: number;
  children?: RawA11yNode[];
}

export function buildA11yTree(root: RawA11yNode | null): A11yResult {
  const refs = new Map<string, A11yRef>();
  let counter = 1;
  const lines: string[] = [];

  function walk(node: RawA11yNode, depth: number): void {
    const indent = '  '.repeat(depth);
    const { role, name, value, checked, disabled, expanded, level } = node;

    const isInteractive = INTERACTIVE_ROLES.has(role);

    if (role === 'WebArea' || role === 'document' || role === 'RootWebArea') {
      for (const child of node.children ?? []) walk(child, depth);
      return;
    }

    if (role === 'text' || role === 'StaticText') {
      const text = name?.trim();
      if (text) lines.push(`${indent}${text}`);
      return;
    }

    let line = indent;

    if (isInteractive && name) {
      const ref = `@e${counter++}`;
      refs.set(ref, { ref, role, name });
      line += `${ref} [${role}] "${name}"`;
    } else if (role === 'heading') {
      line += `[h${level ?? ''}] ${name ?? ''}`;
    } else {
      line += `[${role}]${name ? ` ${name}` : ''}`;
    }

    if (value) line += ` = "${value}"`;
    if (checked === true) line += ' ✓';
    if (disabled) line += ' [disabled]';
    if (expanded === false) line += ' [collapsed]';
    if (expanded === true) line += ' [expanded]';

    lines.push(line.trimEnd());

    for (const child of node.children ?? []) walk(child, depth + 1);
  }

  if (root) walk(root, 0);

  return { text: lines.filter((l) => l.trim()).join('\n'), refs };
}
