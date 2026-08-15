// The Settings route element. It NEVER unmounts while you are on the surface.
//
// THE INVARIANT (plan/phases/settings-navigation.md §5.3, quoted so it can be
// quoted back in review):
//
//   The `<Form>` element must enclose the `<Outlet/>`. A pane must never create
//   a form instance for page-Save-backed fields, and `preserve` must never be
//   set to `false`.
//
// Why, concretely. `onFinish` reads `form.getFieldsValue(true)` — the WHOLE
// store, including fields whose `Form.Item` is currently unmounted. That works
// because (a) this `<Form>` mounts once and never remounts, (b) `preserve` is
// unset and therefore `true` (`@rc-component/form/lib/hooks/useForm.js:524`,
// `mergedPreserve ?? true`), so an unmounting `Form.Item` leaves its value in
// the store. Routing the panes grew the unmounted set from "the advanced blocks"
// to "every field outside the category on screen", and the patch builder maps
// ~100 fields through `values.x ?? null` — so a missing value is not a skipped
// update, it is an explicit `null`, which is a CLEAR. Move the `<Form>` inside a
// pane and saving from Memory silently deletes the trunk credentials.
//
// Guarded by `__tests__/settings-form-placement.test.ts` (structure) and
// `__tests__/settings-patch-completeness.test.ts` (behaviour).

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntApp, Form, Spin, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import { isDesktop } from '../../lib/desktop';
import { rpc } from '../../rpc';
import { AdvancedToggle } from './AdvancedToggle';
import { CategoryRail } from './CategoryRail';
import { buildConfigPatch, type SettingsRows } from './lib/build-config-patch';
import type { ConfigUpdatePatch } from './lib/config-types';
import { auxFormFromConfig, type FormShape } from './lib/form-shape';
import { resolveSettingsRoute } from './lib/resolve-settings-route';
import {
  type ChannelToolsetRow,
  channelToolsetRowsFromConfig,
  emptyRow,
  type ProviderRow,
  type QuickCommandRow,
  quickCommandRowsFromConfig,
  type RetentionRow,
  retentionRowsFromConfig,
  rowsFromConfig,
} from './lib/rows';
import { useShowAdvanced } from './lib/settings-advanced';
import { computeDirty, type DirtySnapshot } from './lib/settings-dirty';
import { visibleCategories } from './lib/taxonomy';
import { type VoiceBotRow, voiceBotRowsFromConfig } from './lib/voice-bots';
import {
  CALL_ACCENT_CUSTOM,
  isCallAccentPreset,
  voiceChannelTtsOutFromConfig,
} from './lib/voice-options';
import {
  type VoiceProviderRow,
  voiceRealtimeProviderRowsFromConfig,
  voiceSttProviderRowsFromConfig,
  voiceTtsProviderRowsFromConfig,
} from './lib/voice-roster';
import { voiceBargeInFromConfig } from './lib/voice-telephony';
import type { SettingsPaneContext } from './pane-context';
import { SaveBar } from './SaveBar';

