import { join } from 'node:path';
import { BoundaryError, type Tool, type ToolContext, type ToolResult } from '@ethosagent/types';
import {
  CANVAS_LIBRARIES,
  CARD_SPEC_VERSION,
  CanvasCardPayloadSchema,
} from '@ethosagent/web-contracts';
import { isUiPlatform, offSurfaceRefusal } from './ui-platform';
import { issueField, issueLines } from './zod-issues';

/**
 * Resolves a personality's own directory — the one holding `SOUL.md` and the
 * `ui/` template folder.
 *
 * tools-ui never computes that path itself, for the same reason
 * `AssetDirResolver` exists: the derivation lives behind wiring, which holds
 * the personality registry. `undefined` means the directory could not be
 * resolved (unknown personality, or a config-only personality with no
 * `SOUL.md`) — template mode then refuses rather than guessing at a path.
 */
export type PersonalityDirResolver = (personalityId: string) => string | undefined;

export interface RenderUiArgs {
  title?: string;
  html?: string;
  template?: string;
  data?: unknown;
  libraries?: string[];
}

const HTML_MAX_CHARS = 65536;
const DATA_MAX_CHARS = 32768;
/** No dots, no separators, no traversal — checked before any path is joined. */
const TEMPLATE_NAME = /^[a-zA-Z0-9_-]+$/;

