import type { RecipePreflight, RecipeSecretBindings } from '@ethosagent/web-contracts';
import { Select } from 'antd';
import { useState } from 'react';
import { SecretPicker } from '../tool-settings/SecretPicker';

// Answering a credential prerequisite ON THIS PAGE, for the same reason the
// Telegram bot is set up here (plan/phases/recipes-gallery.md D14/D16).
//
// `web_search` reports itself available with no key configured — the key may
// live in Named Secrets, which is unreachable at tool-filter time — so nothing
// in preflight's tool check can see the gap. The recipe installs, and the first
// briefing arrives with no headlines. This row is that missing check, and this
// panel is where it gets answered.
//
// It is the SAME control the personality Tools tab uses: a provider Select over
// the roster the tool publishes, and `SecretPicker` over the vault filtered to
// that provider. Keys the user already has are offered for SELECTION — the
// common case, and the one the bespoke password field this replaced could not
// serve; adding a new one stays one click away inside the picker.
//
// THE VALUE never reaches this layer. `SecretPicker`'s add form writes it
// straight to the named-secrets vault through `namedSecrets.create` — the store
// that owns these credentials, and the one `KeysService.set` deliberately
// refuses to write on their behalf. What travels from here is a REFERENCE: a
// provider and a secret NAME, which the install records as the personality's
// binding so the tool resolves the key the user actually picked.

type NeedsInputRow = RecipePreflight['needsInput'][number];
type Binding = RecipeSecretBindings[string];

export function RecipeSecretSetup({
  row,
  binding,
  onChange,
}: {
  row: NeedsInputRow;
  /** The pick so far, or null. Held by the page so it survives this row clearing. */
  binding: Binding | null;
  onChange: (next: Binding | null) => void;
}) {
  // The provider is a local choice, not derived from `binding`: it is picked
  // BEFORE any key exists under it, which is the whole "I have no key yet" case.
  const [provider, setProvider] = useState(binding?.provider ?? '');

  const options = row.credentialOptions ?? [];
  const first = options[0];
  // `secretKind` is what the picker filters the vault by. Without it (a tool
  // that publishes no `secret-binding` field) there is no picker to draw, and
  // the server would not have emitted options either.
  if (!first || !row.secretKind) return null;
  const secretKind = row.secretKind;

  const selected = options.find((option) => option.provider === provider) ?? first;

  return (
    <div className="recipe-setup">
      <div className="recipe-setup-step">
        <label className="recipe-field-label" htmlFor="recipe-secret-provider">
          1 — Choose a provider
        </label>
        <span className="recipe-rowlist-sub">
          Any one of these satisfies it. The list comes from the tool itself, so it is whatever this
          build actually supports.
        </span>
        <Select
          id="recipe-secret-provider"
          className="recipe-field-select"
          value={selected.provider}
          // A key belongs to one provider, so switching provider drops the pick
          // rather than carrying a name that resolves nowhere.
          onChange={(next: string) => {
            setProvider(next);
            onChange(null);
          }}
          options={options.map((option) => ({ value: option.provider, label: option.label }))}
        />
      </div>

      <div className="recipe-setup-step">
        <label className="recipe-field-label" htmlFor="recipe-secret-name">
          2 — Pick a key
        </label>
        <span className="recipe-rowlist-sub">
          Keys already in your vault are listed here. Adding one stores it in the same vault
          Settings uses, by name only — it is never written into this agent&rsquo;s files and never
          shown again.
          {selected.getKeyUrl ? (
            <>
              {' '}
              <a href={selected.getKeyUrl} target="_blank" rel="noreferrer">
                Get a {selected.label} key
              </a>
            </>
          ) : null}
        </span>
        <SecretPicker
          value={binding?.secret}
          onChange={(name) => onChange(name ? { provider: selected.provider, secret: name } : null)}
          secretKind={secretKind}
          providerFilter={selected.provider}
        />
      </div>
    </div>
  );
}
