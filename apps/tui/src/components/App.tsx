import { basename } from 'node:path';
import type { AgentBridge } from '@ethosagent/agent-bridge';
import type { Session } from '@ethosagent/types';
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useMemo, useRef, useState } from 'react';
import { SKINS, type SkinConfig, SkinContext } from '../skin';
import { AccordionSection, type DetailsMode } from './AccordionSection';
import { type ChatMessage, ChatPane } from './ChatPane';
import { CompletionPanel, getMatches } from './CompletionPanel';
import { InputBox } from './InputBox';
import { ModelPickerModal } from './ModelPickerModal';
import { SessionPickerModal } from './SessionPickerModal';
import { type AgentStatus, StatusBar } from './StatusBar';
import { type DelegationRecord, SubagentsPane } from './SubagentsPane';
import { ThinkingPane } from './ThinkingPane';
import { type ActiveTool, type CompletedTool, ToolSpinner } from './ToolSpinner';

interface AppProps {
  bridge: AgentBridge;
  model: string;
  initialPersonality: string;
  initialSessionKey: string;
}

interface DetailsState {
  global: DetailsMode;
  thinking: DetailsMode | null;
  tools: DetailsMode | null;
  subagents: DetailsMode | null;
  activity: DetailsMode | null;
}

const DEFAULT_DETAILS: DetailsState = {
  global: 'collapsed',
  thinking: 'expanded',
  tools: 'expanded',
  subagents: null,
  activity: 'hidden',
};

function resolveMode(section: DetailsMode | null, global: DetailsMode): DetailsMode {
  return section ?? global;
}

type Modal = 'sessions' | 'models' | null;

