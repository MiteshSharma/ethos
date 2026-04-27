---
title: Write Your First Tool
description: Build a custom tool, package it as a plugin, and load it into a personality without touching Ethos source.
sidebar_position: 3
---

# Write Your First Tool

:::info ~15 min
Prerequisite: completed [Quickstart](../getting-started/quickstart) — `ethos chat` runs.
:::

Tools are how an agent takes action — read files, run shell commands, search the web, hit your internal API. This tutorial walks through building a custom tool from scratch and loading it into a personality. **No fork required.** You write a small plugin, install it from disk, and reference it from your personality's toolset.

By the end you'll have a `get_weather` tool that the LLM can call mid-conversation, returning real data of your choosing.

## What you'll build

```
> What's the weather like in Tokyo right now?

[get_weather] looking up Tokyo...
[get_weather] ✓ 12ms

It's currently 18°C and partly cloudy in Tokyo.
```

## 1. Create the plugin directory

Plugins are normal Node packages. The simplest layout:

```bash
mkdir -p ~/my-ethos-plugin/src
cd ~/my-ethos-plugin
```

Add a `package.json`:

```json title="~/my-ethos-plugin/package.json"
{
  "name": "ethos-plugin-weather",
  "version": "0.1.0",
  "type": "module",
  "main": "src/index.ts",
  "dependencies": {
    "@ethosagent/plugin-sdk": "*",
    "@ethosagent/types": "*"
  }
}
```

Then install:

```bash
npm install
```

## 2. Write the tool

```typescript title="~/my-ethos-plugin/src/index.ts"
import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, err, ok } from '@ethosagent/plugin-sdk/tool-helpers';

const getWeatherTool = defineTool<{ city: string }>({
  name: 'get_weather',
  description: 'Return the current weather for a given city.',
  toolset: 'weather',
  schema: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name, e.g. "Tokyo" or "San Francisco"' },
    },
    required: ['city'],
  },

  async execute({ city }) {
    if (!city || typeof city !== 'string') {
      return err('city must be a non-empty string', 'input_invalid');
    }

    // Replace this with a real API call — Open-Meteo, WeatherAPI, your internal
    // service, whatever. The return value goes straight back to the LLM as
    // context for its next turn.
    const fakeData: Record<string, string> = {
      Tokyo: '18°C and partly cloudy',
      'San Francisco': '14°C and foggy',
      London: '9°C and raining',
    };
    const reading = fakeData[city] ?? 'no data for that city';
    return ok(`Current weather in ${city}: ${reading}`);
  },
});

export function activate(api: EthosPluginApi): void {
  api.registerTool(getWeatherTool);
}

export function deactivate(): void {}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
```

That's the whole tool. Three things to notice:

- **`schema` is JSON Schema, not Zod.** The shape goes straight to the LLM — that's how it knows what arguments to send.
- **`execute` returns `ok(string)` or `err(string, code)`.** The string lands in the next LLM turn verbatim.
- **`activate(api)` is the plugin entry point.** It receives an API object and registers anything you want — tools, hooks, personalities.

## 3. Tell Ethos about your plugin

Edit `~/.ethos/config.yaml` and add a `plugins` section:

```yaml title="~/.ethos/config.yaml"
provider: anthropic
model: claude-opus-4-7
apiKey: sk-ant-XXXXXXXXXXXX
personality: researcher

plugins:
  - /Users/you/my-ethos-plugin
```

A relative or absolute path works. `ethos` resolves it on startup, runs `activate()`, and your tool joins the registry.

## 4. Add the tool to a personality

For the LLM to actually *use* the tool, it has to be in the active personality's allowlist. Edit (or create) a personality and add `get_weather` to its toolset.

If you're customizing a built-in like `researcher`, copy it first:

```bash
mkdir -p ~/.ethos/personalities/researcher
```

Drop a `toolset.yaml` in there:

```yaml title="~/.ethos/personalities/researcher/toolset.yaml"
tools:
  - web_search
  - read_file
  - memory_read
  - memory_write
  - get_weather   # your new tool
```

User-defined personalities take precedence over built-ins with the same name. Hot-reload picks the change up on the next turn — no restart needed.

:::tip Tools without a toolset entry are invisible
Even if your plugin registered the tool, the LLM only sees tools that are in the active personality's `toolset.yaml`. This is the toolset isolation contract — see [What is a Personality?](../personality/what-is-a-personality) for why.
:::

## 5. Try it

```bash
ethos chat
```

You should see your plugin loaded in the startup banner. Then ask:

```
> What's the weather in Tokyo?
```

The agent calls `get_weather`, sees `Current weather in Tokyo: 18°C and partly cloudy`, and writes a natural-language answer.

## What just happened

Three layers cooperated:

1. **Plugin** — your `activate(api)` registered a `Tool` with the registry.
2. **Personality** — `toolset.yaml` whitelisted `get_weather` for this personality.
3. **AgentLoop** — built the tool list for the LLM call from `personality.toolset ∩ registered_tools`. The LLM saw `get_weather` in its options and chose to call it.

If the personality didn't list the tool, the LLM would never see it. If the plugin didn't register the tool, the personality reference would be silently filtered. Both layers must agree.

## Going further

### Gate on environment variables

Use `isAvailable` to skip the tool if config is missing:

```typescript
const realWeatherTool = defineTool<{ city: string }>({
  name: 'get_weather',
  description: 'Return the current weather.',
  isAvailable: () => Boolean(process.env.WEATHER_API_KEY),
  schema: { /* ... */ },
  async execute({ city }, ctx) {
    const res = await fetch(`https://api.weatherapi.com/v1/current.json?key=${process.env.WEATHER_API_KEY}&q=${city}`);
    if (!res.ok) return err(`weather API ${res.status}`, 'execution_failed');
    const data = await res.json();
    return ok(`${data.current.temp_c}°C and ${data.current.condition.text} in ${data.location.name}`);
  },
});
```

A tool that returns `false` from `isAvailable()` is excluded from the LLM's tool list entirely. Useful for "this only works if you've configured X".

### Cap large outputs

Set `maxResultChars` if your tool can return a lot:

```typescript
const fetchPageTool = defineTool({
  name: 'fetch_page',
  maxResultChars: 20_000, // trim with `[truncated]` marker if exceeded
  // ...
});
```

The default per-call budget is 80,000 characters split across concurrent tool calls. Lower per-tool caps protect the conversation budget.

### Use the abort signal

Long-running tools should respect `ctx.abortSignal` so `/stop` and timeouts work:

```typescript
async execute({ url }, ctx) {
  const res = await fetch(url, { signal: ctx.abortSignal });
  // ...
}
```

### Publish it

Once you're happy with your plugin, publish it to npm:

```bash
npm publish
```

Then anyone can use it by installing the package and pointing `plugins:` at the package name:

```yaml title="~/.ethos/config.yaml"
plugins:
  - ethos-plugin-weather
```

## Troubleshooting

**"Tool 'get_weather' not found"** — the plugin loaded but the LLM is asking for a name that isn't registered. Confirm the `name` field in `defineTool` matches what's in `toolset.yaml`.

**The tool isn't being called** — first check `/tools` in chat to see what the active personality has access to. If `get_weather` isn't listed there, the personality's `toolset.yaml` is the issue. If it IS listed but the LLM never calls it, the description probably isn't compelling enough for the model to choose it — sharpen the wording.

**Plugin didn't load** — start `ethos chat --debug`. You'll see a line for each plugin attempted, with the error if loading failed. Common causes: wrong path in `config.yaml`, missing `npm install`, or a TypeScript syntax error.
