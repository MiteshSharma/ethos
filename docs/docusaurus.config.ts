import type * as Preset from '@docusaurus/preset-classic';
import type { Config } from '@docusaurus/types';
import { themes as prismThemes } from 'prism-react-renderer';

const config: Config = {
  title: 'Ethos',
  tagline: 'The agent framework where personality is architecture.',
  favicon: 'img/favicon.svg',

  future: {
    v4: true,
  },

  url: 'https://ethosagent.ai',
  baseUrl: '/',

  organizationName: 'ethosagent',
  projectName: 'ethos',

  onBrokenLinks: 'warn',
  markdown: {
    hooks: {
      onBrokenMarkdownLinks: 'warn',
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

  themeConfig: {
    image: 'img/ethos-og-card.png',
    metadata: [
      {
        name: 'keywords',
        content: 'ai agent, typescript, framework, personality, llm, claude, openai',
      },
      {
        name: 'description',
        content:
          'TypeScript AI agent framework where personality is architecture. Swap personalities to change tool access, memory scope, and model routing in one command.',
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
          to: '/docs/getting-started/quickstart',
          label: 'Docs',
          position: 'left',
        },
        {
          to: '/docs/personality/what-is-a-personality',
          label: 'Personality',
          position: 'left',
        },
        {
          to: '/docs/tutorial/build-your-first-agent',
          label: 'Tutorial',
          position: 'left',
        },
        {
          to: '/docs/extending-ethos/overview',
          label: 'Extend',
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
            { label: 'Quickstart', to: '/docs/getting-started/quickstart' },
            { label: 'Tutorial', to: '/docs/tutorial/build-your-first-agent' },
            { label: 'CLI Reference', to: '/docs/cli-reference' },
            { label: 'Contributing', to: '/docs/getting-started/contributing' },
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
  } satisfies Preset.ThemeConfig,
};

export default config;
