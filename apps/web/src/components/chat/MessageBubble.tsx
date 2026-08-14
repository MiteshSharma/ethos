import { ContentRenderer, type FenceRendererResolver } from '@ethosagent/ui-components';
import { useQuery } from '@tanstack/react-query';
import { CardView } from '../../features/cards/CardView';
import { formatBytes, type MessageAttachment } from '../../lib/attachments';
import type { AssistantBlock, AssistantTurn, UserMessage } from '../../lib/chat-reducer';
import { rpc } from '../../rpc';
import { HtmlBlock } from './HtmlBlock';
import { ImageBlock } from './ImageBlock';
import { PdfBlock } from './PdfBlock';
import { PlayButton } from './PlayButton';
import { ToolChip } from './ToolChip';

// One rendered message. DESIGN.md voice rules in effect:
//   • User messages: bg-overlay tint, sm radius, right-anchored.
//   • Assistant turns: bare text + inline tool chips, left-anchored.
//     The Linear-density pattern, not the iMessage pattern.

export function UserBubble({ message }: { message: UserMessage }) {
  const attachments = message.attachments ?? [];
  return (
    <div className="message-row message-row-user">
      {message.isSteer && <div className="message-steer-label">↗ Steering</div>}
      {/* The turn arrived as speech. The marker sits ABOVE the transcript, in
          the same 11px mono treatment as the steering marker, so the
          transcript is fully readable beside it and never replaces the fact
          that it was spoken. */}
      {message.origin === 'voice' && (
        <div className="message-voice-label" role="note" aria-label="Sent by voice">
          voice
        </div>
      )}
      {message.content ? <div className="message-user">{message.content}</div> : null}
      {attachments.length > 0 ? (
        <div className="message-attachments">
          {attachments.map((a) => (
            <AttachmentChip key={a.localId} attachment={a} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AttachmentChip({ attachment }: { attachment: MessageAttachment }) {
  const { state, type, name, sizeBytes, previewUrl } = attachment;
  return (
    <div className={`message-attachment-chip ${state}`}>
      {type === 'image' && previewUrl ? (
        <img src={previewUrl} alt={name} className="message-attachment-thumb" />
      ) : (
        <div className="message-attachment-meta">
          <span className="message-attachment-name">{name}</span>
          <span className="message-attachment-size">{formatBytes(sizeBytes)}</span>
        </div>
      )}
      {state === 'uploading' ? (
        <span className="message-attachment-spinner" role="img" aria-label="Uploading" />
      ) : null}
      {state === 'error' ? (
        <span className="message-attachment-error" title="Upload failed">
          ! failed
        </span>
      ) : null}
    </div>
  );
}

export function AssistantBubble({
  turn,
  streaming,
  fenceRenderers,
  onSuggestPrompt,
}: {
  turn: AssistantTurn;
  streaming?: boolean;
  /** Fence-upgrade decision for this surface. Must be referentially stable. */
  fenceRenderers?: FenceRendererResolver;
  /** Puts a `recommend_actions` prompt in the composer. */
  onSuggestPrompt?: (prompt: string) => void;
}) {
  const lastBlock = turn.blocks[turn.blocks.length - 1];
  const cursorAfter = streaming && lastBlock?.kind === 'text';
  const fullText = turn.blocks
    .filter((b): b is Extract<AssistantBlock, { kind: 'text' }> => b.kind === 'text')
    .map((b) => b.content)
    .join('\n');
  const { data: caps } = useQuery({
    queryKey: ['meta', 'capabilities'],
    queryFn: () => rpc.meta.capabilities(),
    staleTime: 60_000,
  });
  const ttsEnabled = caps?.capabilities.voice_tts ?? false;
  return (
    <div className="message-row message-row-assistant">
      <div className="message-assistant">
        {turn.blocks.map((block, idx) => (
          <BlockRenderer
            key={blockKey(block, idx)}
            block={block}
            streamingTail={streaming && idx === turn.blocks.length - 1}
            fenceRenderers={fenceRenderers}
            onSuggestPrompt={onSuggestPrompt}
          />
        ))}
        {streaming && !cursorAfter && lastBlock?.kind === 'tool' ? (
          <span className="streaming-cursor streaming-cursor-trailing" aria-hidden="true" />
        ) : null}
        {!streaming && fullText && ttsEnabled ? <PlayButton text={fullText} /> : null}
      </div>
    </div>
  );
}

function BlockRenderer({
  block,
  streamingTail,
  fenceRenderers,
  onSuggestPrompt,
}: {
  block: AssistantBlock;
  streamingTail?: boolean;
  fenceRenderers?: FenceRendererResolver;
  onSuggestPrompt?: (prompt: string) => void;
}) {
  if (block.kind === 'text') {
    return (
      <>
        <ContentRenderer
          content={block.content}
          format="markdown"
          fenceRenderers={fenceRenderers}
          // Only the tail block of a live turn can hold an unclosed fence;
          // earlier blocks in the same turn are already complete.
          streaming={streamingTail}
        />
        {streamingTail ? <span className="streaming-cursor" aria-hidden="true" /> : null}
      </>
    );
  }
  if (block.kind === 'image') {
    return <ImageBlock block={block} />;
  }
  if (block.kind === 'html') {
    return <HtmlBlock block={block} />;
  }
  if (block.kind === 'pdf') {
    return <PdfBlock block={block} />;
  }
  if (block.kind === 'card') {
    return <CardView card={block.card} onSuggestPrompt={onSuggestPrompt} />;
  }
  return <ToolChip tool={block} />;
}

function blockKey(block: AssistantBlock, idx: number): string {
  if (block.kind === 'text') return `text-${idx}`;
  if (block.kind === 'image') return `image-${block.toolCallId}`;
  if (block.kind === 'html') return `html-${block.toolCallId}`;
  if (block.kind === 'pdf') return `pdf-${block.toolCallId}`;
  // One tool call can emit several cards, so the id alone is not unique.
  if (block.kind === 'card') return `card-${block.toolCallId}-${idx}`;
  return `tool-${block.toolCallId}`;
}
