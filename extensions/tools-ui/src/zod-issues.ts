/**
 * Zod issue → tool-error translation, shared by `emit_card` and `render_ui`.
 *
 * The wording matters: `ToolResult.error` is what the loop's repair machinery
 * (`packages/core/src/agent-loop/schema-coerce.ts`) hands back to the model on
 * a retry, so each issue gets its own `path: message` line rather than one
 * blurred sentence.
 */

/** Structural view of a zod issue — avoids a direct zod dependency here. */
export interface ValidationIssue {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}

function dotted(path: ReadonlyArray<PropertyKey>): string {
  return path.map(String).join('.');
}

/** One `path: message` line per issue; root-level issues read as `(root)`. */
export function issueLines(issues: ReadonlyArray<ValidationIssue>): string {
  return issues.map((issue) => `${dotted(issue.path) || '(root)'}: ${issue.message}`).join('\n');
}

/** The first issue's dotted path under `prefix`, for `ToolResult.field`. */
export function issueField(issues: ReadonlyArray<ValidationIssue>, prefix: string): string {
  const first = issues[0];
  const path = first ? dotted(first.path) : '';
  return path ? `${prefix}.${path}` : prefix;
}
