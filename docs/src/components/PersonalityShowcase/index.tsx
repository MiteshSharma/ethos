import Link from '@docusaurus/Link';
import { type ReactNode, useMemo } from 'react';

import styles from './styles.module.css';

type MemoryScope = 'global' | 'per-personality';

interface Personality {
  id: string;
  accent: string;
  model: string;
  tagline: string;
  sample: string;
  // Actual tool names from extensions/personalities/data/<id>/toolset.yaml
  tools: string[];
  memoryScope: MemoryScope;
}

const personalities: Personality[] = [
  {
    id: 'researcher',
    accent: '#4A9EFF',
    model: 'claude-opus-4-7',
    tagline: 'methodical · cites sources · flags uncertainty',
    sample:
      'There are three families. The first is dense embedding retrieval, used by most open-source vector stores.',
    tools: [
      'web_search',
      'web_extract',
      'web_crawl',
      'read_file',
      'search_files',
      'memory_read',
      'memory_write',
      'session_search',
    ],
    memoryScope: 'global',
  },
  {
    id: 'engineer',
    accent: '#4ADE80',
    model: 'claude-sonnet-4-6',
    tagline: 'terse · code-first · runs commands to verify',
    sample:
      'On it. Plan: move apps/tui/src/agent-bridge.ts to packages/agent-bridge, update tui imports.',
    tools: [
      'terminal',
      'read_file',
      'write_file',
      'patch_file',
      'search_files',
      'web_search',
      'web_extract',
      'execute_code',
      'run_tests',
      'lint',
    ],
    memoryScope: 'global',
  },
  {
    id: 'reviewer',
    accent: '#F59E0B',
    model: 'claude-sonnet-4-6',
    tagline: 'critical · evidence-based · always explains why',
    sample: 'Two real concerns. The token rotation logic at auth.ts:47 has a TOCTOU race.',
    tools: ['read_file', 'search_files', 'session_search'],
    memoryScope: 'per-personality',
  },
  {
    id: 'coach',
    accent: '#E879F9',
    model: 'claude-opus-4-7',
    tagline: 'warm but direct · question-led · helps you think',
    sample: 'OK. Stuck on what specifically? Walk me through what you tried so far.',
    tools: ['web_search', 'web_extract', 'memory_read', 'memory_write', 'session_search'],
    memoryScope: 'global',
  },
  {
    id: 'operator',
    accent: '#94A3B8',
    model: 'claude-sonnet-4-6',
    tagline: 'cautious · confirms before destructive · documents everything',
    sample: 'Found 247 run logs older than 30 days totaling 4.2MB. Will dry-run first. OK?',
    tools: [
      'terminal',
      'read_file',
      'write_file',
      'patch_file',
      'search_files',
      'execute_code',
      'run_tests',
    ],
    memoryScope: 'per-personality',
  },
];

// Generative SVG mark — deterministic from personality id.
// 5x5 grid, mirror-symmetric, FNV-1a hash. Same algorithm as DESIGN.md spec.
function fnv1a(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function PersonalityMark({
  id,
  accent,
  size = 48,
}: {
  id: string;
  accent: string;
  size?: number;
}): ReactNode {
  const cells = 5;
  const cellSize = size / cells;
  const rects = useMemo(() => {
    const seed = fnv1a(id);
    const out: Array<{ x: number; y: number; opacity: number }> = [];
    let bits = seed;
    for (let y = 0; y < cells; y++) {
      for (let x = 0; x < Math.ceil(cells / 2); x++) {
        const filled = bits & 1;
        bits = bits >>> 1;
        if (!bits) bits = fnv1a(id + y + x);
        if (filled) {
          const opacity = 0.55 + (bits & 0x3) / 8;
          out.push({ x: x * cellSize, y: y * cellSize, opacity });
          if (x !== cells - 1 - x) {
            out.push({ x: (cells - 1 - x) * cellSize, y: y * cellSize, opacity });
          }
        }
      }
    }
    return out;
  }, [id, cellSize]);

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
      <rect width={size} height={size} rx={size * 0.16} fill={`${accent}22`} />
      {rects.map((r) => (
        <rect
          key={`${r.x}-${r.y}`}
          x={r.x}
          y={r.y}
          width={cellSize}
          height={cellSize}
          fill={accent}
          opacity={r.opacity}
        />
      ))}
    </svg>
  );
}

function PersonalityRow({ personality }: { personality: Personality }): ReactNode {
  return (
    <div className={styles.row} style={{ ['--accent' as never]: personality.accent }}>
      <div className={styles.mark}>
        <PersonalityMark id={personality.id} accent={personality.accent} size={48} />
      </div>
      <div className={styles.body}>
        <div className={styles.nameLine}>
          <span className={styles.name}>{personality.id}</span>
          <span className={styles.tagline}>{personality.tagline}</span>
        </div>
        <div className={styles.sample}>"{personality.sample}"</div>
        <div className={styles.toolList}>
          {personality.tools.map((t, i) => (
            <span key={t}>
              {i > 0 ? ' ' : ''}
              <code>{t}</code>
            </span>
          ))}
        </div>
      </div>
      <div className={styles.meta}>
        <div className={styles.metaCount}>
          <span className={styles.metaCountNum}>{personality.tools.length}</span>{' '}
          <span className={styles.metaCountLabel}>tools</span>
        </div>
        <div className={styles.metaModel}>
          <code>{personality.model}</code>
        </div>
        <div className={styles.metaScope}>
          memory · <code>{personality.memoryScope}</code>
        </div>
      </div>
    </div>
  );
}

export default function PersonalityShowcase(): ReactNode {
  return (
    <section className={styles.section}>
      <div className="container">
        <div className={styles.sectionLabel}>specialists ship by default</div>
        <h2 className={styles.sectionTitle}>Personality, not "an agent."</h2>

        <div className={styles.lead}>
          <p>
            A generic agent has every tool. That is its problem. The toolset is the union of every
            task you might ever do, which is a security surface, a cost surface, and a quality
            surface. Voice is mush. Memory is a pile.
          </p>
          <p>
            Personalities invert it. Each has a curated toolset, a first-person identity (
            <code>ETHOS.md</code>), and a memory scope. Researcher gets the 8 tools it needs.
            Reviewer gets 3 and a <code>per-personality</code> memory scope so its code-review notes
            never leak into your coach session.
          </p>
          <p className={styles.leadKicker}>
            Specialization, not configuration. Personality is architecture, not a system prompt in a
            costume.
          </p>
        </div>

        <div className={styles.rows}>
          {personalities.map((p) => (
            <PersonalityRow key={p.id} personality={p} />
          ))}
        </div>

        <div className={styles.cta}>
          <Link to="/docs/personality/what-is-a-personality" className={styles.ctaLink}>
            what is a personality? →
          </Link>
          <Link to="/docs/tutorial/create-a-custom-personality" className={styles.ctaLink}>
            create your own →
          </Link>
        </div>
      </div>
    </section>
  );
}
