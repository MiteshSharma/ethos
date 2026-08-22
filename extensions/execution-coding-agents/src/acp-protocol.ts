// ---------------------------------------------------------------------------
// The real Agent Client Protocol's wire vocabulary — the subset this host
// speaks. See https://agentclientprotocol.com/.
//
// Structural types, deliberately NOT imported from `@agentclientprotocol/sdk`:
// the adapter depends on the WIRE SHAPE (the published JSON-RPC schema), not on
// that package's evolving TypeScript surface, so a pinned-version bump is a
// diff here and nowhere else — same rationale `extensions/execution-pi/src/
// protocol.ts` gives for not importing Pi's own SDK types.
//
// Every shape below was read directly out of `@agentclientprotocol/sdk@1.3.0`'s
// generated `dist/schema/types.gen.d.ts` (fetched from the real npm package
// during this phase, not guessed or inferred from the spec prose) and trimmed
// to the fields this host actually uses. Framing is newline-delimited JSON-RPC
// 2.0 over stdio — the same SDK's `ndJsonStream` doc comment names this as the
// standard stdio transport, so `JsonlReader` below (LF-delimited, tolerant of
// a trailing `\r`) is the same framing choice `execution-pi`'s host already
// made for its own stdio protocol, not a new one invented for this package.
// ---------------------------------------------------------------------------

/** The one ACP protocol version this host has been checked against. */
export const ACP_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 envelope
// ---------------------------------------------------------------------------

export type JsonRpcId = string | number;

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

export interface JsonRpcErrorObj {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcSuccess {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: unknown;
}

export interface JsonRpcFailure {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObj;
}

export type JsonRpcResponse = JsonRpcSuccess | JsonRpcFailure;
export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

export function isJsonRpcRequest(m: JsonRpcMessage): m is JsonRpcRequest {
  return 'method' in m && 'id' in m;
}

export function isJsonRpcNotification(m: JsonRpcMessage): m is JsonRpcNotification {
  return 'method' in m && !('id' in m);
}

export function isJsonRpcResponse(m: JsonRpcMessage): m is JsonRpcResponse {
  return !('method' in m) && 'id' in m;
}

/** JSON-RPC 2.0's reserved "method not found" code. */
export const JSON_RPC_METHOD_NOT_FOUND = -32601;

// ---------------------------------------------------------------------------
// Method name constants actually used (subset of `@agentclientprotocol/sdk`'s
// `methods` export).
// ---------------------------------------------------------------------------

export const ACP_METHODS = {
  initialize: 'initialize',
  sessionNew: 'session/new',
  sessionPrompt: 'session/prompt',
  sessionCancel: 'session/cancel',
  sessionUpdate: 'session/update',
  requestPermission: 'session/request_permission',
} as const;

// ---------------------------------------------------------------------------
// initialize
// ---------------------------------------------------------------------------

export interface AcpInitializeParams {
  protocolVersion: number;
  clientCapabilities?: {
    fs?: { readTextFile?: boolean; writeTextFile?: boolean };
    terminal?: boolean;
  };
  clientInfo?: { name: string; version?: string };
}

export interface AcpInitializeResult {
  protocolVersion: number;
  agentCapabilities?: Record<string, unknown>;
  authMethods?: Array<{ id: string; name: string; description?: string | null }>;
  agentInfo?: { name: string; version?: string } | null;
}

// ---------------------------------------------------------------------------
// session/new
// ---------------------------------------------------------------------------

export interface AcpNewSessionParams {
  cwd: string;
  mcpServers: unknown[];
}

export interface AcpNewSessionResult {
  sessionId: string;
}

// ---------------------------------------------------------------------------
// session/prompt
// ---------------------------------------------------------------------------

export interface AcpTextContentBlock {
  type: 'text';
  text: string;
}

/** Open union — the baseline (`text`, `resource_link`) plus whatever else the agent sends. */
export type AcpContentBlock = AcpTextContentBlock | { type: string; [key: string]: unknown };

export interface AcpPromptParams {
  sessionId: string;
  prompt: AcpContentBlock[];
}

export type AcpStopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'max_turn_requests'
  | 'refusal'
  | 'cancelled';

export interface AcpPromptResult {
  stopReason: AcpStopReason;
  usage?: { totalTokens?: number; inputTokens?: number; outputTokens?: number } | null;
}

// ---------------------------------------------------------------------------
// session/update (agent -> client notification)
// ---------------------------------------------------------------------------

export type AcpToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

/** The real schema's closed `ToolKind` enum — categorizes what the tool DOES, not the interaction. */
export type AcpToolKind =
  | 'read'
  | 'edit'
  | 'delete'
  | 'move'
  | 'search'
  | 'execute'
  | 'think'
  | 'fetch'
  | 'switch_mode'
  | 'other';

/** Every `AcpToolKind` value, for building a `RunnerCapabilities.interactionKinds` roster. */
export const ACP_TOOL_KINDS: readonly AcpToolKind[] = [
  'read',
  'edit',
  'delete',
  'move',
  'search',
  'execute',
  'think',
  'fetch',
  'switch_mode',
  'other',
];

export interface AcpToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  /** UNSTABLE in the real schema (may be removed/changed) — the closest ACP gets to a tool name. */
  name?: string | null;
  kind?: AcpToolKind | null;
  status?: AcpToolCallStatus | null;
  rawInput?: unknown;
  rawOutput?: unknown;
  // NOTE: the real schema's `content: Array<ToolCallContent>` (`content` |
  // `diff` | `terminal` variants) is deliberately NOT modeled here. A `diff`
  // entry is file-change data — per the plan's Architecture caveat this must
  // route through `job_events`/`ctx.emitArtifact`, never through `AgentEvent`
  // or a `tool_end.result` string — and doing that routing for real is Open
  // Question 3 / T6, unresolved until a real agent's payload shape is seen.
  // Trimmed out here rather than half-modeled and silently mishandled.
}

