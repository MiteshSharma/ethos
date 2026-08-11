import { useEffect, useState } from 'react';
import type { CardBlockProps } from '../registry';
import { UnknownCardBlock } from './UnknownCardBlock';

// Source text with a language chip and a copy affordance. A code body is
// dense monospace content that has to be visually separable from prose, so it
// keeps a surface — the same argument `.chart-block` makes.

export function CodeCardBlock({ card }: CardBlockProps) {
  if (card.kind !== 'code') return <UnknownCardBlock card={card} />;
  const { title, language, code } = card.payload;
  return (
    <div className="card-block card-code">
      <div className="card-code-head">
        {title ? <span className="card-code-title">{title}</span> : null}
        {language ? <span className="card-chip card-code-lang">{language}</span> : null}
        <CopyButton text={code} />
      </div>
      <pre className="card-code-body">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      className="card-code-copy"
      onClick={() => {
        void navigator.clipboard?.writeText(text);
        setCopied(true);
      }}
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  );
}
