import type {
  CronDeliveryTarget,
  Personality,
  RecipeBundleWire,
  RecipeInstallMode,
  RecipePreflight,
  RecipeSecretBindings,
} from '@ethosagent/web-contracts';
import { Input, Radio, Segmented, Select, Spin } from 'antd';
import {
  type ChannelSetupDraft,
  chatTargetValue,
  credentialToolName,
  deliveryTargetReason,
  inlineSetupPlatform,
} from '../../lib/recipes';
import { RecipeChannelSetup } from './RecipeChannelSetup';
import { RecipeSecretSetup } from './RecipeSecretSetup';

// The "needs you" step (plan/phases/recipes-gallery.md §5) — one screen, not a
// wizard: three to five fields do not earn step chrome.
//
// Drawn as the same bordered row list the rest of the flow uses: a glyph
// gutter carrying `!` while the answer is still missing and `✓` once it is
// there, the label and its one line of help, the control beneath, and the
// input's kind as the right-hand mono word.
//
// The `chatTarget` field is a PICKER over `cron.deliveryTargets`, never a
// free-text chat id (§1). Picking one writes two things: the structured
// `deliverTo` the server acts on, and the input's own `platform:botKey:chatId`
// text so the "still needed from you" row for it disappears on the next
// preflight.
//
// A CREDENTIAL row is the same idea one step further out. It is not a bundle
// input at all — `web_search`'s key belongs to the key store, not to this
// recipe — so it arrives only in `preflight.needsInput`, carrying the
// providers that would clear it. Rendered here rather than in Settings
// because the whole point is that the prerequisite is answered in the flow,
// not discovered at 6:20am when the briefing has no headlines. The ANSWER is a
// reference — provider + secret name — that the install writes onto the new
// personality as its tool binding; the value stays in the vault.
//
// When the bundle declares `requires.channels[].inlineSetup`, that picker is
// joined by `RecipeChannelSetup` — because on a machine with no bot the picker
// alone is a dead end. A Telegram bot binds to a PERSONALITY, and this
// recipe's personality is not written until the install runs, so "go bind one
// in Communications" could never be done first. Both routes are offered
// together: an existing chat, or a new bot set up right here.
//
// An ATTACH recipe opens with one more row: the personality it attaches to.
// The picker is the first thing on the step because every other answer may
// depend on it — a `path` input prefills from the chosen personality's
// working directory, and preflight re-runs against the chosen target.

