import { useState } from 'react';
import type { ToolBlock } from '../../lib/chat-reducer';

// Inline tool chip — a pill that sits between text spans in the
// assistant turn, NOT a card. DESIGN.md voice rules in effect:
//
//   • status icon (running/✓/✗) + color, never color alone
//   • tool name in mono (Geist Mono, the dev-tool data convention)
//   • collapsed args preview
//   • click the chip to expand — full args + result panel below
//
// Border radius is sm (4px). No shadow, no card chrome. The chip lives
// inline with text and earns its place via content, not decoration.

export interface ToolChipProps {
  tool: ToolBlock;
}

export function ToolChip({ tool }: ToolChipProps) {
  const [expanded, setExpanded] = useState(false);
  const argsPreview = previewArgs(tool.args);
  const ariaLabel = ariaLabelFor(tool, argsPreview);

  return (
    <div className="tool-chip-wrapper">
      <button
        type="button"
        className={`tool-chip tool-chip-${tool.status}`}
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-label={ariaLabel}
      >
        <StatusIcon status={tool.status} />
        <span className="tool-chip-name">{tool.toolName}</span>
        {argsPreview ? <span className="tool-chip-args">{argsPreview}</span> : null}
        {tool.durationMs !== undefined ? (
          <span className="tool-chip-duration">{formatDuration(tool.durationMs)}</span>
        ) : null}
      </button>
      {expanded ? <ToolChipDetail tool={tool} /> : null}
    </div>
  );
}

function ToolChipDetail({ tool }: { tool: ToolBlock }) {
  return (
    <div className="tool-chip-detail">
      <ToolChipSection label="args">
        <pre>{formatJson(tool.args)}</pre>
      </ToolChipSection>
      {tool.result !== undefined ? (
        <ToolChipSection label={tool.status === 'failed' ? 'error' : 'result'}>
          <pre>{tool.result}</pre>
        </ToolChipSection>
      ) : tool.status === 'running' ? (
        <ToolChipSection label="result">
          <span style={{ opacity: 0.6 }}>running…</span>
        </ToolChipSection>
      ) : null}
    </div>
  );
}

function ToolChipSection({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="tool-chip-section">
      <span className="tool-chip-section-label">{label}</span>
      {children}
    </div>
  );
}

function StatusIcon({ status }: { status: ToolBlock['status'] }) {
  if (status === 'pending-approval') {
    return (
      <span className="tool-chip-status" aria-hidden="true">
        ?
      </span>
    );
  }
  if (status === 'running') {
    return (
      <span className="tool-chip-status" aria-hidden="true">
        <span className="tool-chip-spinner" />
      </span>
    );
  }
  if (status === 'ok') {
    return (
      <span className="tool-chip-status" aria-hidden="true">
        ✓
      </span>
    );
  }
  return (
    <span className="tool-chip-status" aria-hidden="true">
      ✗
    </span>
  );
}

/**
 * Single-line preview of args. Long objects collapse; primitives flow as-is.
 * The preview lives next to the tool name in the chip — it should hint at
 * what the call is doing, not show the full payload.
 */
function previewArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return truncate(args, 60);
  if (typeof args !== 'object') return String(args);

  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return '';

  // Single-key objects are the common case (path: 'x', url: 'x', command: 'x') —
  // show the value, since the key is implicit in the tool name.
  if (entries.length === 1) {
    const entry = entries[0];
    if (!entry) return '';
    const [, value] = entry;
    return typeof value === 'string' ? truncate(value, 60) : truncate(JSON.stringify(value), 60);
  }

  // Multi-key: show the first key's value (usually the most informative one).
  const entry = entries[0];
  if (!entry) return '';
  const [, value] = entry;
  return typeof value === 'string' ? truncate(value, 60) : truncate(JSON.stringify(value), 60);
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function ariaLabelFor(tool: ToolBlock, argsPreview: string): string {
  const status =
    tool.status === 'pending-approval'
      ? 'awaiting approval'
      : tool.status === 'running'
        ? 'running'
        : tool.status === 'ok'
          ? 'completed'
          : 'failed';
  const args = argsPreview ? ` with ${argsPreview}` : '';
  return `${tool.toolName} ${status}${args}`;
}
