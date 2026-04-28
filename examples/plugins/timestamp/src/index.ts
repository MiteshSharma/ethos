/**
 * ethos-plugin-timestamp — Tool example
 *
 * Pattern demonstrated: a self-contained tool with no external deps,
 * optional configuration via env var, isAvailable() always true.
 */

import type { EthosPlugin, EthosPluginApi } from '@ethosagent/plugin-sdk';
import { defineTool, err, ok } from '@ethosagent/plugin-sdk/tool-helpers';

export const timestampTool = defineTool<{ timezone?: string; format?: 'iso' | 'unix' | 'human' }>({
  name: 'get_timestamp',
  description:
    'Return the current date and time. Optionally specify a timezone (IANA name, e.g. "America/New_York") and output format.',
  toolset: 'timestamp',
  schema: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA timezone name (default: UTC)',
      },
      format: {
        type: 'string',
        enum: ['iso', 'unix', 'human'],
        description: 'Output format: iso (default), unix (epoch seconds), human (locale string)',
      },
    },
  },
  async execute({ timezone = 'UTC', format = 'iso' }) {
    const now = new Date();

    try {
      switch (format) {
        case 'unix':
          return ok(String(Math.floor(now.getTime() / 1000)));

        case 'human': {
          const formatted = now.toLocaleString('en-US', {
            timeZone: timezone,
            dateStyle: 'full',
            timeStyle: 'long',
          });
          return ok(formatted);
        }
        default: {
          // toLocaleString with a specific timezone, then reformat as ISO-like string
          const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
          }).formatToParts(now);

          const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
          const isoLocal = `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')} (${timezone})`;
          return ok(isoLocal);
        }
      }
    } catch {
      return err(
        `Unknown timezone: "${timezone}". Use an IANA name like "America/New_York".`,
        'input_invalid',
      );
    }
  },
});

export function activate(api: EthosPluginApi): void {
  api.registerTool(timestampTool);
}

export function deactivate(): void {}

const plugin: EthosPlugin = { activate, deactivate };
export default plugin;
