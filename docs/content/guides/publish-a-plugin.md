---
sidebar_position: 3
title: Publish a Plugin
---

# Publish a Plugin

This guide walks through building a production-ready Ethos plugin and publishing it to npm.

## What makes a good plugin

A plugin is worth publishing when it:
- Bundles 1–5 tightly related tools (e.g., "GitHub tools", "weather + location")
- Has external dependencies (API keys, SDKs) that aren't in the core
- Would be useful to more than one Ethos user

## 1. Scaffold the package

```bash
mkdir ethos-plugin-myplugin
cd ethos-plugin-myplugin
pnpm init
```

**`package.json`**:

```json
{
  "name": "@yourscope/ethos-plugin-myplugin",
  "version": "0.1.0",
  "description": "An Ethos plugin that does X",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "keywords": ["ethos", "ethos-plugin", "ai-agent"],
  "peerDependencies": {
    "@ethosagent/types": ">=0.1.0"
  },
  "devDependencies": {
    "@ethosagent/types": "^0.1.0",
    "typescript": "^5",
    "tsup": "^8",
    "vitest": "^4"
  }
}
```

The `ethos-plugin` keyword helps users discover your plugin.

## 2. Write the plugin

**`src/index.ts`**:

```typescript
import type { Plugin } from '@ethosagent/types';
import { myTool } from './tools/my-tool';
import { myHook } from './hooks/my-hook';

export const plugin: Plugin = {
  name: '@yourscope/ethos-plugin-myplugin',
  version: '0.1.0',
  description: 'Does X for Ethos agents',
  tools: [myTool],
  hooks: [myHook],
};

export default plugin;
export { myTool } from './tools/my-tool';
```

## 3. Add build config

**`tsconfig.json`**:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

**`tsup.config.ts`**:

```typescript
import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
});
```

## 4. Write tests

```typescript
// src/tools/my-tool.test.ts
import { describe, it, expect } from 'vitest';
import { myTool } from './my-tool';

describe('myTool', () => {
  it('returns ok result for valid input', async () => {
    const result = await myTool.execute({ query: 'test' }, {} as any);
    expect(result.ok).toBe(true);
  });

  it('returns error for missing API key', async () => {
    const savedKey = process.env.MY_API_KEY;
    delete process.env.MY_API_KEY;
    const result = await myTool.execute({ query: 'test' }, {} as any);
    expect(result.ok).toBe(false);
    process.env.MY_API_KEY = savedKey;
  });
});
```

## 5. Document configuration

Include a clear `README.md` that shows:

1. Installation: `npm install @yourscope/ethos-plugin-myplugin`
2. Required env vars: `MY_API_KEY=...`
3. Config entry: add to `~/.ethos/config.yaml`
4. What it does and which tools it adds

```markdown
## Setup

1. Install: `npm install @yourscope/ethos-plugin-myplugin`

2. Set your API key:
   ```bash
   export MY_API_KEY="your-key-here"
   ```

3. Add to `~/.ethos/config.yaml`:
   ```yaml
   plugins:
     - "@yourscope/ethos-plugin-myplugin"
   ```

## Tools added

| Tool | Description |
|---|---|
| `my_tool` | Does X given Y |
```

## 6. Build and publish

```bash
# Build
pnpm build

# Verify the build looks right
ls dist/

# Dry run
npm publish --dry-run

# Publish
npm publish --access public
```

## 7. Versioning

Follow semantic versioning:

- `patch` (0.1.0 → 0.1.1): bug fixes, no API changes
- `minor` (0.1.0 → 0.2.0): new tools or hooks, backwards-compatible
- `major` (0.1.0 → 1.0.0): breaking changes to tool interfaces or config

## Plugin discovery

Once published, your plugin will be discoverable via:

```bash
npm search ethos-plugin
```

Consider submitting it to the [Ethos plugin registry](https://github.com/MiteshSharma/ethos/discussions) by opening a discussion.