export function SettingsShell() {
  const qc = useQueryClient();
  const { notification } = AntApp.useApp();
  const { pathname } = useLocation();
  const { showAdvanced, setShowAdvanced } = useShowAdvanced();
  const [form] = Form.useForm<FormShape>();
  const [providerRows, setProviderRows] = useState<ProviderRow[]>([emptyRow()]);
  const [quickCommandRows, setQuickCommandRows] = useState<QuickCommandRow[]>([]);
  const [channelToolsetRows, setChannelToolsetRows] = useState<ChannelToolsetRow[]>([]);
  const [voiceTtsProviderRows, setVoiceTtsProviderRows] = useState<VoiceProviderRow[]>([]);
  const [voiceSttProviderRows, setVoiceSttProviderRows] = useState<VoiceProviderRow[]>([]);
  const [voiceRealtimeProviderRows, setVoiceRealtimeProviderRows] = useState<VoiceProviderRow[]>(
    [],
  );
  const [retentionRows, setRetentionRows] = useState<RetentionRow[]>([]);
  const [voiceBotRows, setVoiceBotRows] = useState<VoiceBotRow[]>([]);
  const hydratedRef = useRef(false);
  // What hydration last wrote — the left-hand side of the dirty diff (D9).
  const [saved, setSaved] = useState<DirtySnapshot | null>(null);
  // The form store mutates outside React, so nothing re-renders when a field
  // changes. This counter is what makes the derived dirty count live.
  const [storeRevision, setStoreRevision] = useState(0);

  const configQuery = useQuery({
    queryKey: ['config'],
    queryFn: () => rpc.config.get(),
  });

  const personalitiesQuery = useQuery({
    queryKey: ['personalities', 'list'],
    queryFn: () => rpc.personalities.list({}),
  });

  // Hydrate form + provider rows whenever config data arrives or refreshes.
  useEffect(() => {
    if (configQuery.data) {
      const hydrated: FormShape = {
        personality: configQuery.data.personality,
        memory: configQuery.data.memory,
        skin: configQuery.data.skin,
        approvalMode: configQuery.data.approvalMode,
        verbosity: configQuery.data.verbosity,
        debugMode: configQuery.data.debugMode,
        contextLayering: configQuery.data.contextLayering,
        debugPanelEnabled: configQuery.data.debugPanelEnabled,
        debugPanelModel: configQuery.data.debugPanelModel ?? '',
        adminEnabled: configQuery.data.adminEnabled,
        streamingEdits: configQuery.data.streamingEdits,
        autoCompact: configQuery.data.autoCompact,
        memoryConsolidationEnabled: configQuery.data.memoryConsolidationEnabled,
        memoryCaptureEnabled: configQuery.data.memoryCaptureEnabled,
        memoryCaptureModel: configQuery.data.memoryCaptureModel ?? '',
        memoryNotices: configQuery.data.memoryNotices,
        voiceEnabled: Boolean(configQuery.data.voiceProvider),
        voiceChime: configQuery.data.voiceChime,
        callStyle: configQuery.data.callStyle,
        // A hex the presets do not cover lands in the custom field, so a
        // hand-edited config.yaml survives a round trip through this form.
        callAccent: isCallAccentPreset(configQuery.data.callAccent)
          ? configQuery.data.callAccent
          : CALL_ACCENT_CUSTOM,
        callAccentCustom: isCallAccentPreset(configQuery.data.callAccent)
          ? ''
          : configQuery.data.callAccent,
        voiceEndpointSilenceMs: configQuery.data.voiceEndpointSilenceMs,
        voiceBargeThreshold: configQuery.data.voiceBargeThreshold,
        voiceBargeSustainMs: configQuery.data.voiceBargeSustainMs,
        voiceSpeechThreshold: configQuery.data.voiceSpeechThreshold,
        voiceSpeechMinMs: configQuery.data.voiceSpeechMinMs,
        voiceProvider: configQuery.data.voiceProvider ?? '',
        voiceApiKey: '',
        voiceBaseUrl: configQuery.data.voiceBaseUrl ?? '',
        voiceModel: configQuery.data.voiceModel ?? '',
        voiceTtsProvider: configQuery.data.voiceTtsProvider ?? '',
        voiceTtsApiKey: '',
        voiceTtsVoice: configQuery.data.voiceTtsVoice ?? '',
        voiceTtsBaseUrl: configQuery.data.voiceTtsBaseUrl ?? '',
        voiceTtsModel: configQuery.data.voiceTtsModel ?? '',
        voiceSttCommand: configQuery.data.voiceSttCommand ?? '',
        voiceTtsCommand: configQuery.data.voiceTtsCommand ?? '',
        voiceTtsOutputFormat: configQuery.data.voiceTtsOutputFormat ?? '',
        voiceTtsTimeoutMs: configQuery.data.voiceTtsTimeoutMs,
        voiceTtsMaxTextLength: configQuery.data.voiceTtsMaxTextLength,
        voiceSttTimeoutMs: configQuery.data.voiceSttTimeoutMs,
        voiceEgressGate: configQuery.data.voiceTrustedPlugins !== null,
        voiceTrustedPlugins: configQuery.data.voiceTrustedPlugins ?? [],
        voiceDefaultMode: configQuery.data.voiceDefaultMode ?? '',
        voiceChannelTtsOut: voiceChannelTtsOutFromConfig(configQuery.data.voiceChannelTtsOut),
        voiceTranscodeFfmpegPath: configQuery.data.voiceTranscodeFfmpegPath ?? '',
        voiceTranscodeBitrateKbps: configQuery.data.voiceTranscodeBitrateKbps,
        voiceTranscodeTimeoutSec: configQuery.data.voiceTranscodeTimeoutSec,
        voiceArtifactAbandonAfterDays: configQuery.data.voiceArtifactAbandonAfterDays,
        voiceArtifactMaxTotalMb: configQuery.data.voiceArtifactMaxTotalMb,
        voiceTier: configQuery.data.voiceTier ?? '',
        voiceRealtimeDefault: configQuery.data.voiceRealtimeDefault ?? '',
        voiceRealtimeSessionBudgetUsd: configQuery.data.voiceRealtimeSessionBudgetUsd,
        // Telephony. The four secret fields hydrate BLANK on purpose — blank
        // means "keep what is stored", and the previews are shown beside them.
        voiceTrunkProvider: configQuery.data.voiceTrunkProvider ?? '',
        voiceTrunkId: configQuery.data.voiceTrunkId ?? '',
        voiceTrunkFromNumber: configQuery.data.voiceTrunkFromNumber ?? '',
        voiceTrunkUsername: configQuery.data.voiceTrunkUsername ?? '',
        voiceTrunkPassword: '',
        voiceTrunkWebhookSecret: '',
        voiceTrunkWebhookPath: configQuery.data.voiceTrunkWebhookPath ?? '',
        voiceTrunkCodec: configQuery.data.voiceTrunkCodec ?? '',
        voiceLivekitUrl: configQuery.data.voiceLivekitUrl ?? '',
        voiceLivekitApiKey: '',
        voiceLivekitApiSecret: '',
        voiceInboundAllowlist: configQuery.data.voiceInboundAllowlist ?? [],
        voiceInboundReceptionist: configQuery.data.voiceInboundReceptionist ?? '',
        voiceInboundConcurrencyCap: configQuery.data.voiceInboundConcurrencyCap,
        voiceInboundPerCallerPerHour: configQuery.data.voiceInboundPerCallerPerHour,
        voiceInboundDailyBudgetUsd: configQuery.data.voiceInboundDailyBudgetUsd,
        voiceInboundPrewarm: configQuery.data.voiceInboundPrewarm ?? '',
        voiceInboundOwnerPlatform: configQuery.data.voiceInboundOwnerPlatform ?? '',
        voiceInboundOwnerChatId: configQuery.data.voiceInboundOwnerChatId ?? '',
        voiceInboundOwnerBotKey: configQuery.data.voiceInboundOwnerBotKey ?? '',
        voiceBargeIn: voiceBargeInFromConfig(configQuery.data.voiceBargeIn),
        displayVerbosity: configQuery.data.displayVerbosity,
        displayBusyInputMode: configQuery.data.displayBusyInputMode,
        displayToolPreviewLength: configQuery.data.displayToolPreviewLength,
        displayResumeHint: configQuery.data.displayResumeHint,
        displayResumeRecapTurns: configQuery.data.displayResumeRecapTurns,
        displayBellOnComplete: configQuery.data.displayBellOnComplete,
        compaction: { ...configQuery.data.compaction },
        memoryVault: {
          path: configQuery.data.memoryVault.path ?? '',
          agentDir: configQuery.data.memoryVault.agentDir ?? '',
          prefetch: configQuery.data.memoryVault.prefetch,
          exclude: configQuery.data.memoryVault.exclude,
        },
        memoryApproval: { ...configQuery.data.memoryApproval },
        memoryConsolidation: { ...configQuery.data.memoryConsolidation },
        memoryCapture: {
          provider: configQuery.data.memoryCapture.provider ?? '',
          apiKey: '',
          baseUrl: configQuery.data.memoryCapture.baseUrl ?? '',
          maxPerHour: configQuery.data.memoryCapture.maxPerHour,
          maxPerDay: configQuery.data.memoryCapture.maxPerDay,
        },
        background: { ...configQuery.data.background },
        nightlyPass: { ...configQuery.data.nightlyPass },
        weeklyDigest: { ...configQuery.data.weeklyDigest },
        modelCatalog: {
          enabled: configQuery.data.modelCatalog.enabled,
          url: configQuery.data.modelCatalog.url ?? '',
          ttlHours: configQuery.data.modelCatalog.ttlHours,
        },
        logsRotation: { ...configQuery.data.logsRotation },
        webSearchBackend: configQuery.data.webSearchBackend ?? '',
        webExtractBackend: configQuery.data.webExtractBackend ?? '',
        auxCompression: auxFormFromConfig(configQuery.data.auxCompression),
        auxVision: auxFormFromConfig(configQuery.data.auxVision),
        auxWeb: auxFormFromConfig(configQuery.data.auxWeb),
        apiVersion: configQuery.data.apiVersion ?? '',
        verbose: configQuery.data.verbose,
        pluginsAutoInstall:
          configQuery.data.pluginsAutoInstall === null
            ? 'default'
            : configQuery.data.pluginsAutoInstall
              ? 'on'
              : 'off',
        webBaseUrl: configQuery.data.webBaseUrl ?? '',
      };
      form.setFieldsValue(hydrated);
      // Only hydrate provider rows on first load or when data changes identity
      if (!hydratedRef.current) {
        const hydratedRows: SettingsRows = {
          providerRows: rowsFromConfig(
            configQuery.data.providers,
            configQuery.data.provider,
            configQuery.data.model,
            configQuery.data.apiKeyPreview,
            configQuery.data.baseUrl,
          ),
          quickCommandRows: quickCommandRowsFromConfig(configQuery.data.quickCommands),
          channelToolsetRows: channelToolsetRowsFromConfig(configQuery.data.channelToolsets),
          voiceTtsProviderRows: voiceTtsProviderRowsFromConfig(configQuery.data.voiceTtsProviders),
          voiceSttProviderRows: voiceSttProviderRowsFromConfig(configQuery.data.voiceSttProviders),
          voiceRealtimeProviderRows: voiceRealtimeProviderRowsFromConfig(
            configQuery.data.voiceRealtimeProviders,
          ),
          retentionRows: retentionRowsFromConfig(
            configQuery.data.retention,
            configQuery.data.personalityRetention,
          ),
          voiceBotRows: voiceBotRowsFromConfig(configQuery.data.voiceBots),
        };
        setProviderRows(hydratedRows.providerRows);
        setQuickCommandRows(hydratedRows.quickCommandRows);
        setChannelToolsetRows(hydratedRows.channelToolsetRows);
        setVoiceTtsProviderRows(hydratedRows.voiceTtsProviderRows);
        setVoiceSttProviderRows(hydratedRows.voiceSttProviderRows);
        setVoiceRealtimeProviderRows(hydratedRows.voiceRealtimeProviderRows);
        setRetentionRows(hydratedRows.retentionRows);
        setVoiceBotRows(hydratedRows.voiceBotRows);
        hydratedRef.current = true;
        // The snapshot the dirty diff reads from. Set with the rows rather than
        // on every payload, so the two halves it compares always come from the
        // same `config.get` — a values-only refresh would make a row edit made
        // since the last save read as saved.
        setSaved({ values: hydrated, rows: hydratedRows });
      }
    }
  }, [configQuery.data, form]);

  const updateMut = useMutation({
    mutationFn: (patch: ConfigUpdatePatch) => rpc.config.update(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['config'] });
      qc.invalidateQueries({ queryKey: ['meta', 'capabilities'] });
      hydratedRef.current = false;
      notification.success({ message: 'Settings saved', placement: 'topRight' });
    },
    onError: (err) =>
      notification.error({ message: 'Save failed', description: (err as Error).message }),
  });

  const updateProviderRow = useCallback((index: number, patch: Partial<ProviderRow>) => {
    setProviderRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }, []);

  const moveProviderRow = useCallback((index: number, direction: -1 | 1) => {
    setProviderRows((prev) => {
      const next = [...prev];
      const target = index + direction;
      if (target < 0 || target >= next.length) return prev;
      const a = next[index];
      const b = next[target];
      if (!a || !b) return prev;
      next[index] = b;
      next[target] = a;
      return next;
    });
  }, []);

  const removeProviderRow = useCallback((index: number) => {
    setProviderRows((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const addProviderRow = useCallback(() => {
    setProviderRows((prev) => [...prev, emptyRow()]);
  }, []);

  // Above the early returns, because it is a hook. Recomputed whenever a field
  // or a row set moves: `storeRevision` is the dependency that makes a keystroke
  // count, since the form store mutates outside React and nothing else here
  // would notice.
  // biome-ignore lint/correctness/useExhaustiveDependencies: storeRevision is the change signal for `form`'s external store.
  const dirty = useMemo(
    () =>
      computeDirty(saved, form.getFieldsValue(true), {
        providerRows,
        quickCommandRows,
        channelToolsetRows,
        voiceTtsProviderRows,
        voiceSttProviderRows,
        voiceRealtimeProviderRows,
        retentionRows,
        voiceBotRows,
      }),
    [
      saved,
      form,
      storeRevision,
      providerRows,
      quickCommandRows,
      channelToolsetRows,
      voiceTtsProviderRows,
      voiceSttProviderRows,
      voiceRealtimeProviderRows,
      retentionRows,
      voiceBotRows,
    ],
  );

  if (configQuery.isLoading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: 200 }}>
        <Spin />
      </div>
    );
  }
  if (configQuery.error) {
    return (
      <Typography.Text type="danger">
        Failed to load config: {(configQuery.error as Error).message}
      </Typography.Text>
    );
  }

  const personalities = personalitiesQuery.data?.items ?? [];

  const onFinish = () => {
    // PANE ROUTING is why this reads the whole store. The panes mount and
    // unmount as you navigate, so at submit time most of the 128 fields have no
    // mounted `Form.Item`; `getFieldsValue(true)` reads the WHOLE store rather
    // than the registered-field subset, and `preserve` (unset, therefore true)
    // is what left the unmounted values in it. Both halves are load-bearing —
    // see the invariant at the top of this file.
    //
    // It is worth naming what is NO LONGER a reason: advanced controls used to
    // unmount behind `{showAdvanced && …}`, and that was the original argument
    // for `getFieldsValue(true)`. They dim now and stay mounted (D10), so that
    // argument is gone and routing is the whole of it. The call does not change
    // — routing unmounts far more than the advanced blocks ever did.
    const values: FormShape = form.getFieldsValue(true);
    const built = buildConfigPatch(
      values,
      {
        providerRows,
        quickCommandRows,
        channelToolsetRows,
        voiceTtsProviderRows,
        voiceSttProviderRows,
        voiceRealtimeProviderRows,
        retentionRows,
        voiceBotRows,
      },
      configQuery.data,
    );
    if (!built.ok) {
      notification.error({ message: built.error });
      return;
    }
    updateMut.mutate(built.patch);
  };

  // The rail's active row comes from the URL, not from the child route: a layout
  // route's `useParams` only sees the params its OWN path declares, and
  // `:category` belongs to the child.
  const [, category, section] = pathname.split('/');
  const categories = visibleCategories(isDesktop);
  const resolved = resolveSettingsRoute({ category, section }, categories);

  const paneContext: SettingsPaneContext = {
    form,
    config: configQuery.data,
    personalities,
    personalitiesLoading: personalitiesQuery.isLoading,
    showAdvanced,
    providerRows,
    addProviderRow,
    updateProviderRow,
    moveProviderRow,
    removeProviderRow,
    quickCommandRows,
    setQuickCommandRows,
    channelToolsetRows,
    setChannelToolsetRows,
    voiceTtsProviderRows,
    setVoiceTtsProviderRows,
    voiceSttProviderRows,
    setVoiceSttProviderRows,
    voiceRealtimeProviderRows,
    setVoiceRealtimeProviderRows,
    retentionRows,
    setRetentionRows,
    voiceBotRows,
    setVoiceBotRows,
  };

  return (
    <div className="settings-tab">
      <header className="settings-toolbar">
        <Typography.Title level={4} style={{ margin: 0 }}>
          Settings
        </Typography.Title>
        <AdvancedToggle showAdvanced={showAdvanced} onChange={setShowAdvanced} />
      </header>

      <div className="settings">
        <CategoryRail
          categories={categories}
          activeCategory={resolved.category}
          dirtyCategories={dirty.categories}
        />
        <div className="settings__detail">
          {/*
            `component={false}` renders NO `<form>` node (D2). Two live defects
            without it: the self-saving sections (named secrets, API keys,
            web-search defaults, A2A, Desktop) now render INSIDE this form, so
            pressing Enter in a name field would submit the page and write ~107
            config keys as a side effect of typing; and `ApiKeysSection` owns a
            modal-local `Form.useForm`, which would nest forms. Save is an
            explicit `form.submit()` from the save bar instead.
          */}
          <Form<FormShape>
            form={form}
            layout="vertical"
            component={false}
            onFinish={onFinish}
            onValuesChange={() => setStoreRevision((r) => r + 1)}
          >
            <Outlet context={paneContext} />
          </Form>
          <SaveBar
            loading={updateMut.isPending}
            onSave={() => form.submit()}
            dirty={dirty}
            categories={categories}
          />
        </div>
      </div>
    </div>
  );
}
