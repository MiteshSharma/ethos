import type { AgentEvent } from '@ethosagent/core';
import { describe, expect, it } from 'vitest';
import { isVerbosity, nextVerbosity, projectEvent } from '../lib/verbosity';

const ev = {
  text(text: string): AgentEvent {
    return { type: 'text_delta', text };
  },
  toolStart(toolName: string): AgentEvent {
    return { type: 'tool_start', toolCallId: 'c1', toolName, args: {} };
  },
  progress(toolName: string, message: string, audience: 'user' | 'internal'): AgentEvent {
    return { type: 'tool_progress', toolName, message, audience };
  },
  toolEnd(toolName: string, ok: boolean, ms: number): AgentEvent {
    return { type: 'tool_end', toolCallId: 'c1', toolName, ok, durationMs: ms };
  },
  usage(inputTokens: number, outputTokens: number): AgentEvent {
    return { type: 'usage', inputTokens, outputTokens, estimatedCostUsd: 0.001 };
  },
};

describe('FW-10 verbosity projection', () => {
  describe('quiet', () => {
    it('emits only final assistant text', () => {
      const lines = projectEvent(ev.text('hello'), 'quiet');
      expect(lines).toEqual([{ text: 'hello', kind: 'text' }]);
    });

    it('drops every non-text event', () => {
      expect(projectEvent(ev.toolStart('ls'), 'quiet')).toEqual([]);
      expect(projectEvent(ev.progress('ls', 'half', 'user'), 'quiet')).toEqual([]);
      expect(projectEvent(ev.toolEnd('ls', true, 50), 'quiet')).toEqual([]);
      expect(projectEvent(ev.usage(10, 20), 'quiet')).toEqual([]);
    });
  });

  describe('default', () => {
    it('surfaces text + tool chips + usage', () => {
      expect(projectEvent(ev.text('hi'), 'default')).toHaveLength(1);
      expect(projectEvent(ev.toolStart('terminal'), 'default')[0].kind).toBe('tool_start');
      expect(projectEvent(ev.toolEnd('terminal', true, 312), 'default')[0].kind).toBe('tool_end');
      expect(projectEvent(ev.usage(50, 70), 'default')[0].kind).toBe('usage');
    });

    it('respects audience boundary — internal progress dropped', () => {
      expect(projectEvent(ev.progress('terminal', 'phase 2', 'internal'), 'default')).toEqual([]);
    });

    it('Lane E — internal inner-call tool_start/tool_end dropped (one chip per script)', () => {
      const innerStart: AgentEvent = {
        type: 'tool_start',
        toolCallId: 'call-1#3',
        toolName: 'read_file',
        args: {},
        audience: 'internal',
      };
      const innerEnd: AgentEvent = {
        type: 'tool_end',
        toolCallId: 'call-1#3',
        toolName: 'read_file',
        ok: false,
        durationMs: 4,
        audience: 'internal',
        error: 'boom',
      };
      expect(projectEvent(innerStart, 'default')).toEqual([]);
      // Internal ends stay hidden even on failure — inner errors are script data.
      expect(projectEvent(innerEnd, 'default')).toEqual([]);
      // verbose lifts the gate, same rule as tool_progress.
      expect(projectEvent(innerStart, 'verbose')).toHaveLength(1);
      expect(projectEvent(innerEnd, 'verbose')).toHaveLength(1);
    });

    it('surfaces user-opt-in progress', () => {
      const lines = projectEvent(ev.progress('read_file', 'reading 2MB', 'user'), 'default');
      expect(lines).toHaveLength(1);
      expect(lines[0].kind).toBe('tool_progress');
      expect(lines[0].text).toContain('read_file');
    });
  });

  describe('verbose', () => {
    it('lifts the audience boundary — internal progress surfaces', () => {
      const lines = projectEvent(ev.progress('terminal', 'phase 2', 'internal'), 'verbose');
      expect(lines).toHaveLength(1);
      expect(lines[0].text).toBe('· terminal: phase 2');
    });
  });

  describe('debug', () => {
    it('appends raw event JSON per event', () => {
      const lines = projectEvent(ev.text('x'), 'debug');
      expect(lines).toHaveLength(2);
      expect(lines[0].kind).toBe('text');
      expect(lines[1].kind).toBe('debug');
      expect(lines[1].text.startsWith('[debug] ')).toBe(true);
      expect(JSON.parse(lines[1].text.slice('[debug] '.length))).toEqual({
        type: 'text_delta',
        text: 'x',
      });
    });
  });

  describe('/verbose cycle order', () => {
    it('cycles default → verbose → debug → quiet → default', () => {
      expect(nextVerbosity('default')).toBe('verbose');
      expect(nextVerbosity('verbose')).toBe('debug');
      expect(nextVerbosity('debug')).toBe('quiet');
      expect(nextVerbosity('quiet')).toBe('default');
    });
  });

  describe('isVerbosity', () => {
    it('accepts the four valid levels', () => {
      expect(isVerbosity('quiet')).toBe(true);
      expect(isVerbosity('default')).toBe(true);
      expect(isVerbosity('verbose')).toBe(true);
      expect(isVerbosity('debug')).toBe(true);
    });

    it('rejects unknown strings', () => {
      expect(isVerbosity('chatty')).toBe(false);
      expect(isVerbosity('')).toBe(false);
    });
  });
});
