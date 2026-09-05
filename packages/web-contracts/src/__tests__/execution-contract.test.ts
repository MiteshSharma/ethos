import type { ExecutionPosture } from '@ethosagent/types';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { contract } from '../index';

// The `execution` namespace, and the structured execution posture the web UI
// reads (plan/phases/remote-execution-routing.md §6).
//
// Zod object schemas STRIP unknown keys rather than rejecting them, which makes
// an omission the quietest failure this package has: the resolver adds a field,
// the schema does not, and the field simply vanishes on the way to the browser
// with nothing thrown anywhere. `hostFallback`, `sshTarget` and `sshRefused`
// were all lost that way. So the posture assertions below are a ROUND TRIP over
// an object typed as the real `ExecutionPosture` with every optional field
// populated: a dropped field fails on the deep-equal, and a field removed from
// the interface fails at typecheck.
//
// Schemas are module-private, so they are reached through the contract the same
// way the server reaches them — the `instanceof` guard makes a change in oRPC's
// internals fail loudly here instead of silently skipping every assertion.

function schemaOf(procedure: unknown, field: 'inputSchema' | 'outputSchema'): z.ZodType {
  const def = (procedure as { '~orpc'?: Record<string, unknown> })['~orpc'];
  const schema = def?.[field];
  if (!(schema instanceof z.ZodType)) throw new Error(`contract has no ${field}`);
  return schema;
}

const probeOut = schemaOf(contract.execution.probeSsh, 'outputSchema');
const sheetOut = schemaOf(contract.personalities.characterSheet, 'outputSchema');

describe('execution.probeSsh', () => {
  it('carries the posture line in every state, including not_configured', () => {
    const parsed = probeOut.parse({
      usedBy: ['remote-hands'],
      result: { state: 'not_configured' },
    });
    // The case that matters most: a personality declares a remote posture and
    // there is no host for it to reach.
    expect(parsed).toEqual({ usedBy: ['remote-hands'], result: { state: 'not_configured' } });
  });

  it('round-trips a reachable answer with its target and latency', () => {
    const value = {
      usedBy: [],
      result: { state: 'reachable', target: 'deploy@build-01:22', latencyMs: 340 },
    };
    expect(probeOut.parse(value)).toEqual(value);
  });

  it('round-trips the ssh stderr unaltered', () => {
    const value = {
      usedBy: [],
      result: {
        state: 'unreachable',
        target: 'deploy@build-01:22',
        error: 'deploy@build-01: Permission denied (publickey).',
      },
    };
    expect(probeOut.parse(value)).toEqual(value);
  });

  it('keeps backend_unresolved a distinct state, not a flavour of unreachable', () => {
    const value = {
      usedBy: [],
      result: { state: 'backend_unresolved', target: 'build-01', error: 'not registered' },
    };
    expect(probeOut.parse(value)).toEqual(value);
    expect(() =>
      probeOut.parse({ usedBy: [], result: { state: 'nope', target: 'x', error: 'y' } }),
    ).toThrow();
  });

  it('refuses a reachable answer with no target — the pane renders that string', () => {
    expect(() =>
      probeOut.parse({ usedBy: [], result: { state: 'reachable', latencyMs: 1 } }),
    ).toThrow();
  });
});

describe('ExecutionPosture survives the wire whole', () => {
  /** Typed as the real interface, so a field REMOVED there fails to compile. */
  const posture: ExecutionPosture = {
    backend: 'ssh',
    networkMode: 'none',
    memoryMb: 2048,
    containerized: false,
    mounts: [{ hostPath: '/srv/work', containerPath: '/work', mode: 'rw' }],
    scratchPaths: ['/tmp'],
    hostFallback: { reason: 'ssh-unavailable' },
    sshTarget: 'deploy@build-01:22',
    sshRefused: {
      reason: 'constitution-requires-sandbox',
      message: 'ssh refused: constitution requires a sandbox',
    },
  };

  it('round-trips every field, including the three that used to be stripped', () => {
    const parsed = sheetOut.parse({ markdown: '# sheet', posture });
    // Deep-equal against the ORIGINAL: a schema that omits a key strips it, and
    // a happy-shape assertion would not notice.
    expect(parsed).toEqual({ markdown: '# sheet', posture });
  });

  it('names each restored field individually, so a single omission is diagnosable', () => {
    const parsed = sheetOut.parse({ markdown: '', posture });
    const out = (parsed as { posture: ExecutionPosture }).posture;
    expect(out.hostFallback).toEqual({ reason: 'ssh-unavailable' });
    // Already formatted by the resolver, and it prints only what the operator
    // configured — a host with no explicit port must never gain `:22` here.
    expect(out.sshTarget).toBe('deploy@build-01:22');
    expect(out.sshRefused?.message).toBe('ssh refused: constitution requires a sandbox');
  });

  it('keeps the dockerAbsent decision it already carried', () => {
    const docker: ExecutionPosture = {
      backend: 'docker',
      networkMode: 'bridge',
      memoryMb: 1024,
      containerized: true,
      mounts: [],
      scratchPaths: [],
      dockerAbsent: { blocked: true, canInstall: true, canConsentLocal: false },
    };
    expect(sheetOut.parse({ markdown: '', posture: docker })).toEqual({
      markdown: '',
      posture: docker,
    });
  });
});
