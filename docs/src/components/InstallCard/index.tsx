import { type ReactNode, useState } from 'react';
import styles from './styles.module.css';

type PersonalityId = 'researcher' | 'engineer' | 'reviewer';

interface PersonalityScript {
  id: PersonalityId;
  accent: string;
  invokeComment: string;
  prompt: string;
}

const SCRIPTS: PersonalityScript[] = [
  {
    id: 'researcher',
    accent: '#4A9EFF',
    invokeComment: '# methodical · cites sources · flags uncertainty',
    prompt: 'What is the strongest evidence for emergent abilities at scale?',
  },
  {
    id: 'engineer',
    accent: '#4ADE80',
    invokeComment: '# terse · code-first · runs commands to verify',
    prompt: 'Refactor src/agent-loop.ts to use streams.',
  },
  {
    id: 'reviewer',
    accent: '#F59E0B',
    invokeComment: '# critical · evidence-based · always explains why',
    prompt: 'Review the diff against main for security issues.',
  },
];

const INSTALL_CMD = 'pnpm add -g @ethosagent/cli';

export default function InstallCard(): ReactNode {
  const [active, setActive] = useState<PersonalityId>('researcher');
  const [copied, setCopied] = useState(false);

  const script = SCRIPTS.find((s) => s.id === active) ?? SCRIPTS[0];
  if (!script) return null;
  const block = `${INSTALL_CMD}\nethos chat --personality ${script.id}`;

  const onCopy = async () => {
    if (typeof navigator === 'undefined' || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(block);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard write rejected — silent fail is fine on a marketing surface
    }
  };

  return (
    <div className={styles.card} style={{ ['--accent' as never]: script.accent }}>
      <div className={styles.header}>
        <div className={styles.dots} aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className={styles.tabs} role="tablist" aria-label="Choose a personality">
          {SCRIPTS.map((s) => {
            const isActive = s.id === active;
            return (
              <button
                key={s.id}
                type="button"
                role="tab"
                aria-selected={isActive}
                className={isActive ? `${styles.tab} ${styles.tabActive}` : styles.tab}
                style={{ ['--accent' as never]: s.accent }}
                onClick={() => setActive(s.id)}
              >
                {s.id}
              </button>
            );
          })}
        </div>
      </div>

      <pre className={styles.body}>
        <span className={styles.comment}># install ethos</span>
        {'\n'}
        <span className={styles.prompt}>$ </span>
        {INSTALL_CMD}
        {'\n\n'}
        <span className={styles.comment}>{script.invokeComment}</span>
        {'\n'}
        <span className={styles.prompt}>$ </span>
        {'ethos chat --personality '}
        <span className={styles.accentText}>{script.id}</span>
        {'\n'}
        <span className={styles.you}>{'> '}</span>
        <span className={styles.userMsg}>{script.prompt}</span>
      </pre>

      <button
        type="button"
        className={styles.copyBtn}
        onClick={onCopy}
        aria-label="Copy install command"
      >
        <span aria-live="polite">{copied ? 'copied' : 'copy'}</span>
      </button>
    </div>
  );
}
