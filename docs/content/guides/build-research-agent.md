---
sidebar_position: 2
title: Build a Research Agent
---

# Build a Research Agent

This guide builds a research-focused agent from scratch — a custom personality with web search, URL reading, and structured citation output.

## What we're building

An agent that:
- Searches the web for a topic
- Reads the top sources
- Synthesizes findings with citations
- Saves a structured report to disk

## 1. Create the personality

```bash
mkdir -p ~/.ethos/personalities/researcher
```

**`~/.ethos/personalities/researcher/ETHOS.md`**

```markdown
# Researcher

I am a methodical research assistant. My role is to find, verify, and synthesize information from multiple sources.

## How I work

When given a research question:
1. I search for at least 3 independent sources
2. I cross-reference claims across sources
3. I distinguish between facts, expert opinion, and speculation
4. I cite every claim with its source URL
5. I acknowledge what I don't know or can't verify

## Communication style

- Structured with clear sections
- Citations inline: [Source Name](url)
- Uncertainty flagged explicitly: "I could not verify..."
- No speculation without labeling it as such
```

**`~/.ethos/personalities/researcher/config.yaml`**

```yaml
name: Researcher
description: Methodical, citation-focused research assistant
model: claude-opus-4-7-20251101
memoryScope: global
```

**`~/.ethos/personalities/researcher/toolset.yaml`**

```yaml
tools:
  - search_web
  - read_url
  - write_file
  - memory_read
  - memory_write
```

## 2. Verify the personality loads

```bash
ethos chat
/personality researcher
# Should show: Switched to researcher personality
```

## 3. Add a web search tool

If you haven't set up web search yet, add a Brave Search or Tavily integration.

**Brave Search** (free tier: 2,000 searches/month):

1. Get an API key at [brave.com/search/api](https://brave.com/search/api)
2. Set `BRAVE_API_KEY` in your environment

**Tavily** (built for AI agents):

1. Get an API key at [tavily.com](https://tavily.com)
2. Set `TAVILY_API_KEY` in your environment

Add to `~/.ethos/config.yaml`:

```yaml
tools:
  - name: search_web
    provider: tavily
```

## 4. Run your first research session

```bash
ethos chat
/personality researcher
```

Then ask:

```
Research the current state of AI agent frameworks. I want a comparison of
LangChain, CrewAI, AutoGen, and Ethos, focusing on production readiness
and TypeScript support.
```

The researcher will:
1. Search for each framework
2. Read documentation and recent articles
3. Return a structured comparison with citations

## 5. Save reports automatically

The researcher personality has `write_file` in its toolset. Ask it to save:

```
Save your findings as a Markdown report at ~/research/agent-frameworks-2025.md
```

Or instruct the agent in ETHOS.md to always save reports:

```markdown
## Output format

After completing research, always:
1. Display the findings in chat
2. Save a structured Markdown report to `~/research/<topic-slug>-<date>.md`
```

## 6. Add memory for ongoing research

The researcher has `global` memory scope, so it remembers context across sessions. On the first session, tell it who you are:

```
I'm building an AI agent framework called Ethos. I'm specifically
interested in comparing architecture patterns, not just feature lists.
```

This gets saved to `USER.md` and injected into every future research session.

## 7. Schedule recurring research

For ongoing topic monitoring, combine with the cron scheduler:

```bash
# Add to ~/.ethos/cron.yaml
- schedule: "0 8 * * 1"   # every Monday at 8am
  personality: researcher
  prompt: "Search for any major news or releases in AI agent frameworks this week. Save a brief update to ~/research/weekly-ai-update.md"
```

## Tips for better research

**Be specific about depth**: "Give me a 1-page summary" vs "Give me a comprehensive 10-page report with full citations" produce very different outputs.

**Specify source types**: "Focus on peer-reviewed papers" or "Only use official documentation and primary sources" focuses the researcher.

**Use follow-up questions**: Research is iterative. Ask "What does [source X] say about [claim Y]?" to dig deeper on specific points.

**Cross-session continuity**: The researcher saves session summaries to memory. Start a new session with "Continue the research from last time" to pick up where you left off.
