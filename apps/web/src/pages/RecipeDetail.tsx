import type {
  CronDeliveryTarget,
  RecipeInstallMode,
  RecipeInstallReport,
  RecipeSecretBindings,
} from '@ethosagent/web-contracts';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, Skeleton } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RecipeInputsForm } from '../components/recipes/RecipeInputsForm';
import { RecipeInstallPanel } from '../components/recipes/RecipeInstallPanel';
import {
  CreatesList,
  NeedsYouGroup,
  OptionalGroup,
  PostInstallList,
  ReadyGroup,
  WillCreateList,
} from '../components/recipes/RecipePrereqs';
import { RecipeCallout, RecipeRowItem, RecipeRowList } from '../components/recipes/RecipeRowList';
import { type RecipeStepId, RecipeStepper } from '../components/recipes/RecipeStepper';
import { usePersonalityList } from '../features/personalities/api/queries';
import { recipeKeys } from '../features/recipes/api/keys';
import { useRecipeInstall } from '../features/recipes/api/mutations';
import { useRecipe, useRecipeList, useRecipePreflight } from '../features/recipes/api/queries';
import {
  type ChannelSetupDraft,
  chatTargetInputKey,
  chatTargetValue,
  defaultInputValues,
  deliverToFromTarget,
  inlineChatTargetValue,
  installActionLabel,
  installBlockedReason,
  isStaleRecipeError,
  needsDeliveryTarget,
  prefillPathInputs,
  projectBundle,
  recipeAgentName,
  resolveInstallMode,
} from '../lib/recipes';
import { rpc } from '../rpc';

// One recipe, walked end to end (plan/phases/recipes-gallery.md §5): what it
// does → what it still needs from you → the character sheet it would write →
// the install → what is left on you.
//
// Four stages on one route rather than four routes: preflight is stateless and
// repeatable, so a reload loses nothing and there is no wizard session to
// expire. Stages 1-4 are provably read-only; the only write is the button that
// names the outcome.
//
// The stepper across the top is ORIENTATION — it says where you are in a walk
// that begins on `/recipes`, and lets you step back into a screen you have
// already passed. The outcome-named buttons at the foot are still what moves
// you forward, because that is where the decision is being made.

type Stage = 'detail' | 'inputs' | 'confirm' | 'done';

