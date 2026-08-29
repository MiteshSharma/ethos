import type { FenceRendererResolver } from './fence-renderer';
import { HtmlRenderer } from './html-renderer';
import { MarkdownRenderer } from './markdown-renderer';

export interface ContentRendererProps {
  content: string;
  format?: 'markdown' | 'html' | 'auto';
  className?: string;
  /** Host fence-upgrade decision, forwarded to the markdown path. Must be referentially stable. */
  fenceRenderers?: FenceRendererResolver;
  /** True while `content` is still arriving — fences may be incomplete. */
  streaming?: boolean;
}

const CLOSE_TAG_RE = /<\/\w+>/;

function detectFormat(content: string): 'markdown' | 'html' {
  const trimmed = content.trimStart();
  if (trimmed.startsWith('<') && CLOSE_TAG_RE.test(trimmed)) return 'html';
  return 'markdown';
}

export function ContentRenderer({
  content,
  format = 'auto',
  className,
  fenceRenderers,
  streaming,
}: ContentRendererProps) {
  const resolved = format === 'auto' ? detectFormat(content) : format;
  if (resolved === 'html') return <HtmlRenderer content={content} className={className} />;
  return (
    <MarkdownRenderer
      content={content}
      className={className}
      fenceRenderers={fenceRenderers}
      streaming={streaming}
    />
  );
}
