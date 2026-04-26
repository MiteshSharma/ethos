import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import type { CSSProperties, ReactNode } from 'react';

import InstallCard from '../components/InstallCard';
import PersonalityShowcase from '../components/PersonalityShowcase';
import styles from './index.module.css';

const fastPaths = [
  {
    number: '01',
    label: 'Use it',
    description: 'Install, configure, and run your first agent in under 5 minutes.',
    cta: 'Quickstart →',
    to: '/docs/getting-started/quickstart',
  },
  {
    number: '02',
    label: 'Build on it',
    description: 'Step-by-step tutorials for agents, personalities, and tools.',
    cta: 'Tutorial →',
    to: '/docs/tutorial/build-your-first-agent',
  },
  {
    number: '03',
    label: 'Extend it',
    description: 'Add LLM providers, tools, platform adapters, and plugins.',
    cta: 'SDK →',
    to: '/docs/extending-ethos/overview',
  },
];

function Hero() {
  const { siteConfig } = useDocusaurusContext();
  const taglineWords = siteConfig.tagline.split(/\s+/);
  return (
    <section className={styles.hero}>
      <div className={styles.heroInner}>
        <Link to="/docs/personality/built-in-personalities" className={styles.announcePill}>
          <span className={styles.announceBadge}>specialists</span>
          <span className={styles.announceText}>5 ship by default</span>
          <span className={styles.announceArrow} aria-hidden="true">
            →
          </span>
        </Link>
        <div className={styles.heroStripe} aria-hidden="true" />
        <p className={styles.heroEyebrow}>ethos · personality is architecture</p>
        <h1 className={styles.heroTitle}>
          {taglineWords.map((word, i) => (
            <span
              // biome-ignore lint/suspicious/noArrayIndexKey: stable token list, never reordered
              key={i}
              className={styles.heroWord}
              style={{ ['--i' as never]: i } as CSSProperties}
            >
              {word}
            </span>
          ))}
        </h1>
        <p className={styles.heroSubtitle}>
          Each personality is a structural component, not a prompt. A curated toolset. A
          first-person identity. A memory scope. Specialists ship by default.
        </p>
        <div className={styles.heroActions}>
          <Link className={styles.btnPrimary} to="/docs/getting-started/quickstart">
            Get started
          </Link>
          <Link className={styles.btnGhost} href="https://github.com/MiteshSharma/ethos">
            View on GitHub
          </Link>
        </div>
        <p className={styles.heroMeta}>
          mit · node 24 · typescript strict · zero deps in the types layer
        </p>
      </div>
    </section>
  );
}

function QuickStart() {
  return (
    <section className={styles.quickStart}>
      <div className={styles.quickStartInner}>
        <div className={styles.sectionHeading}>
          <span className={styles.sectionChevron} aria-hidden="true">
            ▸
          </span>
          <span className={styles.sectionLabel}>quickstart</span>
        </div>
        <InstallCard />
        <p className={styles.quickStartNote}>
          tabs are personalities. swap them — the agent's behavior, tools, and memory scope change
          with the file.
        </p>
      </div>
    </section>
  );
}

function FastPaths() {
  return (
    <section className={styles.fastPaths}>
      <div className="container">
        <div className={styles.sectionLabel}>three ways in</div>
        <div className={styles.pathRows}>
          {fastPaths.map((p) => (
            <Link key={p.label} to={p.to} className={styles.pathRow}>
              <span className={styles.pathNumber}>{p.number}</span>
              <span className={styles.pathLabel}>{p.label}</span>
              <span className={styles.pathDescription}>{p.description}</span>
              <span className={styles.pathCta}>{p.cta}</span>
            </Link>
          ))}
        </div>
      </div>
    </section>
  );
}

function ArchDiagram() {
  return (
    <section className={styles.arch}>
      <div className="container">
        <div className={styles.sectionLabel}>how it works</div>
        <h2 className={styles.sectionTitle}>AgentLoop is a 9-step generator.</h2>
        <p className={styles.sectionSubtitle}>
          Every component is an interface, injected at construction. Personality decides which tools
          enter step 9 and which model handles step 8.
        </p>
        <pre className={styles.archDiagram}>
          {`  user input
       │
       ▼
  ┌──────────────────────────────────────────────────────┐
  │  AgentLoop.run(input, options)                       │
  │  ─────────────────────────────────────────────────   │
  │  1. resolve or create session                        │
  │  2. fire session_start hooks                         │
  │  3. persist user message                             │
  │  4. load history (trimmed)                           │
  │  5. prefetch memory (per personality scope)          │
  │  6. build system prompt from injectors               │
  │  7. before-prompt-build modifying hooks              │
  │  8. agentic loop (LLM stream → tool calls → LLM ...) │
  │  9. pre-flight hooks → execute tools → collect       │
  └──────────────────────────────────────────────────────┘
       │
       ▼
  AsyncGenerator<AgentEvent>
       │ text_delta, thinking_delta, tool_start, tool_end,
       │ tool_progress, usage, done, error
       ▼
  surfaces: cli · tui · vscode · email · telegram · slack`}
        </pre>
        <Link to="/docs/getting-started/architecture-overview" className={styles.archLink}>
          read architecture overview →
        </Link>
      </div>
    </section>
  );
}

function WhyNotTeaser() {
  return (
    <section className={styles.teaser}>
      <div className="container">
        <div className={styles.teaserInner}>
          <p className={styles.teaserText}>
            <strong>Why not LangChain, CrewAI, or AutoGen?</strong> Personality as a structural
            component, not a string. Strict toolset isolation. ACP-native swarm.
          </p>
          <Link to="/docs/getting-started/why-ethos" className={styles.teaserLink}>
            see the comparison →
          </Link>
        </div>
      </div>
    </section>
  );
}

export default function Home(): ReactNode {
  return (
    <Layout
      title="The agent framework where personality is architecture"
      description="TypeScript AI agent framework where personality is architecture. Curated toolsets, first-person identities, scoped memory. Specialists, not a generic agent."
    >
      <Hero />
      <QuickStart />
      <PersonalityShowcase />
      <ArchDiagram />
      <FastPaths />
      <WhyNotTeaser />
    </Layout>
  );
}