const DESCRIPTION = `Render personality-authored HTML on a sandboxed Canvas — for shapes the typed \`emit_card\` kinds cannot express. Prefer \`emit_card\` whenever the data fits one of its kinds.

Supply exactly one of:
- \`template\`: the name of a \`ui/<template>.html\` file in your own personality directory (letters, digits, hyphens, underscores only). The file is inlined server-side.
- \`html\`: a one-off document body, max ${HTML_MAX_CHARS} chars.

\`data\` is any JSON value (max ${DATA_MAX_CHARS} chars serialized), injected into the frame as a frozen global for the template's script to read — keep the markup and the data separate. \`libraries\` is an optional subset of the locally bundled allowlist: ${CANVAS_LIBRARIES.join(', ')}.

The frame has no network access, no cookies and no reach into the page around it, so everything it needs must be in the HTML, an allowlisted library, or \`data\`.`;

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export const createRenderUiTool = (personalityDir: PersonalityDirResolver): Tool<RenderUiArgs> => ({
  name: 'render_ui',
  description: DESCRIPTION,
  toolset: 'ui',
  maxResultChars: 200,
  capabilities: { fs_reach: { read: 'from-personality' } },
  schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Optional short heading shown above the frame.' },
      html: {
        type: 'string',
        description: `One-off document body. Max ${HTML_MAX_CHARS} chars. Mutually exclusive with \`template\`.`,
      },
      template: {
        type: 'string',
        description:
          'Name of a `ui/<template>.html` file in your personality directory, without the extension. Mutually exclusive with `html`.',
      },
      // Declared `object` rather than typeless: every provider wants a `type`
      // on each property, and templates read a keyed record. The runtime check
      // is only the size cap, so an array still passes.
      data: {
        type: 'object',
        description: `JSON data injected into the frame as a frozen global for the template's script. Max ${DATA_MAX_CHARS} chars serialized.`,
      },
      libraries: {
        type: 'array',
        items: { type: 'string', enum: [...CANVAS_LIBRARIES] },
        description: `Local bundles to prepend. Allowed: ${CANVAS_LIBRARIES.join(', ')}.`,
      },
    },
    required: [],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    if (!isUiPlatform(ctx.platform)) return offSurfaceRefusal();

    const { title, html: inlineHtml, template, data, libraries } = args ?? {};
    const hasHtml = present(inlineHtml);
    const hasTemplate = present(template);

    if (hasHtml && hasTemplate) {
      return {
        ok: false,
        code: 'input_invalid',
        error: 'Supply exactly one of `html` or `template`, not both.',
        field: 'template',
      };
    }
    if (!hasHtml && !hasTemplate) {
      return {
        ok: false,
        code: 'input_invalid',
        error: 'Supply exactly one of `html` (inline document) or `template` (a ui/*.html file).',
        field: 'html',
      };
    }

    // Name check first: a rejected name must never reach a path join.
    if (hasTemplate && !TEMPLATE_NAME.test(template)) {
      return {
        ok: false,
        code: 'input_invalid',
        error:
          'template must be a bare file name (letters, digits, hyphens, underscores) with no extension, path separator, or "..".',
        field: 'template',
      };
    }

    if (hasHtml && inlineHtml.length > HTML_MAX_CHARS) {
      return {
        ok: false,
        code: 'input_invalid',
        error: `html is ${inlineHtml.length} chars; the cap is ${HTML_MAX_CHARS}.`,
        field: 'html',
      };
    }

    if (data !== undefined) {
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(data);
      } catch (err) {
        return {
          ok: false,
          code: 'input_invalid',
          error: `data is not JSON-serializable: ${err instanceof Error ? err.message : String(err)}`,
          field: 'data',
        };
      }
      if (serialized === undefined) {
        return {
          ok: false,
          code: 'input_invalid',
          error: 'data is not JSON-serializable.',
          field: 'data',
        };
      }
      if (serialized.length > DATA_MAX_CHARS) {
        return {
          ok: false,
          code: 'input_invalid',
          error: `data serializes to ${serialized.length} chars; the cap is ${DATA_MAX_CHARS}.`,
          field: 'data',
        };
      }
    }

    if (libraries !== undefined) {
      if (!Array.isArray(libraries)) {
        return {
          ok: false,
          code: 'input_invalid',
          error: `libraries must be an array. Allowed entries: ${CANVAS_LIBRARIES.join(', ')}.`,
          field: 'libraries',
        };
      }
      const unknown = libraries.filter(
        (name) => !(CANVAS_LIBRARIES as readonly string[]).includes(name),
      );
      if (unknown.length > 0) {
        return {
          ok: false,
          code: 'input_invalid',
          error: `Unknown librar${unknown.length > 1 ? 'ies' : 'y'}: ${unknown.join(', ')}. Allowed: ${CANVAS_LIBRARIES.join(', ')}.`,
          field: 'libraries',
        };
      }
    }

    // Inline mode is the default source; template mode replaces it with the
    // resolved file. The `''` fallback is unreachable — the exactly-one check
    // above already returned when neither was supplied.
    let html = hasHtml ? inlineHtml : '';
    if (hasTemplate) {
      if (!ctx.personalityId) {
        return {
          ok: false,
          code: 'not_available',
          error: 'Canvas templates require a personality context.',
        };
      }
      const dir = personalityDir(ctx.personalityId);
      if (!dir) {
        return {
          ok: false,
          code: 'not_available',
          error: `Could not resolve the directory for personality "${ctx.personalityId}", so template "${template}" cannot be read.`,
        };
      }
      if (!ctx.scopedFs) {
        return {
          ok: false,
          code: 'not_available',
          error:
            'Filesystem access is not available in this context. The personality must declare fs_reach to read Canvas templates.',
        };
      }
      // Read through the per-turn ScopedStorage: the personality boundary is
      // enforced by construction, so one personality cannot read another's
      // templates even if it names the path.
      const path = join(dir, 'ui', `${template}.html`);
      try {
        const content = await ctx.scopedFs.read(path);
        if (!content) {
          return {
            ok: false,
            code: 'not_available',
            error: `Canvas template "${template}" is missing or empty (expected ${path}).`,
          };
        }
        html = content;
      } catch (err) {
        if (err instanceof BoundaryError) {
          return {
            ok: false,
            code: 'not_available',
            error: `Canvas template "${template}" is outside this personality's fs_reach.`,
          };
        }
        return {
          ok: false,
          code: 'execution_failed',
          error: `Could not read Canvas template "${template}": ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    }

    // No sanitizing, no interpolation. The iframe sandbox is the boundary
    // (allow-scripts only, network blocked, no parent DOM) and `data` reaches
    // the frame as an injected global — server-side rewriting would add a
    // second, weaker boundary and break templates that ship their own script.
    const payload = {
      ...(present(title) ? { title } : {}),
      html,
      ...(data !== undefined ? { data } : {}),
      ...(libraries !== undefined ? { libraries } : {}),
    };

    // Never emit an envelope the wire gate would drop.
    const parsed = CanvasCardPayloadSchema.safeParse(payload);
    if (!parsed.success) {
      const { issues } = parsed.error;
      return {
        ok: false,
        code: 'input_invalid',
        error: `Invalid canvas payload:\n${issueLines(issues)}`,
        field: issueField(issues, 'payload'),
      };
    }

    return {
      ok: true,
      value: `rendered canvas${present(title) ? `: ${title}` : ''}`,
      structured: {
        card: { kind: 'canvas', specVersion: CARD_SPEC_VERSION, payload: parsed.data },
      },
    };
  },
});
