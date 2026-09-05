import { personalityAccent } from '@ethosagent/design-tokens';
import {
  formatContextWindow,
  lookupContextWindow,
  type ModelCatalog,
  useModelCatalog,
} from '../catalog/models';
import type { WizardAnswers } from '../reducer';

function modelDisplay(catalog: ModelCatalog | undefined, modelId: string): string {
  const contextWindow = lookupContextWindow(catalog, modelId);
  if (!contextWindow) return modelId;
  return `${modelId} · ${formatContextWindow(contextWindow)}`;
}

export function SummaryStep({ answers, onNext }: { answers: WizardAnswers; onNext: () => void }) {
  const accent = answers.personalityId ? personalityAccent(answers.personalityId) : '#4A9EFF';
  const { data: catalog } = useModelCatalog();

  return (
    <section className="onboarding-step-content">
      <div className="onboarding-summary">
        <div className="onboarding-summary-divider">
          <span className="onboarding-summary-divider-label">summary</span>
          <span className="onboarding-summary-divider-line" />
        </div>

        <dl className="onboarding-summary-rows">
          {answers.provider ? (
            <div className="onboarding-summary-row">
              <dt>Provider</dt>
              <dd>{providerLabel(answers.provider)}</dd>
            </div>
          ) : null}
          {answers.model ? (
            <div className="onboarding-summary-row">
              <dt>Model</dt>
              <dd className="onboarding-summary-mono">{modelDisplay(catalog, answers.model)}</dd>
            </div>
          ) : null}
          {answers.personalityId ? (
            <div className="onboarding-summary-row onboarding-summary-row--accent">
              <dt>
                <span
                  className="onboarding-summary-accent-stripe"
                  style={{ borderLeftColor: accent }}
                />
                Personality
              </dt>
              <dd style={{ color: accent }}>{answers.personalityId}</dd>
            </div>
          ) : null}
          {answers.messaging ? (
            <div className="onboarding-summary-row">
              <dt>Messaging</dt>
              <dd>
                {'skipped' in answers.messaging
                  ? 'Chat in browser'
                  : `${answers.messaging.platform} — credentials saved`}
              </dd>
            </div>
          ) : null}
        </dl>

        <div className="onboarding-summary-divider" style={{ marginTop: 20 }}>
          <span className="onboarding-summary-divider-label">config files</span>
          <span className="onboarding-summary-divider-line" />
        </div>

        <dl className="onboarding-summary-rows">
          <div className="onboarding-summary-row">
            <dt>Config</dt>
            <dd className="onboarding-summary-mono">~/.ethos/config.yaml</dd>
          </div>
          <div className="onboarding-summary-row">
            <dt>Memory</dt>
            <dd className="onboarding-summary-mono">~/.ethos/MEMORY.md</dd>
          </div>
          <div className="onboarding-summary-row">
            <dt>User</dt>
            <dd className="onboarding-summary-mono">~/.ethos/USER.md</dd>
          </div>
        </dl>

        <div className="onboarding-summary-divider" style={{ marginTop: 20 }}>
          <span className="onboarding-summary-divider-label">useful commands</span>
          <span className="onboarding-summary-divider-line" />
        </div>

        <div className="onboarding-summary-commands">
          {(
            [
              ['ethos', 'start chat (terminal)'],
              ['ethos doctor', 'runtime health check'],
              ['ethos personality', 'switch personality'],
              ['ethos mcp', 'per-personality MCP servers'],
            ] as const
          ).map(([cmd, hint]) => (
            <div key={cmd} className="onboarding-summary-cmd">
              <code className="onboarding-summary-cmd-name">{cmd}</code>
              <span className="onboarding-summary-cmd-hint">{hint}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="onboarding-actions" style={{ marginTop: 24 }}>
        <button type="button" className="onboarding-summary-launch-btn" onClick={onNext}>
          Launch chat
        </button>
      </div>
    </section>
  );
}

function providerLabel(provider: string): string {
  const map: Record<string, string> = {
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    openrouter: 'OpenRouter',
    'openai-compat': 'OpenAI-compatible',
    ollama: 'Local Models (Ollama)',
  };
  return map[provider] ?? provider;
}
