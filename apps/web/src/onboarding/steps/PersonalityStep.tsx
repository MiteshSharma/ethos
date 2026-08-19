import { personalityAccent } from '@ethosagent/design-tokens';
import type { Personality } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Button, ConfigProvider, Spin } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { PersonalityMark } from '../../components/ui/PersonalityMark';
import { personalityTheme } from '../../lib/theme';
import { rpc } from '../../rpc';
import type { WizardAnswers } from '../reducer';

const SAMPLE_TURNS: Record<string, { user: string; reply: string }> = {
  researcher: {
    user: 'What changed in HTTP/3?',
    reply:
      'Major shifts: QUIC replaces TCP at the transport layer (faster connection setup, fewer head-of-line blocks), and TLS 1.3 is baked in rather than layered on.',
  },
  engineer: {
    user: 'Refactor this loop to use a Map.',
    reply:
      'Here you go. I went with Map.get() over object lookup for O(1) access on string keys. Want me to add a test that proves the behavior matches the original?',
  },
  reviewer: {
    user: 'Should I merge this PR?',
    reply:
      "Two flags: the migration runs unguarded on a 50M-row table — that locks for minutes — and the rollback path doesn't restore deleted rows.",
  },
  coach: {
    user: "I'm stuck on this debugging session.",
    reply:
      "That's normal. What's the smallest change between when it worked and when it broke? Walk me through the last commit and we'll narrow it.",
  },
  operator: {
    user: 'Schedule a daily report at 9am.',
    reply:
      'Done. Cron job `daily-report` runs at 09:00 local. Use `ethos cron pause daily-report` to disable.',
  },
};

export function PersonalityStep({
  answers,
  onNext,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['personalities'],
    queryFn: () => rpc.personalities.list({}),
  });

  const [selectedId, setSelectedId] = useState<string | null>(answers.personalityId ?? null);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const closePreview = () => setPreviewId(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPreviewId(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (isLoading || !data) {
    return (
      <section className="onboarding-step-content">
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      </section>
    );
  }

  const innerContent = (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Pick a personality.</h1>
      <p className="onboarding-supporting">
        Each one's a different toolset and voice. This is your default — every session belongs to
        the personality it starts with, and you pick that when you start a new one.
      </p>

      <div className="onboarding-personalities">
        {data.items.map((p) => (
          <PersonalityRow
            key={p.id}
            personality={p}
            active={selectedId === p.id}
            onSelect={() => setSelectedId(p.id)}
            onPreview={() => setPreviewId(p.id)}
          />
        ))}
      </div>

      <div className="onboarding-actions">
        <Button
          type="primary"
          disabled={!selectedId}
          onClick={() => {
            if (selectedId) onNext({ personalityId: selectedId });
          }}
        >
          Continue
        </Button>
      </div>

      {previewId ? (
        <PersonalityPreviewPane
          personalityId={previewId}
          onClose={closePreview}
          onSelect={(id) => {
            setSelectedId(id);
            closePreview();
          }}
        />
      ) : null}
    </section>
  );

  if (selectedId) {
    return <ConfigProvider theme={personalityTheme(selectedId)}>{innerContent}</ConfigProvider>;
  }
  return innerContent;
}

function PersonalityRow({
  personality,
  active,
  onSelect,
  onPreview,
}: {
  personality: Personality;
  active: boolean;
  onSelect: () => void;
  onPreview: () => void;
}) {
  const accent = personalityAccent(personality.id);
  const sample = SAMPLE_TURNS[personality.id];

  return (
    <button
      type="button"
      className={`onboarding-personality${active ? ' active' : ''}`}
      style={
        { borderColor: active ? accent : undefined, '--row-accent': accent } as React.CSSProperties
      }
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === ' ') {
          e.preventDefault();
          onPreview();
        }
      }}
      aria-pressed={active}
    >
      <div
        className="onboarding-personality-accent-stripe"
        style={{ background: accent, width: active ? 4 : 3 }}
      />
      <PersonalityMark
        personalityId={personality.id}
        size={36}
        avatarUrl={personality.display?.avatar_url}
      />
      <div className="onboarding-personality-text">
        <span className="onboarding-personality-name">{personality.name}</span>
        {personality.description ? (
          <span className="onboarding-personality-description">{personality.description}</span>
        ) : null}
        {sample ? (
          <div className="onboarding-personality-sample">
            <span className="onboarding-personality-sample-user">{sample.user}</span>
            <span className="onboarding-personality-sample-reply">{sample.reply}</span>
          </div>
        ) : null}
      </div>
      <button
        type="button"
        className="onboarding-preview-btn"
        onClick={(e) => {
          e.stopPropagation();
          onPreview();
        }}
        title="Preview"
        aria-label={`Preview ${personality.name}`}
      >
        ↗
      </button>
    </button>
  );
}

function PersonalityPreviewPane({
  personalityId,
  onClose,
  onSelect,
}: {
  personalityId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const accent = personalityAccent(personalityId);

  const { data, isLoading } = useQuery({
    queryKey: ['personality', personalityId],
    queryFn: () => rpc.personalities.get({ id: personalityId }),
  });

  useEffect(() => {
    const onClickOutside = (e: MouseEvent) => {
      if (paneRef.current && !paneRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', onClickOutside);
    return () => document.removeEventListener('mousedown', onClickOutside);
  }, [onClose]);

  return (
    <div className="onboarding-preview-pane" ref={paneRef} style={{ borderTopColor: accent }}>
      <div className="onboarding-preview-pane-header">
        <button
          type="button"
          className="onboarding-preview-pane-close"
          onClick={onClose}
          aria-label="Close preview"
        >
          ✕
        </button>
      </div>

      {isLoading || !data ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 120 }}>
          <Spin size="small" />
        </div>
      ) : (
        <>
          <div className="onboarding-preview-pane-mark">
            <PersonalityMark
              personalityId={personalityId}
              size={120}
              avatarUrl={data.personality.display?.avatar_url}
            />
          </div>
          <div className="onboarding-preview-pane-name" style={{ color: accent }}>
            {data.personality.name}
          </div>
          {data.personality.description ? (
            <p className="onboarding-preview-pane-desc">{data.personality.description}</p>
          ) : null}
          {data.soulMd ? <pre className="onboarding-preview-pane-soul">{data.soulMd}</pre> : null}
          <div className="onboarding-preview-pane-actions">
            <Button
              type="primary"
              size="small"
              onClick={() => onSelect(personalityId)}
              style={{ background: accent, borderColor: accent }}
            >
              Select {data.personality.name}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
