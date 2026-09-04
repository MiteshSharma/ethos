import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import type { Tool, ToolContext, ToolRegistry, ToolResult } from '@ethosagent/types';
import { generateDummyArgs, validateAgainstSchema } from './tool-dummy-args';

// Backs `tools.detail` and `tools.test` — the Personality Edit modal's "what is
// this tool, and does it actually work here?" panel.
//
// Two things live here that the RPC shell must not decide for itself: the
// grouping rule shared with `tools.catalog`, and the safety gate that decides
// whether a verification click is allowed to really execute a tool.

/** How long a test execution may run before its abort signal fires. */
const TEST_TIMEOUT_MS = 10_000;
/** Cap on the `value` a test execution reports back to the browser. */
const TEST_RESULT_BUDGET_CHARS = 4000;

/** The slice of the personality wire type these functions read. Narrow on
 *  purpose: nothing here needs the other forty fields. */
export interface ToolTestPersonality {
  id: string;
  name: string;
  toolset: string[] | null;
  fs_reach?: { workdir?: string[] | null } | null;
}

export interface TestEligibility {
  canRun: boolean;
  reason?: string;
}

type CheckStatus = 'pass' | 'fail' | 'skip';
interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

/** The grouping `catalog` and `detail` both present. */
export function groupFor(toolset: string | undefined): string {
  return toolset ? toolset.charAt(0).toUpperCase() + toolset.slice(1) : 'Other';
}

/**
 * May `tools.test` ACTUALLY EXECUTE this tool?
 *
 * Everything here is derived from the tool's own declarations and re-derived on
 * every request — the client's `mode: 'run'` is a request, never a grant.
 *
 * NOTE: `ToolContext.dryRun` is deliberately not part of this. It exists on the
 * interface and AgentLoop threads it through, but no tool in the repo reads it,
 * so setting it makes nothing safe. The gate below is the whole safety story.
 *
 * Network reach alone does NOT disqualify a tool: a read-only fetch is exactly
 * the kind of thing an operator wants to verify before wiring a personality to
 * it.
 */
export function evaluateTestEligibility(tool: Tool): TestEligibility {
  const write = tool.capabilities.fs_reach?.write;
  if (write !== undefined && !(Array.isArray(write) && write.length === 0)) {
    return { canRun: false, reason: 'Tool declares filesystem write reach.' };
  }
  if (tool.capabilities.process !== undefined) {
    return { canRun: false, reason: 'Tool declares process (subprocess) capability.' };
  }
  if (tool.requiresApproval === true) {
    return { canRun: false, reason: 'Tool requires approval before every call.' };
  }
  const storage = tool.capabilities.storage;
  if (storage !== undefined && storage.scope !== 'tool-private') {
    return { canRun: false, reason: `Tool writes ${storage.scope}-scoped storage.` };
  }
  return { canRun: true };
}

/** A `null` toolset is an unrestricted personality; `alwaysInclude` bypasses
 *  the list entirely (see `DefaultToolRegistry.toDefinitions`). */
function reaches(toolset: string[] | null, name: string, alwaysInclude?: boolean): boolean {
  if (alwaysInclude) return true;
  return toolset === null || toolset.includes(name);
}

/**
 * Full detail for one tool.
 *
 * An unregistered name is not an error: a personality's toolset can name a tool
 * this deployment never registered (a plugin that failed to load, a personality
 * copied from another machine), and showing that is the point. It comes back
 * well-formed with `registered: false` rather than as a 404.
 */
export function describeTool(
  registry: ToolRegistry | undefined,
  name: string,
  personality?: ToolTestPersonality,
) {
  const tool = registry?.get(name);
  // Asked of the NAME, not the tool object, so an unregistered tool a
  // personality nonetheless lists still reports `true` — the mismatch is the
  // finding.
  const inToolset = personality
    ? { inPersonalityToolset: reaches(personality.toolset, name, tool?.alwaysInclude) }
    : {};

  if (!tool) {
    return {
      name,
      description: '',
      group: 'Other',
      schema: {},
      capabilities: {},
      hasSettingsSchema: false,
      registered: false,
      available: false,
      ...inToolset,
      testEligibility: { canRun: false, reason: 'Tool is not registered.' },
    };
  }

  const pluginId = registry?.getPluginId?.(name);
  return {
    name: tool.name,
    description: tool.description,
    ...(tool.toolset !== undefined ? { toolset: tool.toolset } : {}),
    group: groupFor(tool.toolset),
    schema: tool.schema,
    capabilities: tool.capabilities,
    ...(tool.maxResultChars !== undefined ? { maxResultChars: tool.maxResultChars } : {}),
    ...(tool.requiresApproval !== undefined ? { requiresApproval: tool.requiresApproval } : {}),
    ...(tool.outputIsUntrusted !== undefined ? { outputIsUntrusted: tool.outputIsUntrusted } : {}),
    ...(tool.alwaysInclude !== undefined ? { alwaysInclude: tool.alwaysInclude } : {}),
    ...(tool.returnDirect !== undefined ? { returnDirect: tool.returnDirect } : {}),
    hasSettingsSchema: tool.settingsSchema !== undefined,
    ...(pluginId !== undefined ? { pluginId } : {}),
    registered: true,
    available: !tool.isAvailable || tool.isAvailable(),
    ...inToolset,
    testEligibility: evaluateTestEligibility(tool),
  };
}

