import { basename, extname, join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from '@ethosagent/types';

/**
 * Resolves the asset folder a personality's `files://` URIs address.
 *
 * tools-ui never computes that path itself: the asset folder follows the
 * personality's `fs_reach` (it IS the declared workdir when there is one), and
 * that derivation lives in core, behind wiring. Supplying it here keeps the one
 * derivation authoritative and this package dependent on contracts alone.
 *
 * `undefined` means the folder could not be resolved (unknown personality, or a
 * declared workdir with an unresolvable substitution variable) — `files://` is
 * then refused rather than guessed at.
 */
export type AssetDirResolver = (personalityId: string) => string | undefined;

/** Resolve `files://<rest>` against the personality's asset folder. */
function resolveFilesUri(
  src: string,
  ctx: ToolContext,
  assetDir: AssetDirResolver,
): { ok: true; path: string } | { ok: false; result: ToolResult } {
  if (!ctx.personalityId) {
    return {
      ok: false,
      result: {
        ok: false,
        code: 'not_available',
        error: 'files:// requires a personality context',
      },
    };
  }
  const dir = assetDir(ctx.personalityId);
  if (!dir) {
    return {
      ok: false,
      result: {
        ok: false,
        code: 'not_available',
        error: `Could not resolve the asset folder for personality "${ctx.personalityId}"`,
      },
    };
  }
  return { ok: true, path: join(dir, src.slice('files://'.length)) };
}

const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg']);
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

function buildTextHtml(ext: string, text: string, title?: string): string {
  void ext; // reserved for future syntax-highlighting per extension
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const displayTitle = title ?? '';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12.5px; background: #111; color: #d4d4d4; padding: 12px; }
    h4 { font-size: 11px; font-weight: 600; color: #888; margin-bottom: 8px; text-transform: uppercase; letter-spacing: 0.05em; }
    pre { white-space: pre-wrap; word-break: break-word; line-height: 1.55; }
  </style></head><body>${displayTitle ? `<h4>${displayTitle.replace(/</g, '&lt;')}</h4>` : ''}<pre>${escaped}</pre></body></html>`;
}

interface SendImageArgs {
  src: string;
  alt?: string;
  title?: string;
}

interface SendHtmlArgs {
  html: string;
  title?: string;
  height?: number;
}

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export const createRenderImageTool = (assetDir: AssetDirResolver): Tool<SendImageArgs> => ({
  name: 'render_image',
  description:
    "Display an image in the chat UI. Accepts a URL (https://...), a base64 data URI (data:image/...;base64,...), an absolute file path (/tmp/image.png), a file:// URI (file:///tmp/image.png), or a files:// URI (files://chart.png) that resolves to the personality's asset folder. The image renders inline in the conversation.",
  toolset: 'ui',
  alwaysInclude: true,
  maxResultChars: 500,
  capabilities: { fs_reach: { read: 'from-personality' } },
  schema: {
    type: 'object',
    properties: {
      src: {
        type: 'string',
        description:
          'Image source: URL (https://...), base64 data URI (data:image/...;base64,...), absolute file path (/tmp/image.png), file:// URI (file:///tmp/image.png), or files:// URI ("files://chart.png" resolves to the personality\'s asset folder). PNG, JPEG, SVG, WebP, GIF supported.',
      },
      alt: { type: 'string', description: 'Alt text for accessibility' },
      title: { type: 'string', description: 'Optional caption shown below the image' },
    },
    required: ['src'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    let { src } = args;
    const { alt, title } = args;
    if (!src || typeof src !== 'string') {
      return { ok: false, code: 'input_invalid', error: 'src is required', field: 'src' };
    }
    const isUrl = src.startsWith('http://') || src.startsWith('https://');
    const isDataUri = src.startsWith('data:image/');
    const isFilesUri = src.startsWith('files://');
    const isFilePath = src.startsWith('/');
    const isFileUri = src.startsWith('file://');
    if (!isUrl && !isDataUri && !isFilesUri && !isFilePath && !isFileUri) {
      return {
        ok: false,
        code: 'input_invalid',
        error:
          'src must be a URL (https://...), base64 data URI (data:image/...;base64,...), absolute file path (/path/to/image), file:// URI, or files:// URI',
        field: 'src',
      };
    }
    if (isFilesUri || isFilePath || isFileUri) {
      let resolvedPath: string;
      if (isFilesUri) {
        const resolved = resolveFilesUri(src, ctx, assetDir);
        if (!resolved.ok) return resolved.result;
        resolvedPath = resolved.path;
      } else {
        resolvedPath = isFileUri ? src.replace(/^file:\/\//, '') : src;
      }
      try {
        if (!ctx.scopedFs) {
          return {
            ok: false,
            code: 'not_available',
            error:
              'Filesystem access not available in this context. The personality must declare fs_reach to use file paths.',
          };
        }
        const bytes = await ctx.scopedFs.readBytes(resolvedPath);
        const mime = EXT_TO_MIME[extname(resolvedPath).toLowerCase()] ?? 'image/png';
        src = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, code: 'execution_failed', error: `Could not read file: ${message}` };
      }
    }
    return {
      ok: true,
      value: title ? `Image: ${title}` : 'Image rendered.',
      structured: {
        _uiType: 'image' as const,
        content: src,
        metadata: { alt, title },
      },
    };
  },
});

export const renderHtmlTool: Tool<SendHtmlArgs> = {
  name: 'render_html',
  description:
    'Render a self-contained HTML document inline in the chat UI inside a sandboxed iframe. The HTML must be a complete, self-contained document (inline CSS and JS, no external dependencies that require same-origin access). Use for charts, tables, interactive demos, formatted reports.',
  toolset: 'ui',
  alwaysInclude: true,
  maxResultChars: 500,
  capabilities: {},
  schema: {
    type: 'object',
    properties: {
      html: {
        type: 'string',
        description: 'Complete self-contained HTML document string',
      },
      title: { type: 'string', description: 'Optional title shown above the frame' },
      height: {
        type: 'number',
        description: 'Initial iframe height in px (default 300, auto-adjusts via postMessage)',
      },
    },
    required: ['html'],
  },
  async execute(args): Promise<ToolResult> {
    const { html, title, height } = args;
    if (!html || typeof html !== 'string') {
      return { ok: false, code: 'input_invalid', error: 'html is required', field: 'html' };
    }
    return {
      ok: true,
      value: title ? `HTML: ${title}` : 'HTML rendered.',
      structured: {
        _uiType: 'html' as const,
        content: html,
        metadata: { title, height },
      },
    };
  },
};

interface SendFileArgs {
  src: string;
  title?: string;
}

export const createRenderFileTool = (assetDir: AssetDirResolver): Tool<SendFileArgs> => ({
  name: 'render_file',
  description:
    'Render a local file inline in the chat UI. Accepts absolute paths (/tmp/file.pdf), file:// URIs, or files:// URIs ("files://report.pdf" resolves to the personality\'s asset folder). Images render as inline images; PDFs render in an embedded viewer; text/code/JSON/CSV/Markdown render as a formatted code block.',
  toolset: 'ui',
  alwaysInclude: true,
  maxResultChars: 500,
  capabilities: { fs_reach: { read: 'from-personality' } },
  schema: {
    type: 'object',
    properties: {
      src: {
        type: 'string',
        description:
          'Absolute file path, file:// URI, or files:// URI ("files://report.pdf" resolves to the personality\'s asset folder)',
      },
      title: { type: 'string', description: 'Optional label shown above the rendered content' },
    },
    required: ['src'],
  },
  async execute(args, ctx: ToolContext): Promise<ToolResult> {
    let { src } = args;
    const { title } = args;
    if (!src || typeof src !== 'string') {
      return { ok: false, code: 'input_invalid', error: 'src is required', field: 'src' };
    }

    const isFilesUri = src.startsWith('files://');
    const isFileUri = src.startsWith('file://');
    const isFilePath = !isFilesUri && !isFileUri && src.startsWith('/');

    // resolve files:// → personality asset folder
    if (isFilesUri) {
      const resolved = resolveFilesUri(src, ctx, assetDir);
      if (!resolved.ok) return resolved.result;
      src = resolved.path;
    } else if (isFileUri) {
      // normalise file:// → absolute path
      src = src.replace(/^file:\/\//, '');
    } else if (!isFilePath) {
      return {
        ok: false,
        code: 'input_invalid',
        error: 'src must be an absolute path, file:// URI, or files:// URI',
        field: 'src',
      };
    }

    const resolvedPath = src;
    const ext = extname(resolvedPath).toLowerCase();

    if (!ctx.scopedFs) {
      return {
        ok: false,
        code: 'not_available',
        error:
          'Filesystem access not available in this context. The personality must declare fs_reach to use file paths.',
      };
    }

    try {
      const bytes = await ctx.scopedFs.readBytes(resolvedPath);

      // auto-copy external files into the personality's asset folder
      const copyDir = ctx.personalityId ? assetDir(ctx.personalityId) : undefined;
      if (copyDir && (isFilePath || isFileUri)) {
        const dest = join(copyDir, basename(resolvedPath));
        ctx.scopedFs?.write(dest, bytes).catch(() => {}); // best-effort copy
      }

      // --- image ---
      if (IMAGE_EXTS.has(ext)) {
        const mime = IMAGE_MIME[ext] ?? 'image/png';
        return {
          ok: true,
          value: title ? `Image: ${title}` : 'Image rendered.',
          structured: {
            _uiType: 'image' as const,
            content: `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`,
            metadata: { title },
          },
        };
      }

      // --- pdf ---
      if (ext === '.pdf') {
        return {
          ok: true,
          value: title ? `PDF: ${title}` : 'PDF rendered.',
          structured: {
            _uiType: 'pdf' as const,
            content: `data:application/pdf;base64,${Buffer.from(bytes).toString('base64')}`,
            metadata: { title },
          },
        };
      }

      // --- text / code / data ---
      const text = Buffer.from(bytes).toString('utf8');
      const html = buildTextHtml(ext, text, title);
      return {
        ok: true,
        value: title ? `File: ${title}` : 'File rendered.',
        structured: {
          _uiType: 'html' as const,
          content: html,
          metadata: { title },
        },
      };
    } catch (err) {
      return {
        ok: false,
        code: 'execution_failed',
        error: `Could not read file: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

export { dashboardSaveTool } from './dashboard-save';
export type { DashboardToolStore } from './dashboard-tools';
export {
  buildDashboardTools,
  createDashboardAddPanelTool,
  createDashboardCreateTool,
} from './dashboard-tools';

export function buildUiTools(assetDir: AssetDirResolver): Tool[] {
  return [
    createRenderImageTool(assetDir) as Tool,
    renderHtmlTool as Tool,
    createRenderFileTool(assetDir) as Tool,
  ];
}
