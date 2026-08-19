/**
 * The Ethos tool-call gate — a Pi extension, loaded with `--extension` and
 * executed by Pi INSIDE the container. It is not part of the Ethos runtime and
 * must never import from it.
 *
 * Why it exists: Pi has no permission system for its own built-in tools
 * (`bash`/`edit`/`write`/`read` execute unconditionally). The extension API's
 * `tool_call` handler is the ONLY point where a host can see a tool call before
 * it runs and refuse it — and `ctx.ui.select()` in `--mode rpc` turns that into
 * an `extension_ui_request` frame on stdout that blocks the tool until the host
 * answers on stdin. That round-trip is the seam Phase 4 routes real elicitation
 * through; this file is what makes it exist.
 *
 * The types are declared structurally rather than imported from
 * `@earendil-works/pi-coding-agent` so this file stays dependency-free in both
 * directions: Ethos does not take a build dependency on Pi's SDK, and the file
 * still typechecks in this repo.
 */

interface GateUi {
  select(title: string, options: string[]): Promise<string | undefined>;
}

interface GateContext {
  ui: GateUi;
  hasUI: boolean;
  mode: string;
}

interface GateToolCall {
  toolName: string;
  input?: Record<string, unknown>;
}

interface GateBlock {
  block: true;
  reason: string;
}

interface GateExtensionApi {
  on(
    event: 'tool_call',
    handler: (event: GateToolCall, ctx: GateContext) => Promise<GateBlock | undefined>,
  ): void;
}

/** Keeps a title readable in a log line and bounded on the wire. */
const DIGEST_CAP = 500;

function digestOf(input: Record<string, unknown> | undefined): string {
  let raw: string;
  try {
    raw = JSON.stringify(input ?? {}) ?? '';
  } catch {
    raw = String(input);
  }
  const collapsed = raw.replace(/\s+/g, ' ').trim();
  return collapsed.length > DIGEST_CAP ? `${collapsed.slice(0, DIGEST_CAP - 3)}...` : collapsed;
}

export default function (pi: GateExtensionApi): void {
  pi.on('tool_call', async (event, ctx) => {
    // `select` carries a title and options and nothing else, so the title IS
    // the payload channel: `ethos:tool_call:<toolName>\n<digest>`. The host
    // parses it back in `parseGateTitle`; the two must change together.
    const title = `ethos:tool_call:${event.toolName}\n${digestOf(event.input)}`;
    if (!ctx.hasUI) {
      // No host is listening (an interactive/`-p` run without our transport).
      // Refuse rather than run ungated: this extension is only ever loaded by
      // the Ethos runner, so a missing host means something is wrong.
      return { block: true, reason: 'Ethos gate: no host attached to answer' };
    }
    const choice = await ctx.ui.select(title, ['allow', 'deny']);
    if (choice !== 'allow') {
      return { block: true, reason: 'Blocked by Ethos policy' };
    }
    return undefined;
  });
}
