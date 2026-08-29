import { join } from 'node:path';
import { InMemoryStorage } from '@ethosagent/storage-fs';
import { describe, expect, it } from 'vitest';
import { type EthosConfig, ethosDir, readRawConfig } from '../index';

// `background.acp.agents.<name>.*` — the named ACP-agent roster (T4/I3,
// plan/phases/acp-job-runner.md). Three dotted levels (acp, agents, name,
// then field) — the same split `voice.tts.providers.<name>.<field>` already
// uses for its own named roster.

async function load(lines: string[]): Promise<EthosConfig> {
  const storage = new InMemoryStorage();
  await storage.mkdir(ethosDir());
  await storage.write(join(ethosDir(), 'config.yaml'), lines.join('\n'));
  const cfg = await readRawConfig(storage);
  if (!cfg) throw new Error('readRawConfig returned null');
  return cfg;
}

describe('background.acp.agents roster parsing', () => {
  it('parses a single agent entry with command, args and image', async () => {
    const cfg = await load([
      'background.acp.agents.claude.command: claude-agent-acp',
      'background.acp.agents.claude.image: localhost:5555/ethos-acp-claude@sha256:aaaa',
    ]);
    expect(cfg.background?.acp?.agents).toEqual({
      claude: {
        command: 'claude-agent-acp',
        image: 'localhost:5555/ethos-acp-claude@sha256:aaaa',
      },
    });
  });

  it('splits a comma-separated args field into a string array', async () => {
    const cfg = await load([
      'background.acp.agents.gemini.command: gemini',
      'background.acp.agents.gemini.args: --acp, --verbose',
      'background.acp.agents.gemini.image: localhost:5555/ethos-acp-gemini@sha256:bbbb',
    ]);
    expect(cfg.background?.acp?.agents?.gemini).toEqual({
      command: 'gemini',
      args: ['--acp', '--verbose'],
      image: 'localhost:5555/ethos-acp-gemini@sha256:bbbb',
    });
  });

  it('parses two independent agents into the same roster', async () => {
    const cfg = await load([
      'background.acp.agents.claude.command: claude-agent-acp',
      'background.acp.agents.claude.image: localhost:5555/ethos-acp-claude@sha256:aaaa',
      'background.acp.agents.gemini.command: gemini',
      'background.acp.agents.gemini.args: --acp',
      'background.acp.agents.gemini.image: localhost:5555/ethos-acp-gemini@sha256:bbbb',
    ]);
    expect(Object.keys(cfg.background?.acp?.agents ?? {})).toEqual(['claude', 'gemini']);
    expect(cfg.background?.acp?.agents?.claude?.command).toBe('claude-agent-acp');
    expect(cfg.background?.acp?.agents?.gemini?.args).toEqual(['--acp']);
  });

  it('drops an entry missing image or command rather than half-building it', async () => {
    const cfg = await load([
      'background.acp.agents.broken.command: claude-agent-acp',
      // no image for 'broken'
      'background.acp.agents.claude.command: claude-agent-acp',
      'background.acp.agents.claude.image: localhost:5555/ethos-acp-claude@sha256:aaaa',
    ]);
    expect(Object.keys(cfg.background?.acp?.agents ?? {})).toEqual(['claude']);
  });

  it('is absent when no background.acp key is present, same as background.pi today', async () => {
    const cfg = await load(['background.enabled: true']);
    expect(cfg.background?.acp).toBeUndefined();
  });

  it('coexists with background.pi — both can be configured at once', async () => {
    const cfg = await load([
      'background.pi_image: localhost:5555/ethos-pi@sha256:cccc',
      'background.acp.agents.claude.command: claude-agent-acp',
      'background.acp.agents.claude.image: localhost:5555/ethos-acp-claude@sha256:aaaa',
    ]);
    expect(cfg.background?.pi?.image).toBe('localhost:5555/ethos-pi@sha256:cccc');
    expect(cfg.background?.acp?.agents?.claude?.image).toBe(
      'localhost:5555/ethos-acp-claude@sha256:aaaa',
    );
  });
});