function check(id: string, label: string, status: CheckStatus, detail?: string): Check {
  return { id, label, status, ...(detail ? { detail } : {}) };
}

/** The first declared workdir, when it is usable as-is. Templated entries
 *  (`${CWD}`, `${ETHOS_HOME}`) need substitution vars this surface does not
 *  have, so they fall back to the server's own cwd rather than being resolved
 *  half-way. */
function resolveWorkingDir(workdirs: string[] | null | undefined): string {
  const first = workdirs?.[0];
  if (first && !first.includes('${') && isAbsolute(first)) return first;
  return process.cwd();
}

function toWireResult(result: ToolResult) {
  if (result.ok) {
    const value = result.value;
    return {
      ok: true,
      value:
        value.length <= TEST_RESULT_BUDGET_CHARS
          ? value
          : `${value.slice(0, TEST_RESULT_BUDGET_CHARS)}… [truncated]`,
    };
  }
  return { ok: false, error: result.error, code: result.code };
}

/**
 * Verify a tool against a personality, and — only when the safety gate agrees —
 * really execute it with schema-generated dummy arguments.
 */
export async function runToolTest(
  registry: ToolRegistry | undefined,
  name: string,
  personality: ToolTestPersonality,
  mode: 'verify' | 'run',
) {
  const tool = registry?.get(name);
  if (!registry || !tool) {
    const detail = registry
      ? `No tool named "${name}" is registered.`
      : 'No tool registry is wired into this deployment.';
    return {
      checks: [
        check('registered', 'Registered', 'fail' as const, detail),
        check('available', 'Available', 'skip' as const),
        check('in-toolset', 'In personality toolset', 'skip' as const),
        check('args-valid', 'Sample arguments valid', 'skip' as const),
      ],
      ran: false,
      testEligibility: { canRun: false, reason: detail },
    };
  }

  const checks: Check[] = [check('registered', 'Registered', 'pass')];

  const available = !tool.isAvailable || tool.isAvailable();
  checks.push(
    available
      ? check('available', 'Available', 'pass')
      : check(
          'available',
          'Available',
          'fail',
          'The tool reports itself unavailable — a required key, binary, or service is missing.',
        ),
  );

  const inToolset = reaches(personality.toolset, tool.name, tool.alwaysInclude);
  checks.push(
    inToolset
      ? check(
          'in-toolset',
          'In personality toolset',
          'pass',
          tool.alwaysInclude ? 'Always included, regardless of toolset.' : undefined,
        )
      : check(
          'in-toolset',
          'In personality toolset',
          'fail',
          `"${personality.name}" does not list this tool, so it cannot call it.`,
        ),
  );

  const args = generateDummyArgs(tool.schema);
  const argErrors = validateAgainstSchema(tool.schema, args);
  checks.push(
    argErrors.length === 0
      ? check('args-valid', 'Sample arguments valid', 'pass', JSON.stringify(args))
      : check('args-valid', 'Sample arguments valid', 'fail', argErrors.join('; ')),
  );

  // Re-derived here, not carried from the client: `mode: 'run'` asks, the gate
  // decides. An ineligible tool degrades to verify-only rather than erroring.
  const eligibility = evaluateTestEligibility(tool);
  const allPassed = checks.every((c) => c.status === 'pass');
  if (mode !== 'run' || !eligibility.canRun || !allPassed) {
    const reason = eligibility.canRun
      ? allPassed
        ? undefined
        : 'One or more checks failed, so the tool was not executed.'
      : eligibility.reason;
    return {
      checks,
      ran: false,
      testEligibility: { canRun: eligibility.canRun, ...(reason ? { reason } : {}) },
    };
  }

  const id = randomUUID();
  const ctx: ToolContext = {
    sessionId: `tool-test:${id}`,
    sessionKey: `tool-test:${id}`,
    platform: 'web',
    workingDir: resolveWorkingDir(personality.fs_reach?.workdir),
    personalityId: personality.id,
    currentTurn: 0,
    messageCount: 0,
    abortSignal: AbortSignal.timeout(TEST_TIMEOUT_MS),
    emit: () => {},
    resultBudgetChars: TEST_RESULT_BUDGET_CHARS,
  };

  // Through `executeParallel`, never `tool.execute`: the test must traverse the
  // same allowlist and filter enforcement a real call does, or it is exercising
  // a path production never takes.
  const started = Date.now();
  const results = await registry.executeParallel(
    [{ toolCallId: `tool-test-${id}`, name: tool.name, args }],
    ctx,
    [tool.name],
  );
  const elapsed = Date.now() - started;
  const first = results[0];

  if (!first) {
    return {
      checks,
      ran: false,
      testEligibility: { canRun: true, reason: 'The registry returned no result for the call.' },
    };
  }

  return {
    checks,
    ran: true,
    result: toWireResult(first.result),
    durationMs: first.durationMs ?? elapsed,
    testEligibility: { canRun: true },
  };
}
