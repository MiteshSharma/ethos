// The rail's search field (plan/phases/settings-navigation.md D7).
//
// Component state, deliberately: a search term in the URL is a link that means
// something different tomorrow, because the thing it names is the RESULT SET,
// and the result set moves as the product does. The address bar keeps naming
// the section.
//
// `/` focuses it and Esc clears it — the two keys every search field in a
// developer tool answers to. `/` is swallowed only when the caret is not
// already in a field, so typing a path into an input still types a slash.

import { Input, type InputRef } from 'antd';
import { useEffect, useRef } from 'react';

function typingSomewhereElse(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

export function RailSearch({
  value,
  onChange,
}: {
  value: string;
  onChange: (next: string) => void;
}) {
  const ref = useRef<InputRef>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      if (typingSomewhereElse(event.target)) return;
      event.preventDefault();
      ref.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <Input
      ref={ref}
      className="settings-rail-search"
      size="small"
      allowClear
      value={value}
      placeholder="Search settings  /"
      aria-label="Search settings"
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          onChange('');
        }
      }}
    />
  );
}