export function App({ bridge, model, initialPersonality, initialSessionKey }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [input, setInput] = useState('');
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [completedTools, setCompletedTools] = useState<CompletedTool[]>([]);
  const [delegations] = useState<DelegationRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [personality, setPersonality] = useState(initialPersonality);
  const [currentModel, setCurrentModel] = useState(model);
  const [sessionKey, setSessionKey] = useState(initialSessionKey);
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const [statusMsg, setStatusMsg] = useState('');
  const [details, setDetails] = useState<DetailsState>(DEFAULT_DETAILS);
  const [skin, setSkin] = useState<SkinConfig>(SKINS.default);
  const [modal, setModal] = useState<Modal>(null);
  const [completionIndex, setCompletionIndex] = useState(0);

  const idRef = useRef(0);
  const nextId = () => String(++idRef.current);

  const completionMatches = useMemo(() => getMatches(input), [input]);
  const completionVisible = completionMatches.length > 0 && input.startsWith('/');

  const agentStatus: AgentStatus = useMemo(() => {
    if (interrupted) return 'interrupted';
    if (activeTools.length > 0) return 'running';
    if (running) return 'thinking';
    return 'idle';
  }, [interrupted, activeTools.length, running]);

  const currentTool =
    activeTools.length > 0 ? activeTools[activeTools.length - 1]?.toolName : undefined;

  // Reset completion index when matches change
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — reset when match count changes
  useEffect(() => {
    setCompletionIndex(0);
  }, [completionMatches.length]);

  // Ctrl+C: abort turn if running, exit if idle
  useInput(
    (ch, key) => {
      if (key.ctrl && ch === 'c') {
        if (running) {
          bridge.abortTurn();
          setInterrupted(true);
        } else {
          exit();
        }
      }
    },
    { isActive: modal === null },
  );

  // Subscribe to bridge events
  // biome-ignore lint/correctness/useExhaustiveDependencies: nextId only closes over a stable ref
  useEffect(() => {
    const onTextDelta = (text: string) => setStreamingText((prev) => prev + text);

    const onThinkingDelta = (thinking: string) => setThinkingText((prev) => prev + thinking);

    const onDone = (text: string) => {
      if (text.trim()) {
        setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text }]);
      }
      setStreamingText('');
      setThinkingText('');
      setRunning(false);
    };

    const onToolStart = (toolCallId: string, toolName: string) => {
      setActiveTools((prev) => [...prev, { toolCallId, toolName }]);
    };

    const onToolProgress = (toolName: string, message: string, percent: number | undefined) => {
      setActiveTools((prev) =>
        prev.map((t) => (t.toolName === toolName ? { ...t, message, percent } : t)),
      );
    };

    const onToolEnd = (toolCallId: string, toolName: string, ok: boolean, durationMs: number) => {
      setActiveTools((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
      setCompletedTools((prev) => [...prev, { id: toolCallId, toolName, ok, durationMs }]);
    };

    const onUsage = (inputTokens: number, outputTokens: number, estimatedCostUsd: number) => {
      setUsage((prev) => ({
        inputTokens: prev.inputTokens + inputTokens,
        outputTokens: prev.outputTokens + outputTokens,
        costUsd: prev.costUsd + estimatedCostUsd,
      }));
    };

    const onError = (error: string, code: string) => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', text: `[${code}] ${error}` },
      ]);
      setStreamingText('');
      setThinkingText('');
      setRunning(false);
    };

    bridge.on('text_delta', onTextDelta);
    bridge.on('thinking_delta', onThinkingDelta);
    bridge.on('done', onDone);
    bridge.on('tool_start', onToolStart);
    bridge.on('tool_progress', onToolProgress);
    bridge.on('tool_end', onToolEnd);
    bridge.on('usage', onUsage);
    bridge.on('error', onError);

    return () => {
      bridge.off('text_delta', onTextDelta);
      bridge.off('thinking_delta', onThinkingDelta);
      bridge.off('done', onDone);
      bridge.off('tool_start', onToolStart);
      bridge.off('tool_progress', onToolProgress);
      bridge.off('tool_end', onToolEnd);
      bridge.off('usage', onUsage);
      bridge.off('error', onError);
    };
  }, [bridge]);

  const applyCompletion = () => {
    if (!completionVisible) return;
    const match = completionMatches[completionIndex];
    if (!match) return;
    setInput(`/${match.name} `);
  };

  const handleSubmit = async (value: string) => {
    if (!value.trim()) return;
    setStatusMsg('');
    setInterrupted(false);

    if (value.startsWith('/')) {
      setInput('');
      await handleSlashCommand(value);
      return;
    }

    if (running) return;

    setInput('');
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: value }]);
    setCompletedTools([]);
    setRunning(true);

    bridge.send(value, { sessionKey, personalityId: personality });
  };

  const handleSlashCommand = async (cmd: string) => {
    const parts = cmd.slice(1).trim().split(/\s+/);
    const name = parts[0]?.toLowerCase() ?? '';
    const args = parts.slice(1);

    switch (name) {
      case 'help':
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            text:
              '/new                          fresh session\n' +
              '/personality [list|<id>]      switch personality\n' +
              '/model                        open model picker\n' +
              '/sessions                     open session picker\n' +
              '/memory                       show ~/.ethos/MEMORY.md\n' +
              '/usage                        token + cost stats\n' +
              '/details [hidden|collapsed|expanded] [section]\n' +
              '/skin [list|<name>]           switch UI theme\n' +
              '/exit                         quit',
          },
        ]);
        break;

      case 'new':
      case 'reset':
        setSessionKey(`cli:${basename(process.cwd())}:${Date.now()}`);
        setMessages([]);
        setCompletedTools([]);
        setStatusMsg('[new session started]');
        break;

      case 'personality':
        if (args.length === 0) {
          setStatusMsg(`personality: ${personality}`);
        } else if (args[0] === 'list') {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              text: 'Built-ins: researcher · engineer · reviewer · coach · operator\nUser: ~/.ethos/personalities/<id>/',
            },
          ]);
        } else {
          setPersonality(args[0] ?? personality);
          setStatusMsg(`[personality: ${args[0]}]`);
        }
        break;

      case 'model':
        setModal('models');
        break;

      case 'sessions':
        setModal('sessions');
        break;

      case 'memory': {
        try {
          const { MarkdownFileMemoryProvider } = await import('@ethosagent/memory-markdown');
          const mem = new MarkdownFileMemoryProvider();
          const result = await mem.prefetch({ sessionId: '', sessionKey, platform: 'cli' });
          if (result) {
            setMessages((prev) => [
              ...prev,
              { id: nextId(), role: 'assistant', text: result.content },
            ]);
          } else {
            setStatusMsg('[no memory yet — chat to build it]');
          }
        } catch (err) {
          setStatusMsg(`[memory error: ${err instanceof Error ? err.message : String(err)}]`);
        }
        break;
      }

      case 'usage':
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            text:
              `Tokens: ${usage.inputTokens.toLocaleString()} in · ${usage.outputTokens.toLocaleString()} out\n` +
              `Cost: $${usage.costUsd.toFixed(5)}`,
          },
        ]);
        break;

      case 'details':
        handleDetailsCommand(args);
        break;

      case 'skin':
        if (args.length === 0 || args[0] === 'list') {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              text: `Skins: ${Object.keys(SKINS).join(' · ')}\nCurrent: ${skin.name}`,
            },
          ]);
        } else {
          const next = SKINS[args[0] ?? ''];
          if (next) {
            setSkin(next);
            setStatusMsg(`[skin: ${next.name}]`);
          } else {
            setStatusMsg(`Unknown skin: ${args[0]}`);
          }
        }
        break;

      case 'exit':
      case 'quit':
        exit();
        break;

      default:
        setStatusMsg(`Unknown command /${name} — type /help`);
    }
  };

  const handleDetailsCommand = (args: string[]) => {
    const VALID_SECTIONS = ['thinking', 'tools', 'subagents', 'activity'] as const;
    const VALID_MODES = ['hidden', 'collapsed', 'expanded'] as const;
    type Section = (typeof VALID_SECTIONS)[number];
    type Mode = (typeof VALID_MODES)[number];

    if (args.length === 0) {
      setDetails((d) => {
        const next: DetailsMode =
          d.global === 'collapsed' ? 'expanded' : d.global === 'expanded' ? 'hidden' : 'collapsed';
        return { ...d, global: next };
      });
      return;
    }

    const first = args[0] ?? '';

    if ((VALID_MODES as readonly string[]).includes(first)) {
      setDetails((d) => ({ ...d, global: first as Mode }));
      return;
    }

    if ((VALID_SECTIONS as readonly string[]).includes(first)) {
      const section = first as Section;
      const second = args[1];
      if (second === 'reset') {
        setDetails((d) => ({ ...d, [section]: null }));
        return;
      }
      if (second && (VALID_MODES as readonly string[]).includes(second)) {
        setDetails((d) => ({ ...d, [section]: second as Mode }));
        return;
      }
      setStatusMsg(`Usage: /details ${section} <hidden|collapsed|expanded|reset>`);
      return;
    }

    setStatusMsg(`Usage: /details [<section>] [<mode>]`);
  };

  // ── Modal: Session picker ───────────────────────────────────────────────
  if (modal === 'sessions') {
    return (
      <SkinContext.Provider value={skin}>
        <SessionPickerModal
          onSelect={(s: Session) => {
            setSessionKey(s.key);
            setMessages([]);
            setCompletedTools([]);
            setPersonality(s.personalityId ?? personality);
            setModal(null);
            setStatusMsg(`[resumed: ${s.title ?? s.key}]`);
          }}
          onCancel={() => setModal(null)}
        />
      </SkinContext.Provider>
    );
  }

  // ── Modal: Model picker ─────────────────────────────────────────────────
  if (modal === 'models') {
    return (
      <SkinContext.Provider value={skin}>
        <ModelPickerModal
          current={currentModel}
          onSelect={(entry) => {
            setCurrentModel(entry.id);
            setModal(null);
            setStatusMsg(
              `[model: ${entry.id} — restart to persist; edit ~/.ethos/config.yaml to make permanent]`,
            );
          }}
          onCancel={() => setModal(null)}
        />
      </SkinContext.Provider>
    );
  }

  // ── Main view ───────────────────────────────────────────────────────────
  return (
    <SkinContext.Provider value={skin}>
      <Box flexDirection="column">
        <StatusBar
          model={currentModel}
          personality={personality}
          inputTokens={usage.inputTokens}
          outputTokens={usage.outputTokens}
          costUsd={usage.costUsd}
          status={agentStatus}
          currentTool={currentTool}
        />

        <ChatPane messages={messages} streamingText={streamingText} />

        {thinkingText && (
          <AccordionSection title="thinking" mode={resolveMode(details.thinking, details.global)}>
            <ThinkingPane text={thinkingText} />
          </AccordionSection>
        )}

        {(activeTools.length > 0 || completedTools.length > 0) && (
          <AccordionSection
            title="tools"
            mode={resolveMode(details.tools, details.global)}
            count={activeTools.length + completedTools.length}
          >
            <ToolSpinner activeTools={activeTools} completedTools={completedTools} />
          </AccordionSection>
        )}

        {delegations.length > 0 && (
          <AccordionSection
            title="subagents"
            mode={resolveMode(details.subagents, details.global)}
            count={delegations.length}
          >
            <SubagentsPane delegations={delegations} />
          </AccordionSection>
        )}

        {statusMsg && (
          <Box marginBottom={1}>
            <Text dimColor>{statusMsg}</Text>
          </Box>
        )}

        {completionVisible && (
          <CompletionPanel matches={completionMatches} selectedIndex={completionIndex} />
        )}

        <InputBox
          value={input}
          disabled={running}
          isActive={modal === null}
          onChange={setInput}
          onSubmit={handleSubmit}
          onTabComplete={applyCompletion}
          onArrowUp={() => {
            if (completionVisible) {
              setCompletionIndex((i) => Math.max(0, i - 1));
            }
          }}
          onArrowDown={() => {
            if (completionVisible) {
              setCompletionIndex((i) => Math.min(completionMatches.length - 1, i + 1));
            }
          }}
          onEscape={() => {
            if (completionVisible) setInput('');
          }}
        />
      </Box>
    </SkinContext.Provider>
  );
}
