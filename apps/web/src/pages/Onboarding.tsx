import { type Personality, type ProviderId, personalityAccent } from '@ethosagent/web-contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Button, Input, Select, Spin } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PersonalityMark } from '../components/ui/PersonalityMark';
import { rpc } from '../rpc';

// First-run setup. Three steps stacked vertically; no Antd Steps chrome
// (DESIGN.md spec: "each onboarding step is one composition — one
// headline, one supporting line, one input or one CTA, one piece of
// context"). Max-width 520px, centered.
//
// Step 1 — Welcome:    value prop + trust line + Continue.
// Step 2 — Provider:   pick provider + key, validate against the
//                      provider's models endpoint, then pick a model.
// Step 3 — Personality: stacked rows (NOT a card grid; DESIGN.md
//                      anti-slop rule #2). Selecting one finishes onboarding.
//
// Integrations (Telegram/Slack/Discord/Email) are intentionally skipped
// at this milestone — they live in later phases. Users add channels via
// CLI for now; the web UI surfaces them in v1.

type Step = 'welcome' | 'provider' | 'personality';

interface ProviderDraft {
  provider: ProviderId;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Models returned by the provider's catalog after validation. */
  models: string[];
}

const PROVIDER_OPTIONS: Array<{ value: ProviderId; label: string; hint: string }> = [
  {
    value: 'anthropic',
    label: 'Anthropic',
    hint: 'Direct Claude API. Best with the latest Claude models.',
  },
  {
    value: 'openrouter',
    label: 'OpenRouter',
    hint: 'Pay-as-you-go gateway covering hundreds of models.',
  },
  {
    value: 'openai-compat',
    label: 'OpenAI-compat',
    hint: 'Any provider that speaks the OpenAI API (Groq, Together, vLLM…).',
  },
  {
    value: 'ollama',
    label: 'Ollama',
    hint: 'Local models on your machine. No API key needed.',
  },
];

