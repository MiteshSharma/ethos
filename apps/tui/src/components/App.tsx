import { homedir } from 'node:os';
import { basename } from 'node:path';
import type { AgentBridge } from '@ethosagent/agent-bridge';
import type { AgentLoop } from '@ethosagent/core';
import { DEFAULT_TOKENS } from '@ethosagent/design-tokens';
import { FsStorage } from '@ethosagent/storage-fs';
import type { PendingClarify, Session } from '@ethosagent/types';
import { createMemoryProvider } from '@ethosagent/wiring';
import { Box, Static, Text, useApp, useInput } from 'ink';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { buildHelpText, type ExternalSlashCommand } from '../help';
import {
  BUILTIN_SKIN_NAMES,
  BUILTIN_SKINS,
  personalityAccent,
  resolveSkin,
  SkinContext,
  type Tokens,
} from '../skin';
import { getUpdateStatus, type UpdateStatus } from '../update-check';
import { AccordionSection, type DetailsMode } from './AccordionSection';
import { type ChatMessage, ChatRow, StreamingRow } from './ChatPane';
import { ClarifyModal } from './ClarifyModal';
import { CompletionPanel, getMatches } from './CompletionPanel';
import { ConsoleHeader } from './ConsoleHeader';
import { ContextPanel } from './ContextPanel';
import { ExecutionTimeline, type TimelineEvent } from './ExecutionTimeline';
import { type FileActivity, FileActivityPanel } from './FileActivityPanel';
import { IdentityPanel } from './IdentityPanel';
import { InputBox } from './InputBox';
import { KeymapOverlay } from './KeymapOverlay';
import { ModelPickerModal } from './ModelPickerModal';
import { SafetyLane } from './SafetyLane';
import { SessionPickerModal } from './SessionPickerModal';
import { Splash, type SplashInventory } from './Splash';
import { type AgentStatus, type BudgetState, StatusBar } from './StatusBar';
import { type DelegationRecord, SubagentsPane } from './SubagentsPane';
import { ThinkingPane } from './ThinkingPane';
import { type ActiveTool, type CompletedTool, ToolSpinner } from './ToolSpinner';

interface TurnTiming {
  turnStart: number;
  turnEnd: number;
  firstTextDeltaAt: number | null;
  toolDurations: number[];
  turnUsage: { inputTokens: number; outputTokens: number; estimatedCostUsd: number } | null;
}

function fmtSecs(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : `${n}`;
}

function formatVerboseSummary(t: TurnTiming): string {
  const total = t.turnEnd - t.turnStart;
  const toolsTotal = t.toolDurations.reduce((a, b) => a + b, 0);
  const llm = Math.max(0, total - toolsTotal);
  const ttft = t.firstTextDeltaAt !== null ? t.firstTextDeltaAt - t.turnStart : null;
  const parts: string[] = [];
  parts.push(`llm ${fmtSecs(llm)}${ttft !== null ? ` (TTFT ${fmtSecs(ttft)})` : ''}`);
  if (t.toolDurations.length > 0) {
    const n = t.toolDurations.length;
    parts.push(`tools ${fmtSecs(toolsTotal)} (${n} call${n === 1 ? '' : 's'})`);
  }
  parts.push(`total ${fmtSecs(total)}`);
  if (t.turnUsage) {
    parts.push(`${fmtTokens(t.turnUsage.inputTokens)} in`);
    parts.push(`${fmtTokens(t.turnUsage.outputTokens)} out`);
    if (t.turnUsage.estimatedCostUsd > 0) {
      parts.push(`$${t.turnUsage.estimatedCostUsd.toFixed(3)}`);
    }
  }
  return `↳ ${parts.join(' · ')}`;
}

function extractDiff(result: string | undefined): string | undefined {
  if (!result) return undefined;
  const lines = result.split('\n');
  const diffStart = lines.findIndex(
    (l) => l.startsWith('@@') || l.startsWith('---') || l.startsWith('+++'),
  );
  if (diffStart === -1) return undefined;
  return lines.slice(diffStart).join('\n');
}

/**
 * Slash commands injected from outside the TUI (plugin commands). `dispatch`
 * returns null when no handler exists for `name` — the TUI then shows its
 * unknown-command hint. Provided by the host process; the TUI never imports
 * the plugin loader itself (layering).
 */
export interface ExternalSlashCommands {
  list(): ExternalSlashCommand[];
  dispatch(
    name: string,
    args: string,
    ctx: { sessionKey: string; personalityId: string },
  ): Promise<string | null>;
}

interface AppProps {
  bridge: AgentBridge;
  model: string;
  initialPersonality: string;
  initialSessionKey: string;
  initialVerbose?: boolean;
  /**
   * Named skin pinned by the user (config.yaml `skin:` or `--skin` flag).
   * When set (and valid), it is the active skin; otherwise the engine
   * default ('default') applies. Personalities carry no skin of their own.
   */
  initialSkin?: string;
  rebuildLoop?: (modelId: string) => Promise<AgentLoop>;
  inventory?: SplashInventory;
  version?: string;
  /** Transform user input before it is sent to the loop (e.g. @file/@url refs). */
  preprocessInput?: (text: string) => Promise<string>;
  /** Plugin slash commands — merged into /help and tried for unknown commands. */
  slashCommands?: ExternalSlashCommands;
  /** Subscribe to session-scoped notifications. Returns an unsubscribe. */
  onNotification?: (sessionKey: string, cb: (text: string) => void) => () => void;
  /** Subscribe to skill-evolver proposal notices. Returns an unsubscribe. */
  onSkillProposed?: (cb: (text: string) => void) => () => void;
}

