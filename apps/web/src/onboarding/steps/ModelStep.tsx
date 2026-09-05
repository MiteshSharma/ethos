import { Button } from 'antd';
import { useState } from 'react';
import {
  formatContextWindow,
  LOW_CONTEXT_THRESHOLD,
  modelsForProvider,
  useModelCatalog,
} from '../catalog/models';
import type { CatalogProviderId } from '../catalog/providers';
import type { WizardAnswers } from '../reducer';

export function ModelStep({
  answers,
  onNext,
}: {
  answers: WizardAnswers;
  onNext: (patch: Partial<WizardAnswers>) => void;
}) {
  const providerId = (answers.provider as CatalogProviderId | undefined) ?? 'anthropic';
  const { data: catalog } = useModelCatalog();
  const catalogModels = modelsForProvider(catalog, providerId);
  const validatedModels = answers.models ?? [];

  // Build display list: catalog entries + "Other" for validated models not in catalog
  const catalogModelIds = new Set(catalogModels.map((m) => m.modelId));
  const otherModelIds = validatedModels.filter((id) => !catalogModelIds.has(id));

  // The catalog arrives asynchronously, so the default is derived rather than
  // captured in state: an explicit choice wins, then the catalog default once
  // it loads, then the first validated id (also the offline/loading list).
  const [choice, setChoice] = useState<string | undefined>(answers.model);
  const selected =
    choice ??
    catalogModels.find((m) => m.default)?.modelId ??
    validatedModels[0] ??
    catalogModels[0]?.modelId ??
    '';
  const setSelected = setChoice;
  const selectedEntry = catalogModels.find((m) => m.modelId === selected);
  const lowContext = selectedEntry && selectedEntry.contextWindow < LOW_CONTEXT_THRESHOLD;

  const displayModels =
    catalogModels.length > 0
      ? catalogModels
      : validatedModels.map((id) => ({
          providerId,
          modelId: id,
          label: id,
          contextWindow: 0,
        }));

  return (
    <section className="onboarding-step-content">
      <h1 className="onboarding-headline">Pick a model.</h1>
      <p className="onboarding-supporting">
        Context window determines how much history your agent can hold in mind.
      </p>

      <div className="onboarding-model-list">
        {displayModels.map((m) => (
          <label
            key={m.modelId}
            className={`onboarding-model-row${selected === m.modelId ? ' active' : ''}`}
          >
            <input
              type="radio"
              name="model"
              value={m.modelId}
              checked={selected === m.modelId}
              onChange={() => setSelected(m.modelId)}
            />
            <span className="onboarding-model-id">{m.modelId}</span>
            <span className="onboarding-model-label">{m.label !== m.modelId ? m.label : ''}</span>
            <span className="onboarding-model-ctx">
              {m.contextWindow > 0 ? formatContextWindow(m.contextWindow) : '—'}
            </span>
          </label>
        ))}

        {otherModelIds.length > 0 ? (
          <>
            <div className="onboarding-section-label" style={{ marginTop: 12 }}>
              OTHER MODELS FROM YOUR ACCOUNT
            </div>
            {otherModelIds.map((id) => (
              <label key={id} className={`onboarding-model-row${selected === id ? ' active' : ''}`}>
                <input
                  type="radio"
                  name="model"
                  value={id}
                  checked={selected === id}
                  onChange={() => setSelected(id)}
                />
                <span className="onboarding-model-id">{id}</span>
                <span className="onboarding-model-label" />
                <span className="onboarding-model-ctx">—</span>
              </label>
            ))}
          </>
        ) : null}
      </div>

      {lowContext ? (
        <div className="onboarding-ctx-warning" role="status">
          ⚠ {formatContextWindow(selectedEntry.contextWindow)} ctx — researcher / engineer
          personalities work better at ≥64k.
        </div>
      ) : null}

      <div className="onboarding-actions">
        <Button type="primary" disabled={!selected} onClick={() => onNext({ model: selected })}>
          Continue
        </Button>
      </div>
    </section>
  );
}