export function RecipeInputsForm({
  bundle,
  preflight,
  values,
  onChange,
  targets,
  targetsLoading,
  selectedTarget,
  onPickTarget,
  channelSetup,
  onChannelSetup,
  onGatewayOwnsToken,
  secretBindings,
  onSecretBinding,
  attachTargets = [],
  attachTarget = null,
  onPickAttachTarget,
  modeChoice,
}: {
  /** The bundle PROJECTED to the mode being installed — create or attach, never both. */
  bundle: RecipeBundleWire;
  /**
   * A `both` recipe's choice: create its own personality, or attach to one.
   * Present only when the recipe offers both; drawn first, because the rest
   * of the form depends on it.
   */
  modeChoice?: {
    createName: string;
    value: RecipeInstallMode;
    onChange: (mode: RecipeInstallMode) => void;
  };
  preflight: RecipePreflight | undefined;
  values: Record<string, string>;
  onChange: (key: string, value: string) => void;
  /** Attach mode: the personalities that can be attached to (built-ins are read-only). */
  attachTargets?: Personality[];
  /** Attach mode: the chosen target's id. */
  attachTarget?: string | null;
  onPickAttachTarget?: (id: string) => void;
  targets: CronDeliveryTarget[];
  targetsLoading: boolean;
  selectedTarget: CronDeliveryTarget | null;
  onPickTarget: (target: CronDeliveryTarget) => void;
  /** A bot being set up here and now, when the bundle allows it. */
  channelSetup: ChannelSetupDraft | null;
  onChannelSetup: (draft: ChannelSetupDraft | null) => void;
  /** 409 — the gateway owns the token; re-read the existing target list. */
  onGatewayOwnsToken: () => void;
  /** Which named secret answers each credential row, keyed by tool name. */
  secretBindings: RecipeSecretBindings;
  onSecretBinding: (toolName: string, next: RecipeSecretBindings[string] | null) => void;
}) {
  const stillNeeded = new Set((preflight?.needsInput ?? []).map((row) => row.key));
  const inlinePlatform = inlineSetupPlatform(bundle);
  const credentials = (preflight?.needsInput ?? []).filter((row) => row.kind === 'credential');

  return (
    <ul className="recipe-rowlist recipe-form">
      {modeChoice ? (
        <li className="recipe-rowlist-row">
          <span className="recipe-glyph recipe-glyph--ok">✓</span>
          <span className="recipe-rowlist-key">
            <span className="recipe-field-label">How to install</span>
            <span className="recipe-rowlist-sub">
              Create {modeChoice.createName} as a new personality, or give this recipe to one you
              already have.
            </span>
            <span className="recipe-field-control">
              <Segmented<RecipeInstallMode>
                value={modeChoice.value}
                onChange={modeChoice.onChange}
                options={[
                  { value: 'create', label: `Create ${modeChoice.createName}` },
                  { value: 'attach', label: 'Attach to an existing personality' },
                ]}
              />
            </span>
          </span>
          <span className="recipe-rowlist-value recipe-mono">{modeChoice.value}</span>
        </li>
      ) : null}
      {bundle.personality.mode === 'attach' ? (
        <li className="recipe-rowlist-row">
          <span className={`recipe-glyph recipe-glyph--${attachTarget ? 'ok' : 'warn'}`}>
            {attachTarget ? '✓' : '!'}
          </span>
          <span className="recipe-rowlist-key">
            <label className="recipe-field-label" htmlFor="recipe-attach-target">
              Attach to
            </label>
            <span className="recipe-rowlist-sub">
              The personality that gains this recipe's tools, reach and instructions. Its name,
              model and network policy stay as they are.
            </span>
            <span className="recipe-field-control">
              <Select
                id="recipe-attach-target"
                value={attachTarget ?? undefined}
                placeholder="Choose a personality"
                onChange={(id: string) => onPickAttachTarget?.(id)}
                options={attachTargets.map((p) => ({
                  value: p.id,
                  label: p.name === p.id ? p.id : `${p.name} (${p.id})`,
                }))}
                className="recipe-field-select"
              />
            </span>
          </span>
          <span className="recipe-rowlist-value recipe-mono">personality</span>
        </li>
      ) : null}
      {credentials.map((row) => {
        const toolName = credentialToolName(row);
        return (
          <li className="recipe-rowlist-row" key={row.key}>
            <span className="recipe-glyph recipe-glyph--warn">!</span>
            <span className="recipe-rowlist-key">
              <span className="recipe-field-label">{row.label}</span>
              <span className="recipe-rowlist-sub">{row.help}</span>
              <span className="recipe-field-control">
                <RecipeSecretSetup
                  row={row}
                  binding={secretBindings[toolName] ?? null}
                  onChange={(next) => onSecretBinding(toolName, next)}
                />
              </span>
            </span>
            <span className="recipe-rowlist-value recipe-mono">{row.kind}</span>
          </li>
        );
      })}
      {bundle.requires.inputs.map((input) => {
        const needed = stillNeeded.has(input.key);
        return (
          <li className="recipe-rowlist-row" key={input.key}>
            <span className={`recipe-glyph recipe-glyph--${needed ? 'warn' : 'ok'}`}>
              {needed ? '!' : '✓'}
            </span>
            <span className="recipe-rowlist-key">
              <label className="recipe-field-label" htmlFor={`recipe-input-${input.key}`}>
                {input.label}
              </label>
              <span className="recipe-rowlist-sub">{input.help}</span>
              <span className="recipe-field-control">
                {input.kind === 'chatTarget' ? (
                  <>
                    <DeliveryPicker
                      targets={targets}
                      loading={targetsLoading}
                      selected={selectedTarget}
                      onPick={onPickTarget}
                      canSetUpInline={inlinePlatform !== null}
                    />
                    {inlinePlatform ? (
                      <RecipeChannelSetup
                        platform={inlinePlatform}
                        value={channelSetup}
                        onChange={onChannelSetup}
                        onGatewayOwnsToken={onGatewayOwnsToken}
                      />
                    ) : null}
                  </>
                ) : input.kind === 'choice' ? (
                  <Select
                    id={`recipe-input-${input.key}`}
                    value={values[input.key] ?? undefined}
                    onChange={(value: string) => onChange(input.key, value)}
                    options={(input.options ?? []).map((option) => ({
                      value: option,
                      label: option,
                    }))}
                    className="recipe-field-select"
                  />
                ) : input.kind === 'secret' ? (
                  <Input.Password
                    id={`recipe-input-${input.key}`}
                    value={values[input.key] ?? ''}
                    placeholder={input.placeholder}
                    onChange={(e) => onChange(input.key, e.target.value)}
                  />
                ) : (
                  <Input
                    id={`recipe-input-${input.key}`}
                    value={values[input.key] ?? ''}
                    placeholder={input.placeholder}
                    onChange={(e) => onChange(input.key, e.target.value)}
                    className={
                      input.kind === 'cron' || input.kind === 'path' ? 'recipe-mono' : undefined
                    }
                  />
                )}
              </span>
            </span>
            <span className="recipe-rowlist-value recipe-mono">{input.kind}</span>
          </li>
        );
      })}
    </ul>
  );
}

function DeliveryPicker({
  targets,
  loading,
  selected,
  onPick,
  canSetUpInline,
}: {
  targets: CronDeliveryTarget[];
  loading: boolean;
  selected: CronDeliveryTarget | null;
  onPick: (target: CronDeliveryTarget) => void;
  canSetUpInline: boolean;
}) {
  if (loading) return <Spin size="small" />;

  if (targets.length === 0) {
    // The old copy here — "bind a bot to this agent in Communications, then
    // re-check" — described something that could not be done: the agent does
    // not exist yet, so no bot can be bound to it. Where the setup panel below
    // can do the job, say nothing at all and let it.
    if (canSetUpInline) return null;
    return (
      <span className="recipe-field-help">
        No chat can receive this yet. Bind a bot to this agent in Communications, then re-check.
      </span>
    );
  }

  return (
    <Radio.Group
      className="recipe-target-group"
      value={selected ? chatTargetValue(selected) : undefined}
      onChange={(e) => {
        const picked = targets.find((target) => chatTargetValue(target) === e.target.value);
        if (picked) onPick(picked);
      }}
    >
      {targets.map((target) => (
        <Radio key={chatTargetValue(target)} value={chatTargetValue(target)}>
          <span className="recipe-mono">
            {target.platform} · {target.botLabel} · {target.chatId}
          </span>
          <span className="recipe-row-action">
            {target.label} — {deliveryTargetReason(target.source)}
          </span>
        </Radio>
      ))}
    </Radio.Group>
  );
}