/**
 * Skin resolution: a valid user pin (`--skin` flag, config.yaml, or
 * `/skin <name>`) wins; otherwise the engine default. Per-personality skin
 * overrides were removed in the personality-alignment phase — a personality
 * is an identity, not a theme.
 */
function pickEffectiveSkin(userPin: string | null): string {
  if (userPin && BUILTIN_SKINS[userPin]) return userPin;
  return 'default';
}

function resolveTokensFor(skinName: string): Tokens {
  try {
    return resolveSkin(DEFAULT_TOKENS, BUILTIN_SKINS, skinName);
  } catch {
    return DEFAULT_TOKENS;
  }
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
type FocusPane = 'identity' | 'context' | 'safety' | 'files' | 'timeline' | 'input';

export function App({
  bridge,
  model,
  initialPersonality,
  initialSessionKey,
  initialVerbose = false,
  initialSkin,
  rebuildLoop,
  inventory,
  version,
  preprocessInput,
  slashCommands,
  onNotification,
  onSkillProposed,
}: AppProps) {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streamingText, setStreamingText] = useState('');
  const [thinkingText, setThinkingText] = useState('');
  const [input, setInput] = useState('');
  const [activeTools, setActiveTools] = useState<ActiveTool[]>([]);
  const [completedTools, setCompletedTools] = useState<CompletedTool[]>([]);
  const [delegations, setDelegations] = useState<DelegationRecord[]>([]);
  const [running, setRunning] = useState(false);
  const [interrupted, setInterrupted] = useState(false);
  const [personality, setPersonality] = useState(initialPersonality);
  const [currentModel, setCurrentModel] = useState(model);
  const [sessionKey, setSessionKey] = useState(initialSessionKey);
  const [usage, setUsage] = useState({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
  const [statusMsg, setStatusMsg] = useState('');
  const [details, setDetails] = useState<DetailsState>(DEFAULT_DETAILS);
  // Skin state — a valid user pin wins, otherwise the engine default.
  // `userPinnedSkin` is the value the user set via `--skin` flag, config.yaml,
  // or `/skin <name>`. Per-personality skin overrides were removed in the
  // personality-alignment phase.
  const [userPinnedSkin, setUserPinnedSkin] = useState<string | null>(() =>
    initialSkin && BUILTIN_SKINS[initialSkin] ? initialSkin : null,
  );
  const [tokens, setTokens] = useState<Tokens>(() => {
    const effective = pickEffectiveSkin(
      initialSkin && BUILTIN_SKINS[initialSkin] ? initialSkin : null,
    );
    return resolveTokensFor(effective);
  });
  const applyTokensFor = useCallback((userPin: string | null): string => {
    const effective = pickEffectiveSkin(userPin);
    setTokens(resolveTokensFor(effective));
    return effective;
  }, []);
  const [modal, setModal] = useState<Modal>(null);
  const [clarifyRequest, setClarifyRequest] = useState<PendingClarify | null>(null);
  const [completionIndex, setCompletionIndex] = useState(0);
  const [timelineEvents, setTimelineEvents] = useState<TimelineEvent[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [historyDraft, setHistoryDraft] = useState('');
  const [columns, setColumns] = useState(process.stdout.columns ?? 120);
  const [focusPane, setFocusPane] = useState<FocusPane>('input');
  const [showKeymap, setShowKeymap] = useState(false);
  const [fileActivity, setFileActivity] = useState<FileActivity[]>([]);
  const [selectedPatchIndex, setSelectedPatchIndex] = useState(0);
  const [readonlyMode, setReadonlyMode] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null);
  const [budgetCapUsd, setBudgetCapUsd] = useState<number | null>(
    () => bridge.getPersonalityBudgetCap(initialPersonality) ?? null,
  );

  const verboseRef = useRef(initialVerbose);
  const [verboseDisplay, setVerboseDisplay] = useState(initialVerbose);
  const turnStartRef = useRef<number | null>(null);
  const firstTextDeltaAtRef = useRef<number | null>(null);
  const turnToolDurationsRef = useRef<number[]>([]);
  const turnUsageRef = useRef<TurnTiming['turnUsage']>(null);
  const [turnElapsed, setTurnElapsed] = useState(0);
  const fileByToolCallRef = useRef(
    new Map<string, { action: FileActivity['action']; path: string }>(),
  );
  const activityByToolCallRef = useRef(new Map<string, string>());
  const delegationByToolCallRef = useRef(new Map<string, string>());
  const idRef = useRef(0);
  const nextId = () => String(++idRef.current);

  // ---------------------------------------------------------------------------
  // HUD snapshot history (Ink overflow workaround)
  //
  // The chrome — ConsoleHeader + side-panel row — is too tall to fit in a
  // typical terminal viewport once stacked alongside even a few messages.
  // When Ink's dynamic frame exceeds viewport height, it can no longer
  // erase the previous frame cleanly (the bottom rows have scrolled off
  // screen), so each re-render appends a fresh full frame to scrollback
  // — the symptom users see as the HUD repeating after every turn.
  //
  // Fix: render the chrome inside `<Static>` as a snapshot. Each entry in
  // `hudSnapshots` prints exactly once and never re-renders. We append a
  // new snapshot only on major identity changes (personality / model /
  // session), so the chrome doesn't accumulate during normal chatting.
  // Live counters and turn state move into the bottom StatusBar.
  // ---------------------------------------------------------------------------
  interface HudSnap {
    id: string;
    personality: string;
    model: string;
    sessionKey: string;
    accentColor: string;
  }
  const [hudSnapshots, setHudSnapshots] = useState<HudSnap[]>(() => [
    {
      id: 'hud-initial',
      personality: initialPersonality,
      model,
      sessionKey: initialSessionKey,
      accentColor: personalityAccent(initialPersonality),
    },
  ]);

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
  const accentColor = useMemo(() => personalityAccent(personality), [personality]);
  const showIdentityPane = columns >= 90;
  const showSplash = messages.length === 0 && !running && !streamingText;

  // Focus order: side panels live in <Static> scrollback (the HUD snapshot)
  // and aren't part of the live Ink frame anymore, so only the input pane
  // is focusable. The 'files' pane stays in the list because patch approval
  // (a/d hotkeys) still operates on pendingPatchEntries from state — the
  // FileActivityPanel snapshot just shows the moment it was taken.
  const focusOrder = useMemo<FocusPane[]>(() => ['files', 'input'], []);

  const pushTimeline = (level: TimelineEvent['level'], text: string) => {
    const at = new Date().toISOString().slice(11, 19);
    setTimelineEvents((prev) => [...prev, { id: nextId(), at, level, text }]);
  };

  const extractPath = (args: unknown): string | null => {
    if (!args || typeof args !== 'object') return null;
    const obj = args as Record<string, unknown>;
    const raw = obj.filePath ?? obj.path ?? obj.filename;
    if (typeof raw !== 'string' || raw.trim().length === 0) return null;
    return raw;
  };

  const inferFileAction = (toolName: string): FileActivity['action'] | null => {
    if (toolName === 'read_file') return 'read';
    if (toolName === 'write_file') return 'write';
    if (toolName.includes('patch')) return 'patch';
    return null;
  };

  const pendingPatchEntries = useMemo(
    () => fileActivity.filter((e) => e.status === 'approval_required'),
    [fileActivity],
  );
  const selectedPatchEntry = pendingPatchEntries[selectedPatchIndex] ?? null;

  const appendFileActivity = (
    action: FileActivity['action'],
    path: string,
    status: FileActivity['status'],
  ): string => {
    const id = nextId();
    const at = new Date().toISOString().slice(11, 19);
    setFileActivity((prev) => [...prev, { id, at, action, path, status }]);
    return id;
  };

  const updateFileActivityStatus = (id: string, status: FileActivity['status'], diff?: string) => {
    const at = new Date().toISOString().slice(11, 19);
    setFileActivity((prev) =>
      prev.map((entry) =>
        entry.id === id ? { ...entry, status, at, ...(diff !== undefined ? { diff } : {}) } : entry,
      ),
    );
  };

  const delegationLabel = (toolName: string, args: unknown): string => {
    const a = args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
    if (toolName === 'delegate_task') {
      const p = typeof a.personality === 'string' ? ` -> ${a.personality}` : '';
      const label = typeof a.label === 'string' ? ` (${a.label})` : '';
      return `delegate_task${p}${label}`;
    }
    if (toolName === 'route_to_agent') {
      const capability = typeof a.capability === 'string' ? ` cap=${a.capability}` : '';
      return `route_to_agent${capability}`;
    }
    if (toolName === 'dispatch_team') {
      const tasks = Array.isArray(a.tasks) ? a.tasks.length : 0;
      return `dispatch_team tasks=${tasks}`;
    }
    if (toolName === 'mixture_of_agents') {
      const agents = Array.isArray(a.agents) ? a.agents.length : 0;
      return `mixture_of_agents agents=${agents}`;
    }
    if (toolName === 'broadcast_to_agents') {
      const capability = typeof a.capability === 'string' ? ` cap=${a.capability}` : '';
      return `broadcast_to_agents${capability}`;
    }
    return toolName;
  };

  const pushDelegation = (id: string, capability: string) => {
    setDelegations((prev) => [...prev, { id, capability, status: 'pending' }]);
  };

  const updateDelegation = (id: string, patch: Partial<DelegationRecord>) => {
    setDelegations((prev) => prev.map((d) => (d.id === id ? { ...d, ...patch } : d)));
  };

  const cycleFocus = (dir: 1 | -1) => {
    const idx = focusOrder.indexOf(focusPane);
    const current = idx === -1 ? focusOrder.length - 1 : idx;
    const next = (current + dir + focusOrder.length) % focusOrder.length;
    const pane = focusOrder[next] ?? 'input';
    setFocusPane(pane);
    setStatusMsg(`[focus: ${pane}]`);
  };

  useEffect(() => {
    if (version) {
      getUpdateStatus(version)
        .then(setUpdateStatus)
        .catch(() => null);
    }
  }, [version]);

  // Session-scoped notifications (e.g. plugin monitors via notify_session).
  // Re-subscribes when the session key changes (/new, /sessions) so routing
  // follows the active session, mirroring the readline path's re-register.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nextId closes over a stable ref
  useEffect(() => {
    if (!onNotification) return;
    return onNotification(sessionKey, (text) => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'system', text: `[notification] ${text}` },
      ]);
    });
  }, [onNotification, sessionKey]);

  // Skill-evolver proposal notices land in the transcript as system lines.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nextId closes over a stable ref
  useEffect(() => {
    if (!onSkillProposed) return;
    return onSkillProposed((text) => {
      setMessages((prev) => [...prev, { id: nextId(), role: 'system', text }]);
    });
  }, [onSkillProposed]);

  // Append a fresh HUD snapshot whenever the personality, model, or session
  // changes — these are the rare events that warrant re-showing the chrome.
  // Within a single conversation the snapshot stays put in scrollback above
  // the message log; the bottom StatusBar carries live turn state.
  // biome-ignore lint/correctness/useExhaustiveDependencies: nextId closes over a stable ref; intentionally react only to identity changes
  useEffect(() => {
    setHudSnapshots((prev) => {
      const last = prev[prev.length - 1];
      if (!last) return prev;
      if (
        last.personality === personality &&
        last.model === currentModel &&
        last.sessionKey === sessionKey
      ) {
        return prev;
      }
      return [
        ...prev,
        {
          id: `hud-${nextId()}`,
          personality,
          model: currentModel,
          sessionKey,
          accentColor,
        },
      ];
    });
  }, [personality, currentModel, sessionKey, accentColor]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional reset on match count change
  useEffect(() => {
    setCompletionIndex(0);
  }, [completionMatches.length]);

  useInput(
    (ch, key) => {
      if (showKeymap) {
        if (key.escape || ch === '?') setShowKeymap(false);
        return;
      }
      if (key.ctrl && ch === 'c') {
        if (running) {
          bridge.abortTurn();
          setInterrupted(true);
          pushTimeline('warning', 'turn aborted by user');
        } else {
          exit();
        }
        return;
      }
      if (key.tab) {
        if (focusPane === 'input' && completionVisible && !key.shift) return;
        cycleFocus(key.shift ? -1 : 1);
        return;
      }
      if (focusPane === 'files') {
        if (key.upArrow) {
          setSelectedPatchIndex((i) => Math.max(0, i - 1));
          return;
        }
        if (key.downArrow) {
          setSelectedPatchIndex((i) => Math.min(pendingPatchEntries.length - 1, i + 1));
          return;
        }
        if (ch === 'a' && selectedPatchEntry) {
          updateFileActivityStatus(selectedPatchEntry.id, 'approved');
          pushTimeline('success', `patch approved: ${selectedPatchEntry.path}`);
          setStatusMsg(`[approved] ${selectedPatchEntry.path}`);
          return;
        }
        if (ch === 'd' && selectedPatchEntry) {
          updateFileActivityStatus(selectedPatchEntry.id, 'denied');
          pushTimeline('error', `patch denied: ${selectedPatchEntry.path}`);
          setStatusMsg(`[denied] ${selectedPatchEntry.path}`);
          return;
        }
      }
      if (ch === '?' && (focusPane !== 'input' || input.length === 0)) {
        setShowKeymap(true);
      }
    },
    { isActive: modal === null && clarifyRequest === null },
  );

  useEffect(() => {
    if (!focusOrder.includes(focusPane)) setFocusPane('input');
  }, [focusPane, focusOrder]);

  useEffect(() => {
    if (pendingPatchEntries.length === 0) {
      setSelectedPatchIndex(0);
      return;
    }
    if (selectedPatchIndex >= pendingPatchEntries.length) {
      setSelectedPatchIndex(pendingPatchEntries.length - 1);
    }
  }, [pendingPatchEntries.length, selectedPatchIndex]);

  useEffect(() => {
    const onResize = () => setColumns(process.stdout.columns ?? 120);
    process.stdout.on('resize', onResize);
    return () => {
      process.stdout.off('resize', onResize);
    };
  }, []);

  useEffect(() => {
    if (!running) {
      setTurnElapsed(0);
      return;
    }
    const interval = setInterval(() => {
      if (turnStartRef.current !== null) {
        setTurnElapsed(Math.floor((Date.now() - turnStartRef.current) / 1000));
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [running]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nextId closes over a stable ref
  useEffect(() => {
    const onTextDelta = (text: string) => {
      if (firstTextDeltaAtRef.current === null) firstTextDeltaAtRef.current = Date.now();
      setStreamingText((prev) => prev + text);
    };

    const onThinkingDelta = (thinking: string) => setThinkingText((prev) => prev + thinking);

    const onDone = (text: string) => {
      const newMessages: ChatMessage[] = [];
      if (text.trim()) newMessages.push({ id: nextId(), role: 'assistant', text });
      if (verboseRef.current && turnStartRef.current !== null) {
        const summary = formatVerboseSummary({
          turnStart: turnStartRef.current,
          turnEnd: Date.now(),
          firstTextDeltaAt: firstTextDeltaAtRef.current,
          toolDurations: turnToolDurationsRef.current,
          turnUsage: turnUsageRef.current,
        });
        newMessages.push({ id: nextId(), role: 'assistant', text: summary });
      }
      if (newMessages.length > 0) setMessages((prev) => [...prev, ...newMessages]);
      setStreamingText('');
      setThinkingText('');
      setRunning(false);
      pushTimeline('success', 'turn complete');
    };

    const onToolStart = (toolCallId: string, toolName: string, args: unknown) => {
      setActiveTools((prev) => [...prev, { toolCallId, toolName }]);
      pushTimeline('info', `tool start: ${toolName}`);
      const isDelegationTool =
        toolName === 'delegate_task' ||
        toolName === 'mixture_of_agents' ||
        toolName === 'route_to_agent' ||
        toolName === 'dispatch_team' ||
        toolName === 'broadcast_to_agents';
      if (isDelegationTool) {
        const delegationId = nextId();
        delegationByToolCallRef.current.set(toolCallId, delegationId);
        pushDelegation(delegationId, delegationLabel(toolName, args));
      }
      const action = inferFileAction(toolName);
      const path = extractPath(args);
      if (action && path) {
        fileByToolCallRef.current.set(toolCallId, { action, path });
        const activityId = appendFileActivity(action, path, 'active');
        activityByToolCallRef.current.set(toolCallId, activityId);
      }
    };

    const onToolProgress = (toolName: string, message: string, percent: number | undefined) => {
      setActiveTools((prev) =>
        prev.map((t) => (t.toolName === toolName ? { ...t, message, percent } : t)),
      );
      if (message) {
        const suffix = percent !== undefined ? ` (${percent}%)` : '';
        pushTimeline('info', `${toolName}: ${message}${suffix}`);
      }
    };

    const onToolEnd = (
      toolCallId: string,
      toolName: string,
      ok: boolean,
      durationMs: number,
      result?: string,
    ) => {
      setActiveTools((prev) => prev.filter((t) => t.toolCallId !== toolCallId));
      setCompletedTools((prev) => [...prev, { id: toolCallId, toolName, ok, durationMs }]);
      turnToolDurationsRef.current.push(durationMs);
      const preview = result ? ` -> ${result.replace(/\s+/g, ' ').slice(0, 56)}` : '';
      pushTimeline(ok ? 'success' : 'error', `tool end: ${toolName} (${durationMs}ms)${preview}`);
      const fileMeta = fileByToolCallRef.current.get(toolCallId);
      const activityId = activityByToolCallRef.current.get(toolCallId);
      if (fileMeta && activityId) {
        const diff = extractDiff(result);
        const finalStatus: FileActivity['status'] =
          ok && fileMeta.action !== 'read' ? 'approval_required' : ok ? 'done' : 'error';
        updateFileActivityStatus(activityId, finalStatus, diff);
        fileByToolCallRef.current.delete(toolCallId);
        activityByToolCallRef.current.delete(toolCallId);
      }
      const delegationId = delegationByToolCallRef.current.get(toolCallId);
      if (delegationId) {
        updateDelegation(delegationId, {
          status: ok ? 'done' : 'failed',
          durationMs,
          ...(ok ? {} : { error: result?.slice(0, 200) }),
        });
        delegationByToolCallRef.current.delete(toolCallId);
      }
    };

    const onUsage = (inputTokens: number, outputTokens: number, estimatedCostUsd: number) => {
      setUsage((prev) => ({
        inputTokens: prev.inputTokens + inputTokens,
        outputTokens: prev.outputTokens + outputTokens,
        costUsd: prev.costUsd + estimatedCostUsd,
      }));
      turnUsageRef.current = { inputTokens, outputTokens, estimatedCostUsd };
    };

    const onError = (error: string, code: string) => {
      setMessages((prev) => [
        ...prev,
        { id: nextId(), role: 'assistant', text: `[${code}] ${error}` },
      ]);
      setStreamingText('');
      setThinkingText('');
      setRunning(false);
      pushTimeline('error', `[${code}] ${error}`);
    };

    const onQueued = (_input: string, queueDepth: number) => {
      pushTimeline('warning', `input queued (depth=${queueDepth})`);
    };

    const onIdle = () => {
      if (bridge.queueDepth > 0) {
        pushTimeline('info', `draining queue (remaining=${bridge.queueDepth})`);
      }
    };

    // Phase 5: update status bar when effective model differs from the
    // initial config (e.g. per-personality routing, team overrides).
    const onRunStart = (_provider: string, resolvedModel: string) => {
      setCurrentModel(resolvedModel);
    };

    bridge.on('text_delta', onTextDelta);
    bridge.on('thinking_delta', onThinkingDelta);
    bridge.on('done', onDone);
    bridge.on('tool_start', onToolStart);
    bridge.on('tool_progress', onToolProgress);
    bridge.on('tool_end', onToolEnd);
    bridge.on('usage', onUsage);
    bridge.on('error', onError);
    bridge.on('queued', onQueued);
    bridge.on('idle', onIdle);
    bridge.on('run_start', onRunStart);

    return () => {
      bridge.off('text_delta', onTextDelta);
      bridge.off('thinking_delta', onThinkingDelta);
      bridge.off('done', onDone);
      bridge.off('tool_start', onToolStart);
      bridge.off('tool_progress', onToolProgress);
      bridge.off('tool_end', onToolEnd);
      bridge.off('usage', onUsage);
      bridge.off('error', onError);
      bridge.off('queued', onQueued);
      bridge.off('idle', onIdle);
      bridge.off('run_start', onRunStart);
    };
  }, [bridge]);

  // Clarify surface — open the modal when the agent calls the `clarify` tool,
  // and close it when the request resolves (answer / timeout / cancel).
  // Registered through the bridge so it survives `replaceLoop` (model switch).
  useEffect(() => {
    bridge.setClarifyPresenter('tui', (req) => setClarifyRequest(req));
    return bridge.onClarifyResolved(() => setClarifyRequest(null));
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
    setHistoryIndex(null);
    setHistoryDraft('');
    setHistory((prev) => {
      if (value.trim().length === 0) return prev;
      if (prev.at(-1) === value) return prev;
      return [...prev, value];
    });
    if (value.startsWith('/')) {
      setInput('');
      await handleSlashCommand(value);
      return;
    }
    if (running) return;
    if (readonlyMode) {
      setStatusMsg('[readonly mode] execution blocked; use /readonly to disable');
      pushTimeline('warning', 'blocked prompt while readonly mode enabled');
      return;
    }
    setInput('');
    setMessages((prev) => [...prev, { id: nextId(), role: 'user', text: value }]);
    pushTimeline('info', `user: ${value.slice(0, 80)}`);
    setCompletedTools([]);
    setRunning(true);
    turnStartRef.current = Date.now();
    firstTextDeltaAtRef.current = null;
    turnToolDurationsRef.current = [];
    turnUsageRef.current = null;
    // Resolve @file/@url refs (and any other host preprocessing) before the
    // loop sees the input; the transcript keeps the raw text the user typed.
    let outgoing = value;
    if (preprocessInput) {
      try {
        outgoing = await preprocessInput(value);
      } catch {
        outgoing = value;
      }
    }
    bridge.send(outgoing, { sessionKey, personalityId: personality });
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
            text: buildHelpText(
              { readonlyMode, verbose: verboseDisplay },
              slashCommands?.list() ?? [],
            ),
          },
        ]);
        break;
      case 'new':
      case 'reset': {
        const oldKey = sessionKey;
        const newKey = `cli:${basename(process.cwd())}:${Date.now()}`;
        bridge.resetSessionCost(oldKey);
        setSessionKey(newKey);
        setMessages([]);
        setCompletedTools([]);
        setDelegations([]);
        setTimelineEvents([]);
        setFileActivity([]);
        setUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
        setStatusMsg('[new session started]');
        break;
      }
      case 'compact': {
        const focus = args.join(' ').trim();
        if (focus.toLowerCase() === 'status') {
          setStatusMsg('[context anatomy: run `ethos sessions show <id>` in the CLI]');
          break;
        }
        setStatusMsg('[compacting context…]');
        try {
          const result = await bridge.compact(sessionKey, {
            personalityId: personality,
            ...(focus ? { instructions: focus } : {}),
          });
          if (!result.ok) {
            setStatusMsg('[not enough history to compact yet]');
          } else {
            const saved = Math.max(0, result.preTotalTokens - result.postTotalTokens);
            const hint = result.summariesEnabled ? '' : ' (summaries disabled)';
            setStatusMsg(
              `[compacted ${result.droppedCount} msg via ${result.engineName}: −${saved.toLocaleString()} tok${hint}]`,
            );
          }
        } catch {
          setStatusMsg('[compaction failed]');
        }
        break;
      }
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
          const newPersonality = args[0] ?? personality;
          // A session's personality is bound at creation and immutable, so a
          // switch cannot mutate the active session — the next turn would be
          // refused with `personality_locked`. Rotate to a fresh session key
          // and reset the same per-session state `/new` resets.
          bridge.resetSessionCost(sessionKey);
          setSessionKey(`cli:${basename(process.cwd())}:${Date.now()}`);
          setPersonality(newPersonality);
          setBudgetCapUsd(bridge.getPersonalityBudgetCap(newPersonality) ?? null);
          setMessages([]);
          setCompletedTools([]);
          setDelegations([]);
          setTimelineEvents([]);
          setFileActivity([]);
          setUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
          setStatusMsg(
            `[personality: ${newPersonality} — new session started; personality is fixed for a session]`,
          );
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
          const mem = createMemoryProvider({
            dataDir: `${homedir()}/.ethos`,
            storage: new FsStorage(),
          });
          const result = await mem.prefetch({
            scopeId: `personality:${personality}`,
            sessionId: '',
            sessionKey,
            platform: 'cli',
            workingDir: process.cwd(),
          });
          if (result && result.entries.length > 0) {
            setMessages((prev) => [
              ...prev,
              {
                id: nextId(),
                role: 'assistant',
                text: result.entries.map((e) => e.content.trim()).join('\n\n'),
              },
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
      case 'budget': {
        if (args[0] === 'reset') {
          bridge.resetSessionCost(sessionKey);
          setUsage({ inputTokens: 0, outputTokens: 0, costUsd: 0 });
          setStatusMsg('[budget counter reset]');
          break;
        }
        const cap = budgetCapUsd;
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            text:
              cap != null
                ? `Session spend: $${usage.costUsd.toFixed(5)} / $${cap.toFixed(2)} cap`
                : `Session spend: $${usage.costUsd.toFixed(5)} (no cap set for this personality)`,
          },
        ]);
        break;
      }
      case 'readonly': {
        const next = !readonlyMode;
        setReadonlyMode(next);
        setStatusMsg(`readonly: ${next ? 'on' : 'off'}`);
        pushTimeline(next ? 'warning' : 'info', `readonly mode ${next ? 'enabled' : 'disabled'}`);
        break;
      }
      case 'verbose': {
        verboseRef.current = !verboseRef.current;
        setVerboseDisplay(verboseRef.current);
        setStatusMsg(`verbose: ${verboseRef.current ? 'on' : 'off'}`);
        break;
      }
      case 'details':
        handleDetailsCommand(args);
        break;
      case 'skin': {
        const sub = args[0] ?? '';
        if (sub === '' || sub === 'list') {
          const effective = pickEffectiveSkin(userPinnedSkin);
          const lines = BUILTIN_SKIN_NAMES.map((name) => {
            const marker = name === effective ? '*' : ' ';
            return `  ${marker} ${name.padEnd(10)} ${BUILTIN_SKINS[name].description}`;
          });
          const source = userPinnedSkin ? `pinned by user` : `engine default`;
          setMessages((prev) => [
            ...prev,
            {
              id: nextId(),
              role: 'assistant',
              text: `Skins:\n${lines.join('\n')}\nActive: ${effective} (${source})`,
            },
          ]);
          break;
        }
        if (sub === 'reset') {
          setUserPinnedSkin(null);
          const effective = applyTokensFor(null);
          setStatusMsg(`[skin: ${effective} — user pin cleared]`);
          break;
        }
        if (!BUILTIN_SKINS[sub]) {
          setStatusMsg(`Unknown skin: ${sub} — /skin list to see options`);
          break;
        }
        setUserPinnedSkin(sub);
        applyTokensFor(sub);
        setStatusMsg(`[skin: ${sub}]`);
        break;
      }
      case 'tools': {
        if (!inventory) {
          setStatusMsg('[no tool inventory available]');
          break;
        }
        const lines = inventory.tools.map((g) => `${g.toolset.padEnd(16)} ${g.names.join(', ')}`);
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            text: `Tools (${inventory.totalTools} total):\n${lines.join('\n')}`,
          },
        ]);
        break;
      }
      case 'skills': {
        if (!inventory || inventory.skills.length === 0) {
          setStatusMsg('[no skills installed]');
          break;
        }
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'assistant',
            text: `Skills (${inventory.skills.length}):\n${inventory.skills.join('\n')}`,
          },
        ]);
        break;
      }
      case 'learn': {
        const { parseLearnArgs, buildLearnPrompt } = await import('@ethosagent/core');
        const parsed = parseLearnArgs(args.join(' '));
        const prompt = buildLearnPrompt({
          hint: parsed.hint,
          description: parsed.description,
          personalityId: personality,
          sessionKey,
          surface: 'cli',
        });
        setMessages((prev) => [
          ...prev,
          {
            id: nextId(),
            role: 'user',
            text: `/learn${args.length > 0 ? ` ${args.join(' ')}` : ''}`,
          },
        ]);
        pushTimeline('info', 'user: /learn');
        setCompletedTools([]);
        setRunning(true);
        turnStartRef.current = Date.now();
        firstTextDeltaAtRef.current = null;
        turnToolDurationsRef.current = [];
        turnUsageRef.current = null;
        bridge.send(prompt, { sessionKey, personalityId: personality });
        break;
      }
      case 'exit':
      case 'quit':
        exit();
        break;
      default: {
        // Unknown built-in — fall through to externally injected commands
        // (plugins). dispatch returns null when nothing claims the name.
        if (slashCommands) {
          try {
            const result = await slashCommands.dispatch(name, args.join(' '), {
              sessionKey,
              personalityId: personality,
            });
            if (result !== null) {
              if (result.trim()) {
                setMessages((prev) => [...prev, { id: nextId(), role: 'assistant', text: result }]);
              }
              break;
            }
          } catch (err) {
            setStatusMsg(`[/${name} failed: ${err instanceof Error ? err.message : String(err)}]`);
            break;
          }
        }
        setStatusMsg(`Unknown command /${name} — type /help`);
      }
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
    setStatusMsg('Usage: /details [<section>] [<mode>]');
  };

  if (clarifyRequest) {
    const req = clarifyRequest;
    return (
      <SkinContext.Provider value={tokens}>
        <ClarifyModal
          request={req}
          onAnswer={(answer) => {
            setClarifyRequest(null);
            // D7 — a human acted on this surface; a background job's next
            // question may route here instead of falling back to its origin lane.
            bridge.clarifyBridge?.recordPresence('tui');
            void bridge.clarifyBridge?.respond({
              requestId: req.requestId,
              answer,
              source: 'user',
            });
          }}
          onCancel={() => {
            setClarifyRequest(null);
            bridge.clarifyBridge?.recordPresence('tui');
            void bridge.clarifyBridge?.respond({
              requestId: req.requestId,
              answer: '',
              source: 'cancel',
            });
          }}
        />
      </SkinContext.Provider>
    );
  }

  if (modal === 'sessions') {
    return (
      <SkinContext.Provider value={tokens}>
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

  if (modal === 'models') {
    return (
      <SkinContext.Provider value={tokens}>
        <ModelPickerModal
          current={currentModel}
          onSelect={async (entry) => {
            setModal(null);
            if (rebuildLoop) {
              setStatusMsg(`[switching model to ${entry.id}…]`);
              try {
                const newLoop = await rebuildLoop(entry.id);
                bridge.replaceLoop(newLoop);
                setCurrentModel(entry.id);
                setStatusMsg(`[model: ${entry.id}]`);
              } catch (err) {
                setStatusMsg(
                  `[model switch failed: ${err instanceof Error ? err.message : String(err)}]`,
                );
              }
            } else {
              setCurrentModel(entry.id);
              setStatusMsg(
                `[model: ${entry.id} — restart to persist; edit ~/.ethos/config.yaml to make permanent]`,
              );
            }
          }}
          onCancel={() => setModal(null)}
        />
      </SkinContext.Provider>
    );
  }

  return (
    <SkinContext.Provider value={tokens}>
      {/*
        HUD snapshot. The chrome prints once per personality/model/session via
        Ink's <Static> — see hudSnapshots state above for the rationale. The
        panels show whatever state was live when the snapshot was rendered;
        live turn-state (active tools, queue depth, pending patches) is
        carried by the bottom StatusBar.
      */}
      <Static items={hudSnapshots}>
        {(snap) => (
          <Box key={snap.id} flexDirection="column">
            <ConsoleHeader
              model={snap.model}
              personality={snap.personality}
              sessionKey={snap.sessionKey}
              accentColor={snap.accentColor}
            />
            <Box flexDirection="row" marginBottom={1}>
              {showIdentityPane && (
                <Box width={28}>
                  <IdentityPanel
                    personality={snap.personality}
                    status="idle"
                    delegationCount={0}
                    accentColor={snap.accentColor}
                  />
                </Box>
              )}
              <Box flexGrow={1} flexDirection="column">
                <ContextPanel
                  activeTools={[]}
                  completedTools={[]}
                  queueDepth={0}
                  messageCount={0}
                  pendingPatchCount={0}
                />
                <SafetyLane readonlyMode={false} tags={[]} />
                <FileActivityPanel entries={[]} />
              </Box>
            </Box>
          </Box>
        )}
      </Static>

      {/*
        Settled chat messages. Each ChatRow prints once via <Static>, landing
        in scrollback above the dynamic frame. Long conversations therefore
        never grow the in-place Ink output.
      */}
      <Static items={messages}>
        {(msg) => <ChatRow key={msg.id} message={msg} accentColor={accentColor} />}
      </Static>

      <Box flexDirection="column">
        {/*
          Dynamic frame: short by design so it always fits the viewport and
          can be redrawn in place. Holds the in-flight assistant response,
          accordion details, transient status, input box, and live status bar.
        */}
        {showSplash && inventory ? (
          <Splash
            model={currentModel}
            personality={personality}
            sessionKey={sessionKey}
            accentColor={accentColor}
            inventory={inventory}
          />
        ) : (
          <StreamingRow text={streamingText} accentColor={accentColor} />
        )}
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
        {resolveMode(details.activity, details.global) !== 'hidden' &&
          timelineEvents.length > 0 && (
            <AccordionSection
              title="activity"
              mode={resolveMode(details.activity, details.global)}
              count={timelineEvents.length}
            >
              <ExecutionTimeline events={timelineEvents} focused={focusPane === 'timeline'} />
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
        {showKeymap && (
          <Box marginBottom={1}>
            <KeymapOverlay focusPane={focusPane} running={running} />
          </Box>
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
          isActive={
            modal === null && clarifyRequest === null && !showKeymap && focusPane === 'input'
          }
          onChange={setInput}
          onSubmit={handleSubmit}
          onTabComplete={applyCompletion}
          onArrowUp={() => {
            if (completionVisible) {
              setCompletionIndex((i) => Math.max(0, i - 1));
              return;
            }
            if (history.length === 0) return;
            if (historyIndex === null) {
              setHistoryDraft(input);
              const nextIndex = history.length - 1;
              setHistoryIndex(nextIndex);
              setInput(history[nextIndex] ?? '');
              return;
            }
            const nextIndex = Math.max(0, historyIndex - 1);
            setHistoryIndex(nextIndex);
            setInput(history[nextIndex] ?? '');
          }}
          onArrowDown={() => {
            if (completionVisible) {
              setCompletionIndex((i) => Math.min(completionMatches.length - 1, i + 1));
              return;
            }
            if (historyIndex === null) return;
            const nextIndex = historyIndex + 1;
            if (nextIndex >= history.length) {
              setHistoryIndex(null);
              setInput(historyDraft);
              return;
            }
            setHistoryIndex(nextIndex);
            setInput(history[nextIndex] ?? '');
          }}
          onEscape={() => {
            if (completionVisible) {
              setInput('');
              return;
            }
            setHistoryIndex(null);
          }}
        />
        <StatusBar
          model={currentModel}
          personality={personality}
          accentColor={accentColor}
          inputTokens={usage.inputTokens}
          outputTokens={usage.outputTokens}
          costUsd={usage.costUsd}
          status={agentStatus}
          currentTool={currentTool}
          elapsedSecs={agentStatus === 'thinking' ? turnElapsed : undefined}
          readonlyMode={readonlyMode}
          backgroundCount={delegations.filter((d) => d.status === 'pending').length}
          updateStatus={updateStatus}
          budgetState={
            budgetCapUsd != null
              ? ({ spent: usage.costUsd, cap: budgetCapUsd } satisfies BudgetState)
              : null
          }
        />
      </Box>
    </SkinContext.Provider>
  );
}