/** `session/update`'s `tool_call` variant — same fields as an update, plus a required title. */
export interface AcpToolCall extends AcpToolCallUpdate {
  title: string;
}

export type AcpSessionUpdate =
  | { sessionUpdate: 'user_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_message_chunk'; content: AcpContentBlock }
  | { sessionUpdate: 'agent_thought_chunk'; content: AcpContentBlock }
  | ({ sessionUpdate: 'tool_call' } & AcpToolCall)
  | ({ sessionUpdate: 'tool_call_update' } & AcpToolCallUpdate)
  // Open — plan/plan_update/available_commands_update/etc. all fall through
  // here; this host only acts on the variants named above (see host.ts).
  | { sessionUpdate: string; [key: string]: unknown };

export interface AcpSessionNotificationParams {
  sessionId: string;
  update: AcpSessionUpdate;
}

// ---------------------------------------------------------------------------
// session/request_permission (agent -> client request)
// ---------------------------------------------------------------------------

export type AcpPermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: AcpPermissionOptionKind;
}

export interface AcpRequestPermissionParams {
  sessionId: string;
  toolCall: AcpToolCallUpdate;
  options: AcpPermissionOption[];
}

export type AcpRequestPermissionOutcome =
  | { outcome: 'cancelled' }
  | { outcome: 'selected'; optionId: string };

export interface AcpRequestPermissionResult {
  outcome: AcpRequestPermissionOutcome;
}

// ---------------------------------------------------------------------------
// Framing
// ---------------------------------------------------------------------------

/**
 * Incremental JSONL reader. Splits on `\n` only and tolerates a trailing `\r`
 * — the same framing `execution-pi`'s `JsonlReader` uses, copied rather than
 * imported (D-ACP1/D-ACP2: no shared file between this package and Pi's).
 * Holds a partial trailing record across chunk boundaries.
 */
export class JsonlReader {
  private buffer = '';

  /** Feed a decoded chunk; returns every complete record it completed. */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines: string[] = [];
    for (;;) {
      const nl = this.buffer.indexOf('\n');
      if (nl === -1) break;
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.trim().length > 0) lines.push(line);
    }
    return lines;
  }
}
