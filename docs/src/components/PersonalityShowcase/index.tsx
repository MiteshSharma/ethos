import Link from '@docusaurus/Link';
import type { ReactNode } from 'react';

import styles from './styles.module.css';

type Tool = 'web' | 'file' | 'terminal' | 'memory' | 'code';
type MemoryScope = 'global' | 'per-personality';

interface Personality {
  id: string;
  tagline: string;
  tools: Tool[];
  memoryScope: MemoryScope;
}

const personalities: Personality[] = [
  {
    id: 'researcher',
    tagline: 'Methodical, citation-focused, uncertainty-aware',
    tools: ['web', 'file', 'memory'],
    memoryScope: 'global',
  },
  {
    id: 'engineer',
    tagline: 'Terse, code-first, direct',
    tools: ['terminal', 'file', 'web', 'code'],
    memoryScope: 'global',
  },
  {
    id: 'reviewer',
    tagline: 'Critical, structured, evidence-based',
    tools: ['file'],
    memoryScope: 'per-personality',
  },
  {
    id: 'coach',
    tagline: 'Warm, questioning, growth-focused',
    tools: ['web', 'memory'],
    memoryScope: 'global',
  },
  {
    id: 'operator',
    tagline: 'Cautious, confirms before acting, dry-run first',
    tools: ['terminal', 'file', 'code'],
    memoryScope: 'per-personality',
  },
];

function PersonalityCard({ personality }: { personality: Personality }): ReactNode {
  return (
    <div className={styles.card}>
      <h3 className={styles.cardName}>{personality.id}</h3>
      <p className={styles.cardTagline}>{personality.tagline}</p>
      <div className={styles.pills}>
        {personality.tools.map((tool) => (
          <span key={tool} className={styles.pill}>
            {tool}
          </span>
        ))}
      </div>
      <p className={styles.memoryScope}>
        <span
          className={personality.memoryScope === 'global' ? styles.dotGlobal : styles.dotLocal}
        />
        {personality.memoryScope} memory
      </p>
    </div>
  );
}

export default function PersonalityShowcase(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <h2 className={styles.sectionTitle}>Built-in personalities</h2>
        <p className={styles.sectionSubtitle}>
          Five personalities ship out of the box. Each has an identity, a curated toolset, and a
          memory scope. Switch with <code>/personality &lt;id&gt;</code> or bring your own.
        </p>
        <div className={styles.grid}>
          {personalities.map((p) => (
            <PersonalityCard key={p.id} personality={p} />
          ))}
        </div>
        <div className={styles.cta}>
          <Link to="/docs/personality/what-is-a-personality">What is a personality? →</Link>
        </div>
      </div>
    </section>
  );
}
