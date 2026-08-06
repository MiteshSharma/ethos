// Lane 3(b) — declared small-window toolset narrowing (eng review D20).
//
// A personality may declare, via `context_engine_options.small_window_toolset`,
// which of its tools survive small-window mode — DECLARED, not inferred: the
// personality author knows which of its twelve tools matter; the framework
// does not. When small-window mode is active AND the key is declared, the
// effective toolset narrows to the declared set. The narrowed set gates BOTH
// `toDefinitions()` (the menu the model sees) AND `executeParallel`'s
// allowlist (what can execute) — it is the effective toolset, not a display
// filter. A personality declaring nothing keeps its full toolset (and gets
// the wiring-level schema-budget warning instead).

/**
 * Parse a `context_engine_options.small_window_toolset` value. Accepts a
 * comma-separated string (the flat config.yaml shape) or a string array
 * (programmatic personalities). Returns undefined when absent, malformed, or
 * empty — no narrowing.
 */
export function parseSmallWindowToolset(value: unknown): string[] | undefined {
  let names: string[];
  if (typeof value === 'string') {
    names = value.split(',').map((s) => s.trim());
  } else if (Array.isArray(value) && value.every((v): v is string => typeof v === 'string')) {
    names = value.map((s) => s.trim());
  } else {
    return undefined;
  }
  const filtered = names.filter((n) => n.length > 0);
  return filtered.length > 0 ? filtered : undefined;
}
