import { personalityAccent } from '@ethosagent/design-tokens';
import { useQuery } from '@tanstack/react-query';
import { Dropdown, Input } from 'antd';
import { type KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';
import { TalkMicIcon } from '../../features/voice/TalkMode';
import type { AttachmentPreview } from '../../lib/attachments';
import { formatContextTokens } from '../../lib/format-context-tokens';
import { rpc } from '../../rpc';
import { VoiceButton } from './VoiceButton';

export interface ComposerProps {
  personalityId: string;
  disabled?: boolean;
  onSend: (text: string) => void | Promise<void>;
  placeholder?: string;
  isStreaming?: boolean;
  onAbort?: () => void;
  attachments?: AttachmentPreview[];
  onAttach?: (files: File[]) => void;
  onRemoveAttachment?: (localId: string) => void;
  onGoalRun?: () => void;
  /** Input-token count from the last turn — the current context size. Renders
   *  nothing when null/0 (before the first turn). */
  contextTokens?: number | null;
  /** Text pushed in from a suggestion pill. `seq` makes picking the same
   *  suggestion twice a fresh event; the draft is replaced, not appended. */
  suggestion?: { text: string; seq: number };
  /** Start talk-mode. Absent = this surface has no live-call affordance. */
  onTalkMode?: () => void;
  /** True while a call is up — the glyph reads active and stops re-arming. */
  talkModeActive?: boolean;
  /** Hover text for the talk glyph; also its accessible name. */
  talkModeHint?: string;
}

export function Composer({
  personalityId,
  disabled,
  onSend,
  placeholder,
  isStreaming,
  onAbort,
  attachments,
  onAttach,
  onRemoveAttachment,
  onGoalRun,
  contextTokens,
  suggestion,
  onTalkMode,
  talkModeActive,
  talkModeHint,
}: ComposerProps) {
  const [text, setText] = useState('');
  const [isVoiceRecording, setIsVoiceRecording] = useState(false);
  const capabilitiesQuery = useQuery({
    queryKey: ['meta', 'capabilities'],
    queryFn: () => rpc.meta.capabilities(),
    staleTime: 60_000,
  });
  const voiceEnabled = capabilitiesQuery.data?.capabilities.voice_stt ?? false;
  const accent = personalityAccent(personalityId);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [atQuery, setAtQuery] = useState<string | null>(null);
  const [atResults, setAtResults] = useState<string[]>([]);
  const [atIndex, setAtIndex] = useState(0);
  const [slashQuery, setSlashQuery] = useState<string | null>(null);
  const [slashResults, setSlashResults] = useState<
    Array<{ name: string; description: string; usage: string }>
  >([]);
  const [slashIndex, setSlashIndex] = useState(0);
  const [slashCommandsCache, setSlashCommandsCache] = useState<
    Array<{ name: string; description: string; usage: string }>
  >([]);

  const hasReadyAttachments = attachments && attachments.length > 0;
  const isUploading = attachments?.some((a) => a.state === 'uploading');

  // A suggestion pill fills the draft; it never sends on the user's behalf.
  // Keyed on `seq` so the same suggestion picked twice still lands.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `seq` is the event, `text` is the payload
  useEffect(() => {
    if (suggestion) setText(suggestion.text);
  }, [suggestion?.seq]);

  useEffect(() => {
    if (atQuery === null) {
      setAtResults([]);
      return;
    }
    let cancelled = false;
    rpc.files
      .list({ prefix: atQuery || undefined })
      .then((res) => {
        if (!cancelled) {
          setAtResults(res.paths.slice(0, 8));
          setAtIndex(0);
        }
      })
      .catch(() => {
        if (!cancelled) setAtResults([]);
      });
    return () => {
      cancelled = true;
    };
  }, [atQuery]);

  useEffect(() => {
    rpc.slashCommands
      .list()
      .then((res) => setSlashCommandsCache(res.commands))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (slashQuery === null) {
      setSlashResults([]);
      return;
    }
    const q = slashQuery.toLowerCase();
    const filtered = slashCommandsCache.filter((c) => c.name.includes(q)).slice(0, 8);
    setSlashResults(filtered);
    setSlashIndex(0);
  }, [slashQuery, slashCommandsCache]);

  const handleTextChange = useCallback((value: string) => {
    setText(value);
    const atPos = value.lastIndexOf('@');
    if (atPos >= 0) {
      const afterAt = value.slice(atPos + 1);
      if (!afterAt.includes(' ')) {
        setAtQuery(afterAt);
        setSlashQuery(null);
        return;
      }
    }
    if (value.startsWith('/')) {
      const afterSlash = value.slice(1);
      if (!afterSlash.includes(' ')) {
        setSlashQuery(afterSlash);
        setAtQuery(null);
        return;
      }
    }
    setAtQuery(null);
    setSlashQuery(null);
  }, []);

  const handleSend = async () => {
    const trimmed = text.trim();
    if ((!trimmed && !hasReadyAttachments) || disabled || isUploading) return;
    setText('');

    let resolved = trimmed;
    const refPattern = /@([\w./~-]+)/g;
    const matches = [...trimmed.matchAll(refPattern)];
    if (matches.length > 0) {
      const refs = matches.map((m) => m[1]);
      try {
        const result = await rpc.context.resolve({ refs });
        for (const entry of result.resolved) {
          if (entry.content) {
            resolved = resolved.replace(
              `@${entry.ref}`,
              `\`\`\`${entry.lang}\n// ${entry.ref}\n${entry.content}\n\`\`\``,
            );
          }
        }
      } catch {
        // Resolution failed — send with raw @ref tokens
      }
    }

    void onSend(resolved);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashQuery !== null && slashResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIndex((i) => (i + 1) % slashResults.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIndex((i) => (i - 1 + slashResults.length) % slashResults.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const selected = slashResults[slashIndex];
        if (selected) {
          const newText = `/${selected.name} `;
          setText(newText);
          setSlashQuery(null);
          setSlashResults([]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashQuery(null);
        setSlashResults([]);
        return;
      }
    }
    if (atQuery !== null && atResults.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setAtIndex((i) => (i + 1) % atResults.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setAtIndex((i) => (i - 1 + atResults.length) % atResults.length);
        return;
      }
      if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        const selected = atResults[atIndex];
        if (selected) {
          const atPos = text.lastIndexOf('@');
          const before = text.slice(0, atPos + 1);
          const newText = `${before}${selected} `;
          setText(newText);
          setAtQuery(null);
          setAtResults([]);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setAtQuery(null);
        setAtResults([]);
        return;
      }
    }
    if (e.key !== 'Enter') return;
    if (e.shiftKey) return;
    if (e.nativeEvent.isComposing) return;
    e.preventDefault();
    handleSend();
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items || !onAttach) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item?.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      onAttach(files);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!onAttach) return;
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) onAttach(files);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!onAttach || !e.target.files) return;
    onAttach(Array.from(e.target.files));
    e.target.value = '';
  };

  return (
    <div className="composer">
      <div className="composer-inner">
        {/* biome-ignore lint/a11y/noStaticElementInteractions: drop zone for file attachments */}
        <div
          className="composer-card"
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          style={{ position: 'relative' }}
        >
          <input
            type="file"
            ref={fileInputRef}
            multiple
            onChange={handleFileChange}
            style={{ display: 'none' }}
          />
          {attachments && attachments.length > 0 && (
            <div className="composer-attachments">
              {attachments.map((a) => (
                <div key={a.localId} className={`composer-attachment-chip ${a.state}`}>
                  {a.type === 'image' && a.previewUrl ? (
                    <img src={a.previewUrl} alt={a.name} />
                  ) : (
                    <span className="composer-attachment-filename">{a.name}</span>
                  )}
                  {a.state === 'uploading' && <span className="composer-attachment-spinner" />}
                  {a.state === 'error' && <span className="composer-attachment-error">!</span>}
                  <button
                    type="button"
                    onClick={() => onRemoveAttachment?.(a.localId)}
                    aria-label="Remove"
                  >
                    &times;
                  </button>
                </div>
              ))}
            </div>
          )}
          {atQuery !== null && atResults.length > 0 && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                right: 0,
                background: 'var(--ethos-bg-surface, #1a1a1a)',
                border: '1px solid var(--ethos-border, #333)',
                borderRadius: 'var(--radius-sm)',
                maxHeight: 200,
                overflow: 'auto',
                zIndex: 10,
                marginBottom: 4,
              }}
            >
              {atResults.map((path, i) => (
                <button
                  type="button"
                  key={path}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    const atPos = text.lastIndexOf('@');
                    const before = text.slice(0, atPos + 1);
                    setText(`${before}${path} `);
                    setAtQuery(null);
                    setAtResults([]);
                  }}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontFamily: 'monospace',
                    background: i === atIndex ? 'var(--ethos-bg-hover, #2a2a2a)' : 'transparent',
                    border: 'none',
                    color: 'inherit',
                    textAlign: 'left',
                    width: '100%',
                    display: 'block',
                  }}
                >
                  {path}
                </button>
              ))}
            </div>
          )}
          {slashQuery !== null && slashResults.length > 0 && (
            <div
              style={{
                position: 'absolute',
                bottom: '100%',
                left: 0,
                right: 0,
                background: 'var(--ethos-bg-surface, #1a1a1a)',
                border: '1px solid var(--ethos-border, #333)',
                borderRadius: 'var(--radius-sm)',
                maxHeight: 200,
                overflow: 'auto',
                zIndex: 10,
                marginBottom: 4,
              }}
            >
              {slashResults.map((cmd, i) => (
                <button
                  type="button"
                  key={cmd.name}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setText(`/${cmd.name} `);
                    setSlashQuery(null);
                    setSlashResults([]);
                  }}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    fontSize: 13,
                    fontFamily: 'monospace',
                    background: i === slashIndex ? 'var(--ethos-bg-hover, #2a2a2a)' : 'transparent',
                    border: 'none',
                    color: 'inherit',
                    textAlign: 'left',
                    width: '100%',
                    display: 'block',
                  }}
                >
                  <span>/{cmd.name}</span>
                  <span style={{ marginLeft: 8, opacity: 0.5, fontSize: 12 }}>
                    {cmd.description}
                  </span>
                </button>
              ))}
            </div>
          )}
          {/* Row 1: Text field, full width */}
          {isVoiceRecording ? (
            <div className="composer-voice-textarea-placeholder" />
          ) : (
            <Input.TextArea
              value={text}
              onChange={(e) => handleTextChange(e.target.value)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder ?? 'Send a message…'}
              autoSize={{ minRows: 1, maxRows: 8 }}
              style={{ caretColor: accent, fontSize: 14, lineHeight: 1.5 }}
              disabled={disabled}
            />
          )}
          {/* Row 2: [+] ... [mic] [send/stop] */}
          <div className="composer-actions">
            <Dropdown
              menu={{
                items: [
                  {
                    key: 'files',
                    label: 'Add files or photos',
                    onClick: () => fileInputRef.current?.click(),
                  },
                ],
              }}
              trigger={['click']}
              placement="topLeft"
            >
              <button type="button" className="composer-add-btn" aria-label="Attach">
                +
              </button>
            </Dropdown>
            <div className="composer-actions-spacer" />
            {contextTokens ? (
              <span className="composer-context-meter">
                {formatContextTokens(contextTokens)} tokens
              </span>
            ) : null}
            {onTalkMode ? (
              <button
                type="button"
                className={`composer-talk-btn${talkModeActive ? ' composer-talk-active' : ''}`}
                onClick={onTalkMode}
                disabled={talkModeActive}
                title={talkModeHint ?? 'Talk'}
                aria-label={talkModeHint ?? 'Talk'}
                aria-pressed={talkModeActive ?? false}
              >
                <TalkMicIcon />
              </button>
            ) : null}
            {voiceEnabled && (
              <VoiceButton
                onTranscript={(t) => {
                  setText(t);
                }}
                onRecordingChange={setIsVoiceRecording}
                disabled={disabled || isStreaming}
                accent={accent}
              />
            )}
            {isStreaming && onAbort ? (
              <button
                type="button"
                className="composer-send-btn composer-stop-btn"
                onClick={onAbort}
                aria-label="Stop"
              >
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <rect x="2" y="2" width="10" height="10" rx="1.5" fill="white" />
                </svg>
              </button>
            ) : (
              <button
                type="button"
                className="composer-send-btn"
                onClick={handleSend}
                disabled={disabled || (text.trim() === '' && !hasReadyAttachments) || isUploading}
                aria-label="Send message"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path
                    d="M3 8h10M9 4l4 4-4 4"
                    stroke="white"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            )}
          </div>
        </div>
        {onGoalRun && !isStreaming ? (
          <div className="composer-goal-row">
            <button
              type="button"
              className="composer-goal-btn"
              onClick={onGoalRun}
              aria-label="Send as goal"
            >
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                <path
                  d="M2 11.5V8.5h5.5M7.5 4.5l3 3-3 3"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Send as Goal
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
