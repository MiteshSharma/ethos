import Link from '@docusaurus/Link';
import useDocusaurusContext from '@docusaurus/useDocusaurusContext';
import Layout from '@theme/Layout';
import type { ReactNode } from 'react';

import PersonalityShowcase from '../components/PersonalityShowcase';
import styles from './index.module.css';

const fastPaths = [
  {
    label: 'Use it',
    description: 'Install, configure, and run your first agent in under 5 minutes.',
    cta: 'Quickstart →',
    to: '/docs/getting-started/quickstart',
  },
  {
    label: 'Build on it',
    description: 'Step-by-step tutorials for agents, personalities, and tools.',
    cta: 'Start tutorial →',
    to: '/docs/tutorial/build-your-first-agent',
  },
  {
    label: 'Extend it',
    description: 'Add LLM providers, tools, platform adapters, and plugins.',
    cta: 'Explore SDK →',
    to: '/docs/extending-ethos/overview',
  },
];

function Hero() {
  const { siteConfig } = useDocusaurusContext();
  return (
    <section className={styles.hero}>
      <div className={styles.heroInner}>
        <p className={styles.heroEyebrow}>ethos</p>
        <h1 className={styles.heroTitle}>{siteConfig.tagline}</h1>
        <p className={styles.heroSubtitle}>
          Swap personalities to change tool access, memory scope, model routing, and tone in one
          command. Not a system prompt — a structural component.
        </p>
        <div className={styles.heroActions}>
          <Link className={styles.btnPrimary} to="/docs/getting-started/quickstart">
            Get started →
          </Link>
          <Link className={styles.btnGhost} href="https://github.com/ethosagent/ethos">
            View on GitHub
          </Link>
        </div>
        <p className={styles.heroMeta}>51 tests passing · 0 TypeScript errors · MIT · Node 24</p>
      </div>
    </section>
  );
}

function FastPaths() {
  return (
    <section className={styles.fastPaths}>
      <div className="container">
        <div className={styles.cardGrid}>
          {fastPaths.map((p) => (
            <Link key={p.label} to={p.to} className={styles.card}>
              <h3 className={styles.cardTitle}>{p.label}</h3>
              <p className={styles.cardDesc}>{p.description}</p>
              <span className={styles.cardCta}>{p.cta}</span>
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
        <h2 className={styles.sectionTitle}>How it works</h2>
        <p className={styles.sectionSubtitle}>
          AgentLoop is a 13-step <code>AsyncGenerator&lt;AgentEvent&gt;</code> — every component is
          an interface, injected at construction time.
        </p>
        <div className={styles.archPlaceholder}>
          <p className={styles.archPlaceholderText}>AgentLoop diagram coming soon</p>
          <Link to="/docs/getting-started/architecture-overview" className={styles.archLink}>
            Read architecture overview →
          </Link>
        </div>
      </div>
    </section>
  );
}

function WhyNotTeaser() {
  return (
    <section className={styles.teaser}>
      <div className="container">
        <div className={styles.teaserInner}>
          <p className={styles.teaserText}>Why not LangChain, CrewAI, or AutoGen?</p>
          <Link to="/docs/getting-started/why-ethos" className={styles.teaserLink}>
            See the comparison →
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
      description="TypeScript AI agent framework where personality is architecture. Swap personalities to change tool access, memory scope, and model routing in one command."
    >
      <Hero />
      <FastPaths />
      <PersonalityShowcase />
      <ArchDiagram />
      <WhyNotTeaser />
    </Layout>
  );
}
