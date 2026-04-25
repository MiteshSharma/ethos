---
sidebar_position: 6
title: Plugin SDK
---

# Plugin SDK

A plugin bundles tools, hooks, and personality contributions into a single npm package that users can install without editing the core. The plugin SDK lets you publish reusable Ethos extensions.

## The `Plugin` interface

```typescript
interface Plugin {
  name: string;
  version: string;
  description?: string;
  tools?: Tool[];
  hooks?: HookRegistration[];
  personalityContributions?: PersonalityContribution[];
  onLoad?(registry: PluginRegistry): Promise<void>;
  onUnload?(): Promise<void>;
}
```

## A minimal plugin

```typescript
import type { Plugin } from '@ethosagent/types';
import { weatherTool } from './tools/weather';
import { locationHook } from './hooks/location';

export const weatherPlugin: Plugin = {
  name: '@myorg/ethos-weather',
  version: '1.0.0',
  description: 'Adds weather lookup tools and location context injection',
  tools: [weatherTool],
  hooks: [locationHook],
};
```

## Tools

Tools registered via plugin follow the same `Tool<TArgs>` interface as standalone tools:

```typescript
import type { Tool, ToolResult } from '@ethosagent/types';

interface WeatherArgs {
  city: string;
  units?: 'celsius' | 'fahrenheit';
}

export const weatherTool: Tool<WeatherArgs> = {
  name: 'get_weather',
  description: 'Returns current weather for a city.',
  toolset: 'web',
  maxResultChars: 500,

  inputSchema: {
    type: 'object',
    required: ['city'],
    properties: {
      city: { type: 'string' },
      units: { type: 'string', enum: ['celsius', 'fahrenheit'] },
    },
  },

  isAvailable() {
    return Boolean(process.env.OPENWEATHER_API_KEY);
  },

  async execute(args: WeatherArgs): Promise<ToolResult> {
    const key = process.env.OPENWEATHER_API_KEY;
    const unit = args.units === 'fahrenheit' ? 'imperial' : 'metric';
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(args.city)}&units=${unit}&appid=${key}`;
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `Weather API error: ${res.status}`, code: 'API_ERROR' };
    const data = await res.json();
    const symbol = unit === 'imperial' ? '°F' : '°C';
    return {
      ok: true,
      value: `${data.name}: ${data.main.temp}${symbol}, ${data.weather[0].description}`,
    };
  },
};
```

## Hooks

Hooks registered via plugin use the same three execution models (Void, Modifying, Claiming) as core hooks. See [Hook Registry](../core-concepts/hook-registry) for details.

```typescript
import type { HookRegistration } from '@ethosagent/types';

export const locationHook: HookRegistration = {
  point: 'before_llm_call',
  model: 'modifying',
  handler: async (ctx) => {
    const location = await detectLocation();
    if (!location) return null;
    return {
      systemPromptAddition: `User's current location: ${location.city}, ${location.country}.`,
    };
  },
};
```

## `onLoad` and `onUnload`

Use `onLoad` for initialization — connecting to external services, validating API keys, registering event listeners:

```typescript
export const analyticsPlugin: Plugin = {
  name: '@myorg/ethos-analytics',
  version: '1.0.0',

  async onLoad(registry) {
    await analyticsClient.connect();
    registry.on('tool_end', (event) => {
      analyticsClient.track('tool_used', { tool: event.toolName, ok: event.ok });
    });
  },

  async onUnload() {
    await analyticsClient.disconnect();
  },
};
```

## Packaging

`package.json` for a plugin:

```json
{
  "name": "@myorg/ethos-weather",
  "version": "1.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "types": "./dist/index.d.ts"
    }
  },
  "peerDependencies": {
    "@ethosagent/types": ">=0.1.0"
  },
  "devDependencies": {
    "@ethosagent/types": "workspace:*",
    "typescript": "^5"
  }
}
```

Note: `@ethosagent/types` is a **peer** dependency, not a regular dependency. This ensures plugins use the same types instance as the host app.

## Loading plugins

In `~/.ethos/config.yaml`:

```yaml
plugins:
  - "@myorg/ethos-weather"
  - "/path/to/local/plugin"
```

`PluginRegistry.load()` in `apps/ethos/src/wiring.ts` reads this list and calls `plugin.onLoad()` for each entry.

## Publishing

```bash
pnpm build
npm publish --access public
```

Users install with:

```bash
npm install @myorg/ethos-weather
```

Then add to `config.yaml` and restart.
