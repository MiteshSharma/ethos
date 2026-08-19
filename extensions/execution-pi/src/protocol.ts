// ---------------------------------------------------------------------------
// Pi's `--mode rpc` wire vocabulary — the subset this host consumes.
//
// Structural types, deliberately NOT imported from the Pi SDK: the adapter
// depends on the wire shape (documented in the package's `docs/rpc.md`), not on
// the package's TypeScript surface, so a pinned-version bump is a diff here and
// nowhere else. Every field below was observed live during the Phase 0 spike.
//
// Framing is strict JSONL with LF as the ONLY record delimiter — Pi's docs
// explicitly warn that Node's `readline` is not protocol-compliant because it
// also splits on U+2028/U+2029, which are legal inside JSON strings. Hence
// `JsonlReader` rather than readline.
// ---------------------------------------------------------------------------

/** Cumulative provider-reported usage, as carried on `message_update`. */
export interface PiUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: { total?: number };
}

/** One delta inside a streaming assistant message. */
export interface PiAssistantMessageEvent {
  type: string;
  delta?: string;
}

/** The events this adapter acts on. Unknown types are ignored, never fatal. */
export type PiEvent =
  | { type: 'agent_start' }
  | { type: 'agent_end'; willRetry?: boolean }
  | { type: 'agent_settled' }
  | { type: 'turn_start' }
  | {
      type: 'message_update';
      usage?: PiUsage;
      assistantMessageEvent?: PiAssistantMessageEvent;
    }
  | { type: 'tool_execution_start'; toolCallId: string; toolName: string; args?: unknown }
  | {
      type: 'tool_execution_end';
      toolCallId: string;
      toolName: string;
      isError?: boolean;
      result?: { content?: Array<{ type?: string; text?: string }> };
    }
  | { type: 'extension_ui_request'; id: string; method: string; title?: string }
  | { type: 'extension_error'; error?: string }
  | { type: 'response'; command?: string; success?: boolean; error?: string }
  | { type: string };

/** Commands this adapter writes back on stdin. */
export type PiCommand =
  | { id?: string; type: 'prompt'; message: string }
  /** Readiness handshake — answered only once Pi is up with its extensions loaded. */
  | { id?: string; type: 'get_state' }
  | { type: 'steer'; message: string }
  | { type: 'abort' }
  | { type: 'extension_ui_response'; id: string; value?: string; cancelled?: boolean };

/** Flatten a tool result's content blocks into the single text body `tool_end` carries. */
export function toolResultText(result: { content?: Array<{ text?: string }> } | undefined): string {
  return (result?.content ?? [])
    .map((block) => block.text ?? '')
    .filter((text) => text.length > 0)
    .join('\n');
}

/**
 * Incremental JSONL reader. Splits on `\n` only and tolerates a trailing `\r`,
 * exactly as Pi's RPC framing section requires. Holds a partial trailing record
 * across chunk boundaries.
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
