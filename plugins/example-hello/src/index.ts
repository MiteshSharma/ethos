/**
 * ethos-plugin-hello — example plugin showing all registration patterns.
 *
 * Demonstrates:
 *   1. registerTool        — a `greet` tool the LLM can call
 *   2. registerVoidHook    — logs when a session starts
 *   3. registerPersonality — a "friendly" personality variant
 */

import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, ok } from '@ethosagent/plugin-sdk/tool-helpers';

// ---------------------------------------------------------------------------
// 1. Tool — greet
// ---------------------------------------------------------------------------

const GREETINGS: Record<string, string> = {
  en: 'Hello',
  es: 'Hola',
  fr: 'Bonjour',
  de: 'Hallo',
  ja: 'こんにちは',
  pt: 'Olá',
};

export const greetTool = defineTool<{ name: string; language?: string }>({
  name: 'greet',
  description: 'Greet someone by name in their preferred language.',
  toolset: 'hello',
  schema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The name to greet' },
      language: {
        type: 'string',
        enum: Object.keys(GREETINGS),
        description: 'Language code (default: en)',
      },
    },
    required: ['name'],
  },
  async execute({ name, language = 'en' }) {
    const greeting = GREETINGS[language] ?? GREETINGS.en;
    return ok(`${greeting}, ${name}! 👋`);
  },
});

// ---------------------------------------------------------------------------
// 2. Hook — log session starts
// ---------------------------------------------------------------------------

async function onSessionStart(payload: { sessionId: string; platform: string }): Promise<void> {
  // In a real plugin you'd use a proper logger; console.error goes to stderr
  console.error(`[hello-plugin] session started: ${payload.sessionId} on ${payload.platform}`);
}

// ---------------------------------------------------------------------------
// 3. Personality — friendly
// ---------------------------------------------------------------------------

const friendlyPersonality = {
  id: 'friendly',
  name: 'Friendly',
  description: 'Warm, approachable, uses the greet tool to welcome users',
  model: 'claude-sonnet-4-6',
  memoryScope: 'global' as const,
  toolset: ['greet', 'memory_read', 'memory_write'],
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export function activate(api: EthosPluginApi): void {
  api.registerTool(greetTool);
  api.registerVoidHook('session_start', onSessionStart);
  api.registerPersonality(friendlyPersonality);
}

export function deactivate(): void {
  // Tools and hooks are removed automatically by PluginApiImpl.cleanup().
  // Add explicit teardown here only for external resources (DB connections, timers, etc.)
  console.error('[hello-plugin] deactivated');
}

// Export as default for loaders that expect a default export
const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
