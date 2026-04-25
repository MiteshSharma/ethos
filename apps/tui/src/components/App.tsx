import { basename } from 'node:path';
import { Box, Text, useApp, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import type { AgentBridge } from '../agent-bridge';
import { type ChatMessage, ChatPane } from './ChatPane';
import { InputBox } from './InputBox';
import { StatusBar } from './StatusBar';
import { type ActiveTool, type CompletedTool, ToolSpinner } from './ToolSpinner';

interface AppProps {
  bridge: AgentBridge;
  model: string;
  initialPersonality: string;
  initialSessionKey: string;
}

export function App({ bridge, model, initialPersonality, initialSessionKey }: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [input, setInput] = useState('');
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [completedTools, setCompletedTools] = useState<CompletedTool[]>([]);
  const [running, setRunning] = useState(false);
  const [personality, setPersonality] = useState(initialPersonality);
  const [sessionKey, setSessionKey] = useState(initialSessionKey);
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const [statusMsg, setStatusMsg] = useState('');

  const idRef = useRef(0);
  const nextId = () => String(++idRef.current);

  // Ctrl+C: abort turn if running, exit if idle
  useInput((ch, key) => {
    if (key.ctrl && ch === 'c') {
      if (running) {
        bridge.abortTurn();
      } else {
        exit();
      }
    }
  });

  // Subscribe to bridge events
  // biome-ignore lint/correctness/useExhaustiveDependencies: nextId only closes over a stable ref
  useEffect(() => {
    const onTextDelta = (text: string) => setStreamingText((prev) => prev + text);

    const onDone = (text: string) => {
      if (text.trim()) {
        setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text }]);
      }
      setStreamingText('');
      setRunning(false);
    };

    const onToolStart = (toolCallId: string, toolName: string) => {
      setActiveTools((prev) => [...prev, { toolCallId, toolName }]);
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
      setRunning(false);
    };

    bridge.on('text_delta', onTextDelta);
    bridge.on('done', onDone);
    bridge.on('tool_start', onToolStart);
    bridge.on('tool_end', onToolEnd);
    bridge.on('usage', onUsage);
    bridge.on('error', onError);

    return () => {
      bridge.off('text_delta', onTextDelta);
      bridge.off('done', onDone);
      bridge.off('tool_start', onToolStart);
      bridge.off('tool_end', onToolEnd);
      bridge.off('usage', onUsage);
      bridge.off('error', onError);
    };
  }, [bridge]);

  const handleSubmit = async (value: string) => {
    if (!value.trim()) return;
    setStatusMsg('');

    if (value.startsWith('/')) {
      await handleSlashCommand(value);
      return;
    }

    if (running) return;

    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: value }]);
    setCompletedTools([]);
    setRunning(true);

    // fire-and-forget — events update state asynchronously
    bridge.send(value, { sessionKey, personalityId: personality });
  };

  const handleSlashCommand = async (cmd: string) => {
    const parts = cmd.slice(1).trim().split(/\s+/);
    const name = parts[0]?.toLowerCase() ?? '';
    const arg = parts.slice(1).join(' ');

    switch (name) {
      case 'help':
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            text:
              '/new  · fresh session\n' +
              '/personality [list|<id>]  · switch personality\n' +
              '/model <name>  · requires restart to take effect\n' +
              '/memory  · show ~/.ethos/MEMORY.md\n' +
              '/usage  · token and cost stats\n' +
              '/exit  · quit',
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
        if (!arg) {
          setStatusMsg(`personality: ${personality}`);
        } else if (arg === 'list') {
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              text: 'Built-ins: researcher · engineer · reviewer · coach · operator\nUser: ~/.ethos/personalities/<id>/',
            },
          ]);
        } else {
          setPersonality(arg);
          setStatusMsg(`[personality: ${arg}]`);
        }
        break;

      case 'model':
        setStatusMsg(
          'Model switching takes effect on next restart. Edit ~/.ethos/config.yaml to persist.',
        );
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

      case 'exit':
      case 'quit':
        exit();
        break;

      default:
        setStatusMsg(`Unknown command /${name} — type /help`);
    }
  };

  return (
    <Box flexDirection="column">
      <StatusBar
        model={model}
        personality={personality}
        inputTokens={usage.inputTokens}
        outputTokens={usage.outputTokens}
        costUsd={usage.costUsd}
        running={running}
      />
      <ChatPane messages={messages} streamingText={streamingText} />
      <ToolSpinner activeTools={activeTools} completedTools={completedTools} />
      {statusMsg && (
        <Box marginBottom={1}>
          <Text dimColor>{statusMsg}</Text>
        </Box>
      )}
      <InputBox
        value={input}
        disabled={running}
        onChange={setInput}
        onSubmit={(val) => {
          setInput('');
          handleSubmit(val);
        }}
      />
    </Box>
  );
}