export function Onboarding() {
  const [step, setStep] = useState<Step>('welcome');
  const [provider, setProvider] = useState<ProviderDraft>({
    provider: 'anthropic',
    apiKey: '',
    baseUrl: '',
    model: '',
    models: [],
  });

  return (
    <div className="onboarding">
      <div className="onboarding-progress" aria-hidden="true">
        <span className={`onboarding-dot${step === 'welcome' ? ' active' : ''}`} />
        <span className={`onboarding-dot${step === 'provider' ? ' active' : ''}`} />
        <span className={`onboarding-dot${step === 'personality' ? ' active' : ''}`} />
      </div>
      {step === 'welcome' ? (
        <WelcomeStep onContinue={() => setStep('provider')} />
      ) : step === 'provider' ? (
        <ProviderStep
          draft={provider}
          onChange={setProvider}
          onContinue={() => setStep('personality')}
        />
      ) : (
        <PersonalityStep provider={provider} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Welcome
// ---------------------------------------------------------------------------

function WelcomeStep({ onContinue }: { onContinue: () => void }) {
  return (
    <section className="onboarding-step">
      <h1 className="onboarding-headline">Set up your agent.</h1>
      <p className="onboarding-supporting">
        Pick a model API and a personality. Three steps. Takes a minute.
      </p>
      <p className="onboarding-trust">
        Your config, history, and memory live on this machine — nothing leaves unless you explicitly
        route it through a cloud model.
      </p>
      <div className="onboarding-actions">
        <Button type="primary" onClick={onContinue}>
          Continue
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Provider
// ---------------------------------------------------------------------------

function ProviderStep({
  draft,
  onChange,
  onContinue,
}: {
  draft: ProviderDraft;
  onChange: (next: ProviderDraft) => void;
  onContinue: () => void;
}) {
  const [validating, setValidating] = useState(false);
  const [validateError, setValidateError] = useState<string | null>(null);

  const requiresKey = draft.provider !== 'ollama';
  const showsBaseUrl = draft.provider === 'openai-compat' || draft.provider === 'ollama';
  const validated = draft.models.length > 0;

  const validate = async () => {
    setValidating(true);
    setValidateError(null);
    try {
      const result = await rpc.onboarding.validateProvider({
        provider: draft.provider,
        apiKey: draft.apiKey || 'no-key', // ollama doesn't need one; server tolerates
        ...(draft.baseUrl ? { baseUrl: draft.baseUrl } : {}),
      });
      if (!result.ok) {
        setValidateError(result.error ?? 'Validation failed');
        onChange({ ...draft, models: [] });
        return;
      }
      const models = result.models ?? [];
      // Default-pick the first model so the user can hit Continue without
      // a second click. They can change it from the dropdown if they want.
      onChange({ ...draft, models, model: models[0] ?? '' });
    } catch (err) {
      setValidateError(err instanceof Error ? err.message : String(err));
    } finally {
      setValidating(false);
    }
  };

  return (
    <section className="onboarding-step">
      <h1 className="onboarding-headline">Pick a model API.</h1>
      <p className="onboarding-supporting">We'll validate the credentials before moving on.</p>

      <div className="onboarding-providers">
        {PROVIDER_OPTIONS.map((opt) => (
          <label
            key={opt.value}
            className={`onboarding-provider${draft.provider === opt.value ? ' active' : ''}`}
          >
            <input
              type="radio"
              name="provider"
              value={opt.value}
              checked={draft.provider === opt.value}
              onChange={() => onChange({ ...draft, provider: opt.value, models: [], model: '' })}
            />
            <span className="onboarding-provider-label">{opt.label}</span>
            <span className="onboarding-provider-hint">{opt.hint}</span>
          </label>
        ))}
      </div>

      {requiresKey ? (
        <div className="onboarding-field">
          <label htmlFor="onboarding-key" className="onboarding-field-label">
            API key
          </label>
          <Input.Password
            id="onboarding-key"
            value={draft.apiKey}
            onChange={(e) => onChange({ ...draft, apiKey: e.target.value, models: [] })}
            placeholder={draft.provider === 'anthropic' ? 'sk-ant-...' : 'sk-...'}
            autoComplete="off"
          />
        </div>
      ) : null}

      {showsBaseUrl ? (
        <div className="onboarding-field">
          <label htmlFor="onboarding-baseurl" className="onboarding-field-label">
            Base URL{draft.provider === 'ollama' ? ' (default: http://localhost:11434)' : ''}
          </label>
          <Input
            id="onboarding-baseurl"
            value={draft.baseUrl}
            onChange={(e) => onChange({ ...draft, baseUrl: e.target.value, models: [] })}
            placeholder={
              draft.provider === 'ollama' ? 'http://localhost:11434' : 'https://api.example.com/v1'
            }
            autoComplete="off"
          />
        </div>
      ) : null}

      {validateError ? (
        <div className="onboarding-error" role="alert">
          {validateError}
        </div>
      ) : null}

      {validated ? (
        <div className="onboarding-field">
          <label htmlFor="onboarding-model" className="onboarding-field-label">
            Model
          </label>
          <Select
            id="onboarding-model"
            value={draft.model}
            onChange={(value) => onChange({ ...draft, model: value })}
            options={draft.models.map((m) => ({ label: m, value: m }))}
            showSearch
            style={{ width: '100%' }}
          />
        </div>
      ) : null}

      <div className="onboarding-actions">
        {!validated ? (
          <Button
            type="primary"
            onClick={() => void validate()}
            loading={validating}
            disabled={requiresKey && draft.apiKey.length === 0}
          >
            Validate
          </Button>
        ) : (
          <Button type="primary" onClick={onContinue} disabled={!draft.model}>
            Continue
          </Button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Personality
// ---------------------------------------------------------------------------

const SAMPLE_TURNS: Record<string, { user: string; reply: string }> = {
  researcher: {
    user: 'What changed in HTTP/3?',
    reply:
      'Major shifts: QUIC replaces TCP at the transport layer (faster connection setup, fewer head-of-line blocks), and TLS 1.3 is baked in rather than layered on. I can pull the RFC for specifics if you want.',
  },
  engineer: {
    user: 'Refactor this loop to use a Map.',
    reply:
      'Yep, here you go. I went with Map.get() over object lookup for O(1) access on string keys. Want me to add a test that proves the behavior matches the original?',
  },
  reviewer: {
    user: 'Should I merge this PR?',
    reply:
      "Two flags: the migration runs unguarded on a 50M-row table — that locks for minutes — and the rollback path doesn't restore deleted rows. Want me to spec a safer version?",
  },
  coach: {
    user: "I'm stuck on this debugging session.",
    reply:
      "That's normal. What's the smallest change between when it worked and when it broke? Even one line counts. Walk me through the last commit and we'll narrow it.",
  },
  operator: {
    user: 'Schedule a daily report at 9am.',
    reply:
      "Done. Cron job `daily-report` runs at 09:00 local, summarizes yesterday's sessions, writes to ~/.ethos/reports. Use `ethos cron pause daily-report` to disable.",
  },
};

function PersonalityStep({ provider }: { provider: ProviderDraft }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { notification } = AntApp.useApp();

  const { data, isLoading } = useQuery({
    queryKey: ['personalities'],
    queryFn: () => rpc.personalities.list(),
  });

  const [selectedId, setSelectedId] = useState<string | null>(null);

  const completeMut = useMutation({
    mutationFn: (personalityId: string) =>
      rpc.onboarding.complete({
        provider: provider.provider,
        model: provider.model,
        apiKey: provider.apiKey || 'no-key',
        ...(provider.baseUrl ? { baseUrl: provider.baseUrl } : {}),
        personalityId,
      }),
    onSuccess: () => {
      // Invalidate every cache that reads from config or onboarding state
      // so the auto-redirect in App stops sending us back here.
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      void queryClient.invalidateQueries({ queryKey: ['onboarding'] });
      navigate('/chat');
    },
    onError: (err) => {
      notification.error({
        message: 'Could not finish setup',
        description: err instanceof Error ? err.message : String(err),
        placement: 'topRight',
      });
    },
  });

  if (isLoading || !data) {
    return (
      <section className="onboarding-step">
        <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
          <Spin />
        </div>
      </section>
    );
  }

  return (
    <section className="onboarding-step">
      <h1 className="onboarding-headline">Pick a personality.</h1>
      <p className="onboarding-supporting">
        Each one's a different toolset and voice. You can switch later — and the chat tab auto-forks
        the session when you do.
      </p>

      <div className="onboarding-personalities">
        {data.personalities.map((p) => (
          <PersonalityRow
            key={p.id}
            personality={p}
            active={selectedId === p.id}
            onSelect={() => setSelectedId(p.id)}
          />
        ))}
      </div>

      <div className="onboarding-actions">
        <Button
          type="primary"
          disabled={!selectedId}
          loading={completeMut.isPending}
          onClick={() => {
            if (selectedId) completeMut.mutate(selectedId);
          }}
        >
          Continue
        </Button>
      </div>
    </section>
  );
}

function PersonalityRow({
  personality,
  active,
  onSelect,
}: {
  personality: Personality;
  active: boolean;
  onSelect: () => void;
}) {
  const accent = personalityAccent(personality.id);
  const sample = SAMPLE_TURNS[personality.id];
  return (
    <button
      type="button"
      className={`onboarding-personality${active ? ' active' : ''}`}
      style={active ? { borderColor: accent } : undefined}
      onClick={onSelect}
      aria-pressed={active}
    >
      <PersonalityMark personalityId={personality.id} size={36} />
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
    </button>
  );
}
