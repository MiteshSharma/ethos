import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';
import jsonLdPlugin from './plugins/json-ld';
import rawMarkdownPlugin from './plugins/raw-markdown';

const config: Config = {
  title: 'Ethos',
  tagline:
    'A team of AI specialists — researcher, engineer, reviewer — that remember you across Slack, Telegram, and your terminal.',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  url: 'https://ethosagent.ai',
  baseUrl: '/',

  organizationName: 'ethosagent',
  projectName: 'ethos',

  onBrokenLinks: 'throw',
  onBrokenAnchors: 'throw',
  markdown: {
    format: 'detect',
    hooks: {
      onBrokenMarkdownLinks: 'throw',
    },
  },

  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          path: 'content',
          sidebarPath: './sidebars.ts',
          editUrl: 'https://github.com/ethosagent/ethos/tree/main/docs/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
        sitemap: {
          changefreq: 'weekly',
          priority: 0.5,
        },
      } satisfies Preset.Options,
    ],
  ],

  // Phase 6 — agent-readable surface. Both plugins run at postBuild time
  // (after Docusaurus emits HTML) so they can see the canonical content
  // tree and the final route layout simultaneously.
  //
  //   ethos-raw-markdown  → mirrors every doc as <path>.md in the build dir
  //   ethos-json-ld       → injects Schema.org JSON-LD per page based on kind
  //
  // llms.txt + llms-full.txt are emitted by `tsx scripts/generate-llms.ts`,
  // wired as a `prebuild` script in package.json — sits under static/ so
  // the standard static-asset pipeline serves them at /llms.txt and
  // /llms-full.txt with no extra config.
  plugins: [(context) => rawMarkdownPlugin(context), (context) => jsonLdPlugin(context)],

  themeConfig: {
    // Fallback for pages that don't get a per-page card rewrite (404, opt-out).
    // Real pages get their unique card via the json-ld plugin's postBuild
    // pass, sourced from `docs/static/img/og/<slug>.png` generated at prebuild.
    image: 'img/og/default.png',
    metadata: [
      {
        name: 'keywords',
        content: 'ai agent, typescript, framework, personality, llm, claude, openai',
      },
      {
        name: 'description',
        content:
          'Ethos is a TypeScript agent framework where personality is architecture — a directory of files that changes prompt, tools, memory, and model atomically.',
      },
    ],
    colorMode: {
      defaultMode: 'dark',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'ethos',
      logo: {
        alt: 'Ethos',
        src: 'img/favicon.svg',
      },
      items: [
        {
          to: '/docs',
          label: 'Docs',
          position: 'left',
        },
        {
          to: '/docs/using/quickstart',
          label: 'Use',
          position: 'left',
        },
        {
          to: '/docs/building/quickstart',
          label: 'Build',
          position: 'left',
        },
        {
          href: 'https://github.com/ethosagent/ethos',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            { label: 'Use Ethos', to: '/docs/using/quickstart' },
            { label: 'Build on Ethos', to: '/docs/building/quickstart' },
            { label: 'CLI reference', to: '/docs/using/reference/cli' },
            { label: 'Glossary', to: '/docs/getting-started/glossary' },
          ],
        },
        {
          title: 'Community',
          items: [
            { label: 'GitHub', href: 'https://github.com/ethosagent/ethos' },
            { label: 'Issues', href: 'https://github.com/ethosagent/ethos/issues' },
            { label: 'Releases', href: 'https://github.com/ethosagent/ethos/releases' },
          ],
        },
      ],
      copyright: `© ${new Date().getFullYear()} Ethos · MIT License`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
      additionalLanguages: ['bash', 'yaml', 'typescript'],
    },
    algolia: {
      appId: 'TBNLPLTG5F',
      apiKey: '22f67c86bb52a64020f8be7e437b9ff4',
      indexName: 'ethosagentdocs',
      contextualSearch: true,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
