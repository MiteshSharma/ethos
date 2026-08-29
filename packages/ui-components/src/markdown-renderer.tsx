import { type ComponentPropsWithoutRef, createContext, useContext, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { FenceRendererResolver, FenceRenderRequest } from './fence-renderer';

export interface MarkdownRendererProps {
  content: string;
  className?: string;
  /**
   * Optional host decision for fenced code blocks. Must be referentially
   * stable — see `FenceRendererResolver`.
   */
  fenceRenderers?: FenceRendererResolver;
  /**
   * True while `content` is still arriving. Forwarded to the resolver so a
   * host can refuse to upgrade a fence whose body is still a partial prefix.
   */
  streaming?: boolean;
}

function cn(...classes: (string | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

/**
 * True for the `<code>` react-markdown emits inside a `<pre>`. react-markdown
 * v10 dropped the `inline` prop and an untagged fence carries no `language-*`
 * class, so className truthiness cannot tell a fence from inline code. The
 * `pre` override is emitted for fenced blocks and nothing else, so it is the
 * honest signal — it publishes it here for its own `<code>` child.
 */
const InsideFence = createContext(false);

const FENCE_LANG_RE = /^language-([\w-]+)/;

interface HastLike {
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastLike[];
  value?: unknown;
}

function fenceClassName(node: HastLike | undefined): string {
  const raw = node?.properties?.className;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.filter((c) => typeof c === 'string').join(' ');
  return '';
}

/**
 * Read the `<code>` child of a `<pre>` hast node back into the fence's info
 * string and raw body. Returns null when the node is not the shape
 * react-markdown produces for a fenced block — the caller then falls through
 * to the plain code-block rendering.
 */
function readFence(node: unknown): Omit<FenceRenderRequest, 'streaming'> | null {
  const pre = node as HastLike | undefined;
  const code = pre?.children?.find((child) => child.tagName === 'code');
  if (!code) return null;
  const text = code.children?.[0]?.value;
  if (typeof text !== 'string') return null;
  const language = FENCE_LANG_RE.exec(fenceClassName(code))?.[1] ?? '';
  return { language, code: text };
}

/**
 * Inline code keeps the pill treatment; the `<code>` inside a fence gets plain
 * mono and lets `PreOverride` own the block chrome. `node` is destructured out
 * so react-markdown's hast handle never reaches the DOM as an unknown prop.
 */
function CodeOverride({
  children,
  className: codeClassName,
  node: _node,
  ...props
}: ComponentPropsWithoutRef<'code'> & { node?: unknown }) {
  const insideFence = useContext(InsideFence);
  if (insideFence) {
    return (
      <code className={cn('font-mono', codeClassName)} {...props}>
        {children}
      </code>
    );
  }
  return (
    <code
      className="rounded border border-border/60 bg-muted px-[0.3em] py-[0.1em] font-mono text-[0.8125rem] text-brand"
      {...props}
    >
      {children}
    </code>
  );
}

const OVERRIDES = {
  p: ({ children, ...props }: ComponentPropsWithoutRef<'p'>) => (
    <p className="my-2 text-sm leading-relaxed text-foreground" {...props}>
      {children}
    </p>
  ),
  strong: ({ children, ...props }: ComponentPropsWithoutRef<'strong'>) => (
    <strong className="font-semibold text-foreground" {...props}>
      {children}
    </strong>
  ),
  h1: ({ children, ...props }: ComponentPropsWithoutRef<'h1'>) => (
    <h1 className="mt-4 mb-2 text-lg font-bold text-foreground" {...props}>
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: ComponentPropsWithoutRef<'h2'>) => (
    <h2 className="mt-4 mb-2 text-base font-semibold text-foreground" {...props}>
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: ComponentPropsWithoutRef<'h3'>) => (
    <h3 className="mt-3 mb-1 text-sm font-semibold text-foreground" {...props}>
      {children}
    </h3>
  ),
  ul: ({ children, ...props }: ComponentPropsWithoutRef<'ul'>) => (
    <ul className="my-2 list-disc pl-6 space-y-1 text-sm" {...props}>
      {children}
    </ul>
  ),
  ol: ({ children, ...props }: ComponentPropsWithoutRef<'ol'>) => (
    <ol className="my-2 list-decimal pl-6 space-y-1 text-sm" {...props}>
      {children}
    </ol>
  ),
  li: ({ children, ...props }: ComponentPropsWithoutRef<'li'>) => (
    <li className="leading-relaxed" {...props}>
      {children}
    </li>
  ),
  blockquote: ({ children, ...props }: ComponentPropsWithoutRef<'blockquote'>) => (
    <blockquote
      className="my-2 border-l-2 border-brand pl-4 italic text-muted-foreground"
      {...props}
    >
      {children}
    </blockquote>
  ),
  hr: (props: ComponentPropsWithoutRef<'hr'>) => <hr className="my-4 border-border" {...props} />,
  a: ({ children, ...props }: ComponentPropsWithoutRef<'a'>) => (
    <a
      className="text-brand underline underline-offset-2"
      target="_blank"
      rel="noopener noreferrer"
      {...props}
    >
      {children}
    </a>
  ),
  code: CodeOverride,
  table: ({ children, ...props }: ComponentPropsWithoutRef<'table'>) => (
    <table className="my-2 w-full border-collapse text-sm" {...props}>
      {children}
    </table>
  ),
  th: ({ children, ...props }: ComponentPropsWithoutRef<'th'>) => (
    <th
      className="border border-border bg-card/80 px-3 py-2 text-left text-[0.625rem] font-semibold tracking-wider uppercase text-muted-foreground"
      {...props}
    >
      {children}
    </th>
  ),
  td: ({ children, ...props }: ComponentPropsWithoutRef<'td'>) => (
    <td className="border border-border px-3 py-1.5" {...props}>
      {children}
    </td>
  ),
};

/**
 * `<pre>` is emitted for fenced blocks only, so this is where a fence can be
 * offered to the host resolver. Built per (resolver, streaming) pair rather
 * than inline in the render body: a fresh element type per render would make
 * React unmount and remount the whole markdown subtree on every streamed
 * token.
 */
function makePreOverride(resolver: FenceRendererResolver | undefined, streaming: boolean) {
  return function PreOverride({
    children,
    node,
  }: ComponentPropsWithoutRef<'pre'> & { node?: unknown }) {
    const fence = resolver ? readFence(node) : null;
    const result = fence ? resolver?.({ ...fence, streaming }) : null;
    if (result?.kind === 'replace') return <>{result.node}</>;
    return (
      <>
        <pre className="my-2 overflow-x-auto rounded border border-border bg-muted p-3 text-sm">
          <InsideFence.Provider value={true}>{children}</InsideFence.Provider>
        </pre>
        {result?.kind === 'annotate' ? result.notice : null}
      </>
    );
  };
}

export function MarkdownRenderer({
  content,
  className,
  fenceRenderers,
  streaming = false,
}: MarkdownRendererProps) {
  const components = useMemo(
    () => ({ ...OVERRIDES, pre: makePreOverride(fenceRenderers, streaming) }),
    [fenceRenderers, streaming],
  );
  return (
    <div
      className={cn(
        'text-sm leading-relaxed text-foreground [&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
        className,
      )}
    >
      <Markdown remarkPlugins={[remarkGfm]} components={components}>
        {content}
      </Markdown>
    </div>
  );
}