export function RecipeDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const recipeQuery = useRecipe(id);
  const bundle = recipeQuery.data?.recipe;

  const [stage, setStage] = useState<Stage>('detail');
  const [values, setValues] = useState<Record<string, string>>({});
  const [target, setTarget] = useState<CronDeliveryTarget | null>(null);
  // A bot being created as part of this install. Mutually exclusive with
  // `target`: one points at an existing bot's chat, the other makes the bot.
  const [channelSetup, setChannelSetup] = useState<ChannelSetupDraft | null>(null);
  // Which named secret answers each credential prerequisite. References only —
  // a provider and a vault NAME. The value lives in the vault and is written
  // there by the picker's own add form, never by this page or this install.
  const [secretBindings, setSecretBindings] = useState<RecipeSecretBindings>({});
  const [report, setReport] = useState<RecipeInstallReport | null>(null);
  // Attach mode: the personality the recipe lands on. It is `personalityIdOverride`
  // on both preflight and install — the same field create mode uses as its
  // collision escape hatch, read as the TARGET there.
  const [attachTarget, setAttachTarget] = useState<string | null>(null);
  // A `both` recipe's chosen view. Defaults to create, like the server does;
  // a single-mode recipe ignores it.
  const [installMode, setInstallMode] = useState<RecipeInstallMode>('create');

  // Seed the form from the bundle's declared defaults, once. Re-seeding on
  // every bundle reference would wipe what the user has typed.
  const seeded = useRef(false);
  useEffect(() => {
    if (!bundle || seeded.current) return;
    seeded.current = true;
    setValues(defaultInputValues(bundle));
  }, [bundle]);

  const mode = bundle ? resolveInstallMode(bundle, installMode) : 'create';
  const isAttach = mode === 'attach';
  const canChooseMode = bundle?.personality.mode === 'both';
  const personalitiesQuery = usePersonalityList({ enabled: isAttach });
  // Built-ins are read-only, so an attach cannot land on one.
  const attachTargets = (personalitiesQuery.data?.items ?? []).filter((p) => !p.builtin);
  const attachedPersonality = attachTargets.find((p) => p.id === attachTarget) ?? null;
  // The gallery row carries which personalities already hold this recipe.
  const listQuery = useRecipeList();
  const attachedTo = listQuery.data?.recipes.find((r) => r.id === id)?.attachedTo ?? null;

  const preflightQuery = useRecipePreflight(id, values, secretBindings, {
    enabled: bundle !== undefined,
    ...(isAttach && attachTarget ? { personalityIdOverride: attachTarget } : {}),
    ...(canChooseMode ? { installMode: mode } : {}),
  });
  const preflight = preflightQuery.data;

  const needsTarget = bundle ? needsDeliveryTarget(bundle) : false;
  const personalityId = isAttach
    ? (attachTarget ?? '')
    : bundle && bundle.personality.mode !== 'attach'
      ? bundle.personality.id
      : '';
  const targetsQuery = useQuery({
    queryKey: ['cron', 'deliveryTargets', personalityId],
    queryFn: () => rpc.cron.deliveryTargets({ personalityId }),
    enabled: needsTarget && personalityId.length > 0,
  });
  const targets = targetsQuery.data?.targets ?? [];

  const install = useRecipeInstall();

  if (recipeQuery.isLoading) return <Skeleton active paragraph={{ rows: 6 }} />;

  if (recipeQuery.error || !bundle) {
    return (
      <Alert
        type="error"
        showIcon
        message="Could not load this recipe"
        description={
          recipeQuery.error instanceof Error ? recipeQuery.error.message : `No recipe '${id}'.`
        }
        action={<Link to="/recipes">Back to recipes</Link>}
      />
    );
  }

  // The bundle as the ONE view this install runs as. Every surface from here
  // down reads `view`, so a `both` recipe is a create or an attach — never a
  // third layout.
  const view = projectBundle(bundle, mode);

  const pickTarget = (picked: CronDeliveryTarget) => {
    setTarget(picked);
    setChannelSetup(null);
    const key = chatTargetInputKey(bundle);
    // Both halves are written: the structured address the server acts on, and
    // the input's own text so its "still needed from you" row clears.
    if (key) setValues((prev) => ({ ...prev, [key]: chatTargetValue(picked) }));
  };

  /**
   * The inline route — a token and a discovered chat, no bot yet. The same two
   * halves are written, except the address half has no `botKey` in it: the
   * install creates the bot and derives that itself.
   */
  const pickChannelSetup = (draft: ChannelSetupDraft | null) => {
    setChannelSetup(draft);
    if (draft) setTarget(null);
    const key = chatTargetInputKey(bundle);
    if (key) {
      setValues((prev) => ({ ...prev, [key]: draft ? inlineChatTargetValue(draft) : '' }));
    }
  };

  const pickSecretBinding = (toolName: string, next: RecipeSecretBindings[string] | null) => {
    setSecretBindings((prev) => {
      const merged = { ...prev };
      if (next) merged[toolName] = next;
      else delete merged[toolName];
      return merged;
    });
  };

  /**
   * Attach mode: choosing the target also answers every still-empty `path`
   * input with its working directory. Only the EMPTY ones — a path the user
   * typed before switching personalities is theirs.
   */
  const pickAttachTarget = (nextId: string) => {
    setAttachTarget(nextId);
    const workdir = attachTargets.find((p) => p.id === nextId)?.fs_reach?.workdir ?? null;
    setValues((prev) => prefillPathInputs(bundle, prev, workdir));
  };

  /**
   * The picker is reachable only in attach mode, so the workdir prefill above
   * runs only there; in create mode the path input becomes the NEW
   * personality's workdir and there is nothing to prefill from. Switching
   * modes never touches what was typed.
   */
  const pickMode = (next: RecipeInstallMode) => {
    setInstallMode(next);
    if (next === 'create') setAttachTarget(null);
  };

  const blockedReason = installBlockedReason({
    preflight,
    needsTarget,
    hasTarget: target !== null || channelSetup !== null,
  });
  const agentName = recipeAgentName(view, attachedPersonality?.name);

  const rePreview = () => {
    install.reset();
    setStage('detail');
    void queryClient.invalidateQueries({ queryKey: recipeKeys.all() });
  };

  const runInstall = () => {
    install.mutate(
      {
        id: bundle.id,
        version: bundle.version,
        inputs: values,
        ...(isAttach && attachTarget ? { personalityIdOverride: attachTarget } : {}),
        ...(canChooseMode ? { installMode: mode } : {}),
        ...(target ? { deliverTo: deliverToFromTarget(target) } : {}),
        // The token travels HERE and only here — never through `inputs`, which
        // is re-sent to `preflight` on every keystroke and cached in the query
        // key. One call, one hop.
        ...(channelSetup
          ? {
              channelSetup: {
                platform: channelSetup.platform,
                token: channelSetup.token,
                chatId: channelSetup.chatId,
              },
            }
          : {}),
        // References, not credentials — the install records them as the new
        // personality's tool binding so the key the user picked is the key the
        // agent resolves.
        ...(Object.keys(secretBindings).length > 0 ? { secretBindings } : {}),
      },
      {
        onSuccess: (result) => {
          setReport(result);
          setStage('done');
        },
      },
    );
  };

  const openChat = () => {
    // The personality the install wrote — created, or attached to.
    const written = report?.created.personality;
    if (!written) return;
    // No `?new=1`: a freshly created agent has no session to restore, and
    // stacking two param-consuming effects in Chat is a race for no gain.
    navigate(`/p/${written}/chat?draft=${encodeURIComponent(report?.starterPrompt ?? '')}`);
  };

  const currentStep: RecipeStepId =
    stage === 'done'
      ? 'working'
      : stage === 'confirm'
        ? install.isPending
          ? 'install'
          : 'confirm'
        : stage;

  const goToStep = (step: RecipeStepId) => {
    if (step === 'detail' || step === 'inputs' || step === 'confirm') setStage(step);
  };

  const crumb =
    stage === 'inputs'
      ? 'Setup'
      : stage === 'confirm'
        ? 'Preview'
        : stage === 'done'
          ? 'Ready'
          : null;

  return (
    <div className="recipe-detail">
      <header className="recipe-detail-header">
        <div className="recipe-eyebrow recipe-mono">
          Library / Recipes / {bundle.title}
          {crumb ? ` / ${crumb}` : ''}
        </div>
        <h2 className="recipe-detail-title">{bundle.title}</h2>
        <p className="recipe-detail-summary">{bundle.summary}</p>
        {bundle.sourceDoc && (
          <div className="recipe-mono recipe-detail-source">{bundle.sourceDoc}</div>
        )}
      </header>

      <RecipeStepper
        current={currentStep}
        onGoTo={stage === 'done' || install.isPending ? undefined : goToStep}
      />

      {install.error && !isStaleRecipeError(install.error) ? (
        <Alert
          type="error"
          showIcon
          message="Install refused — nothing was created"
          description={
            install.error instanceof Error ? install.error.message : String(install.error)
          }
        />
      ) : null}

      {isStaleRecipeError(install.error) ? (
        <Alert
          type="warning"
          showIcon
          message="This recipe changed while you were reading it"
          description={
            install.error instanceof Error ? install.error.message : String(install.error)
          }
          action={
            <Button size="small" onClick={rePreview}>
              Re-read the recipe
            </Button>
          }
        />
      ) : null}

      {stage === 'detail' && (
        <div className="recipe-columns">
          <div className="recipe-column-main">
            <section className="recipe-section">
              <div className="recipe-section-label">What it does</div>
              <p className="recipe-prose">
                {bundle.personality.mode === 'create'
                  ? bundle.personality.description
                  : bundle.personality.mode === 'both'
                    ? `Creates ${bundle.personality.name}, or attaches to a personality you choose. ${bundle.personality.description}`
                    : 'Attaches to a personality you choose. It keeps its name, model and network policy, and gains this recipe’s tools, filesystem reach and instructions.'}
              </p>
              {attachedTo && attachedTo.length > 0 ? (
                <p className="recipe-prose">
                  Attached to:{' '}
                  {attachedTo.map((pid, i) => (
                    <span key={pid}>
                      {i > 0 ? ', ' : ''}
                      <Link className="recipe-mono" to={`/p/${pid}/identity`}>
                        {pid}
                      </Link>
                    </span>
                  ))}
                </p>
              ) : null}
            </section>

            <CreatesList bundle={bundle} />

            {bundle.examplePrompts.length > 0 && (
              <section className="recipe-section">
                <div className="recipe-section-label">Things you can ask it</div>
                <RecipeRowList>
                  {bundle.examplePrompts.map((prompt) => (
                    <RecipeRowItem key={prompt} glyph="›" label={prompt} />
                  ))}
                </RecipeRowList>
              </section>
            )}

            {bundle.notes.length > 0 && (
              <section className="recipe-section">
                <div className="recipe-section-label">Before you install</div>
                <RecipeRowList>
                  {bundle.notes.map((note) => (
                    <RecipeRowItem key={note} glyph="○" tone="muted" label={note} />
                  ))}
                </RecipeRowList>
              </section>
            )}
          </div>

          <aside className="recipe-column-side">
            <ReadyGroup bundle={bundle} preflight={preflight} />
            <NeedsYouGroup bundle={bundle} preflight={preflight} />
            <OptionalGroup bundle={bundle} preflight={preflight} />
            <PostInstallList items={bundle.postInstall} title="You'll still need to" />
            <CharacterSheet markdown={preflight?.characterSheet} />
          </aside>
        </div>
      )}

      {stage === 'inputs' && (
        <div className="recipe-columns">
          <div className="recipe-column-main">
            <section className="recipe-section">
              <div className="recipe-section-label">Before we build it</div>
              <p className="recipe-prose">
                Everything is checked first. Nothing is written to your machine until every blocker
                below is cleared — a half-installed recipe is worse than none.
              </p>
              <RecipeInputsForm
                bundle={view}
                preflight={preflight}
                values={values}
                onChange={(key, value) => setValues((prev) => ({ ...prev, [key]: value }))}
                targets={targets}
                targetsLoading={targetsQuery.isLoading}
                selectedTarget={target}
                onPickTarget={pickTarget}
                channelSetup={channelSetup}
                onChannelSetup={pickChannelSetup}
                onGatewayOwnsToken={() => void targetsQuery.refetch()}
                secretBindings={secretBindings}
                onSecretBinding={pickSecretBinding}
                attachTargets={attachTargets}
                attachTarget={attachTarget}
                onPickAttachTarget={pickAttachTarget}
                {...(canChooseMode && bundle.personality.mode === 'both'
                  ? {
                      modeChoice: {
                        createName: bundle.personality.name,
                        value: mode,
                        onChange: pickMode,
                      },
                    }
                  : {})}
              />
            </section>
          </div>
          <aside className="recipe-column-side">
            <ReadyGroup bundle={bundle} preflight={preflight} />
            <NeedsYouGroup bundle={bundle} preflight={preflight} />
            <OptionalGroup bundle={bundle} preflight={preflight} />
          </aside>
        </div>
      )}

      {stage === 'confirm' && preflight && (
        <div className="recipe-columns">
          <div className="recipe-column-main">
            <CharacterSheet markdown={preflight.characterSheet} />
            {target ? (
              <RecipeCallout title="One thing to know">
                A scheduled job delivers to the chat it was created from. This install stamps{' '}
                <span className="recipe-mono">{chatTargetValue(target)}</span> as the destination,
                which is why the chat is picked before anything is written.
              </RecipeCallout>
            ) : null}
            {channelSetup ? (
              <RecipeCallout title="One thing to know">
                This install also creates the Telegram bot{' '}
                <span className="recipe-mono">{channelSetup.botLabel ?? 'you set up'}</span> and
                binds it to {agentName} — which cannot happen in Communications beforehand, because{' '}
                {agentName} does not exist yet. The briefing goes to{' '}
                <span className="recipe-mono">{channelSetup.chatLabel}</span>. If anything later in
                the install fails, the bot is removed again.
              </RecipeCallout>
            ) : null}
          </div>
          <aside className="recipe-column-side">
            <WillCreateList bundle={view} preflight={preflight} />
            <PostInstallList items={preflight.postInstall} title="You'll still need to" />
            <NeedsYouGroup bundle={bundle} preflight={preflight} />
            <OptionalGroup bundle={bundle} preflight={preflight} />
          </aside>
        </div>
      )}

      {stage === 'done' && report && (
        <RecipeInstallPanel
          bundle={view}
          report={report}
          onOpenChat={openChat}
          schedules={preflight?.willCreate.cronJobs ?? []}
          target={target}
          agentName={attachedPersonality?.name}
        />
      )}

      {stage !== 'done' && (
        <div className="recipe-actions">
          {stage === 'detail' && (
            <Button type="primary" onClick={() => setStage('inputs')}>
              {bundle.personality.mode === 'attach'
                ? 'Choose a personality'
                : `Set up ${agentName}`}
            </Button>
          )}
          {stage === 'inputs' && (
            <>
              <Button onClick={() => setStage('detail')}>Back</Button>
              <Button
                type="primary"
                disabled={blockedReason !== null}
                onClick={() => setStage('confirm')}
              >
                Review what gets created
              </Button>
            </>
          )}
          {stage === 'confirm' && (
            <>
              <Button onClick={() => setStage('inputs')}>Back</Button>
              <Button
                type="primary"
                disabled={blockedReason !== null}
                loading={install.isPending}
                onClick={runInstall}
              >
                {installActionLabel(
                  view,
                  preflight?.willCreate.cronJobs ?? [],
                  attachedPersonality?.name,
                )}
              </Button>
            </>
          )}
          {blockedReason && stage !== 'detail' && (
            <span className="recipe-field-help">{blockedReason}</span>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The preview IS the character sheet the server rendered (D5). There is no
 * second renderer here on purpose — a second one is a second thing to keep in
 * sync with what actually gets written.
 */
function CharacterSheet({ markdown }: { markdown: string | undefined }) {
  return (
    <section className="recipe-section">
      <div className="recipe-section-label">What gets written</div>
      {markdown ? (
        <pre className="recipe-sheet">{markdown}</pre>
      ) : (
        <Skeleton active paragraph={{ rows: 6 }} />
      )}
    </section>
  );
}
