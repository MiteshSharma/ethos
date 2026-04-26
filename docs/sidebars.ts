import type { SidebarsConfig } from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Getting Started',
      collapsed: false,
      items: [
        'getting-started/quickstart',
        'getting-started/architecture-overview',
        'getting-started/why-ethos',
        'getting-started/project-structure',
        'getting-started/contributing',
      ],
    },
    {
      type: 'category',
      label: 'Tutorial',
      collapsed: true,
      items: [
        'tutorial/build-your-first-agent',
        'tutorial/create-a-custom-personality',
        'tutorial/write-your-first-tool',
      ],
    },
    {
      type: 'category',
      label: 'Personality',
      collapsed: false,
      items: [
        'personality/what-is-a-personality',
        'personality/built-in-personalities',
        'personality/create-your-own',
      ],
    },
    {
      type: 'category',
      label: 'Core Concepts',
      collapsed: false,
      items: [
        'core-concepts/agent-loop',
        'core-concepts/hook-registry',
        'core-concepts/tool-registry',
        'core-concepts/memory-system',
      ],
    },
    {
      type: 'category',
      label: 'Extending Ethos',
      collapsed: true,
      items: [
        'extending-ethos/overview',
        'extending-ethos/adding-an-llm-provider',
        'extending-ethos/adding-tools',
        'extending-ethos/adding-a-platform-adapter',
        'extending-ethos/custom-memory-providers',
        'extending-ethos/plugin-sdk',
      ],
    },
    {
      type: 'category',
      label: 'Guides',
      collapsed: true,
      items: [
        'guides/deploy-telegram-agent',
        'guides/run-as-daemon',
        'guides/build-research-agent',
        'guides/publish-a-plugin',
        'guides/migrate-from-openclaw',
      ],
    },
    {
      type: 'category',
      label: 'Platforms',
      collapsed: true,
      items: [
        'platforms/overview',
        'platforms/cli',
        'platforms/telegram',
        'platforms/discord',
        'platforms/slack',
      ],
    },
    'cli-reference',
    'troubleshooting',
  ],
};

export default sidebars;
