import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button, Space, Spin, Typography } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { blobToBase64 } from '../../components/chat/VoiceButton';
import { useVoiceRecorder } from '../../hooks/useVoiceRecorder';
import { rpc } from '../../rpc';
import { usePersonalityList } from '../personalities/api/queries';
import { SatelliteRow } from './SatelliteRow';
import { satelliteRowView } from './satellite-rows';
import { WakeImplicitRoutes, WakeRouteRow } from './WakeRouteRow';
import {
  emptyWakeRouteDraft,
  implicitWakeRoutes,
  SATELLITES_EMPTY_COPY,
  validateWakeRoutes,
  WAKE_ROUTES_EMPTY_COPY,
  type WakeRouteDraft,
  type WakeRouteWire,
  wakeRouteDraftsFromServer,
  wakeRouteErrorRow,
  wakeRoutesToInput,
  wakeTestMatch,
} from './wake-routes';

// Settings → Voice: the wake-route manager and the satellite fleet (DR4 — no
// new sidebar item; wake lives where the rest of voice lives).
//
// Two halves of one question. The routes are what SHOULD happen when somebody
// speaks; the satellites are what actually can. Keeping them adjacent is the
// point: a route pointing at a personality is worthless if every microphone in
// the house is degraded, and the degraded row says so right underneath.

export const wakeKeys = {
  routes: () => ['voice', 'wakeRoutes'] as const,
  satellites: () => ['voice', 'satellites'] as const,
};

/** Live enough to watch a satellite come up, slow enough that a Settings tab
 *  left open all afternoon is not a load generator. React Query pauses an
 *  interval while the tab is unfocused (`refetchIntervalInBackground` defaults
 *  to false), so a hidden tab polls nothing. */
const SATELLITE_POLL_MS = 5_000;

/** Longest utterance the tester records before it transcribes anyway. A wake
 *  phrase is three words; anything longer is a stuck button. */
const TEST_CAP_MS = 4_000;

// ---------------------------------------------------------------------------
// The live phrase tester (DR2)
// ---------------------------------------------------------------------------

interface WakeTesterProps {
  drafts: readonly WakeRouteDraft[];
  /** The synthesized `hey <name>` defaults — matchable, though not editable. */
  implicit: readonly WakeRouteWire[];
  sensitivity: number;
  onMatch: (key: string | null, transcript: string) => void;
}

/**
 * Speak, and the row that would answer lights up — before saving.
 *
 * The match is decided by `matchWakePhrase` from `@ethosagent/voice-text`, the
 * same function the satellite's transcript wake engine runs. This is the whole
 * reason that function moved out of `extensions/voice-satellite`: a tester
 * with its own copy of the matcher would quietly start disagreeing with the
 * microphone, and "the route is proven, not assumed" would become a lie the UI
 * tells confidently.
 *
 * It matches the EFFECTIVE table — the editor's rows plus the implicit
 * `hey <name>` defaults — because those defaults answer in the room, and a
 * tester that could only prove the configured half would be quietly narrower
 * than the thing it is testing.
 *
 * What it CANNOT prove is stated on the row rather than hidden: this is the
 * browser's microphone and the transcript matcher. A satellite running the
 * acoustic engine spots the phrase before recognition and can hear it
 * differently.
 */
function WakeTester({ drafts, implicit, sensitivity, onMatch }: WakeTesterProps) {
  const { isRecording, error: recorderError, startRecording, stopRecording } = useVoiceRecorder();
  const [state, setState] = useState<'idle' | 'transcribing'>('idle');
  const [heard, setHeard] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const capRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearCap = useCallback(() => {
    if (capRef.current) {
      clearTimeout(capRef.current);
      capRef.current = null;
    }
  }, []);

  useEffect(() => clearCap, [clearCap]);

  const finish = useCallback(async () => {
    clearCap();
    const blob = await stopRecording();
    if (!blob) return;
    setState('transcribing');
    setError(null);
    try {
      const audio = await blobToBase64(blob);
      const result = await rpc.voice.transcribe({ audio, mimeType: blob.type });
      setHeard(result.transcript);
      onMatch(wakeTestMatch(drafts, implicit, result.transcript, sensitivity), result.transcript);
    } catch (err) {
      setHeard(null);
      onMatch(null, '');
      setError(err instanceof Error ? err.message : 'Transcription failed');
    } finally {
      setState('idle');
    }
  }, [clearCap, stopRecording, drafts, implicit, sensitivity, onMatch]);

  const handleClick = useCallback(() => {
    if (state === 'transcribing') return;
    if (isRecording) {
      void finish();
      return;
    }
    setHeard(null);
    setError(null);
    onMatch(null, '');
    void startRecording();
    capRef.current = setTimeout(() => void finish(), TEST_CAP_MS);
  }, [state, isRecording, finish, startRecording, onMatch]);

  const shownError = error ?? recorderError;

  return (
    <Space direction="vertical" size={4} style={{ marginTop: 8 }}>
      <Button
        size="small"
        danger={isRecording}
        loading={state === 'transcribing'}
        onClick={handleClick}
      >
        {isRecording ? 'Stop & match' : state === 'transcribing' ? 'Matching…' : 'Say a phrase'}
      </Button>
      {shownError ? (
        <Typography.Text type="danger">{shownError}</Typography.Text>
      ) : isRecording ? (
        <Typography.Text type="secondary">Listening… tap to stop (4s max).</Typography.Text>
      ) : heard ? (
        <Typography.Text type="secondary">
          Heard <span className="wake-route-mono">“{heard}”</span>.
        </Typography.Text>
      ) : (
        <Typography.Text type="secondary">
          Speak a phrase and the route it wakes lights up — before you save. Matched here with this
          browser’s microphone and the transcript matcher; a satellite running the acoustic engine
          spots the phrase before recognition and can hear it differently.
        </Typography.Text>
      )}
    </Space>
  );
}

// ---------------------------------------------------------------------------

export function WakePanel() {
  const qc = useQueryClient();
  const [drafts, setDrafts] = useState<WakeRouteDraft[] | null>(null);
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);
  const [matchedKey, setMatchedKey] = useState<string | null>(null);

  const routesQuery = useQuery({
    queryKey: wakeKeys.routes(),
    queryFn: () => rpc.voice.wakeRoutes.get(),
  });
  const satellitesQuery = useQuery({
    queryKey: wakeKeys.satellites(),
    queryFn: () => rpc.voice.satellites.list(),
    refetchInterval: SATELLITE_POLL_MS,
  });
  const personalitiesQuery = usePersonalityList();

  // Hydrate ONCE. React Query refetches on window focus, and re-seeding the
  // editor from the server on every alt-tab would silently discard whatever
  // the operator had half-typed. After a save the mutation seeds the drafts
  // from its own response, which is the only other time the table is
  // authoritative.
  const hydrated = useRef(false);
  const serverRoutes = routesQuery.data?.routes;
  useEffect(() => {
    if (serverRoutes && !hydrated.current) {
      hydrated.current = true;
      setDrafts(wakeRouteDraftsFromServer(serverRoutes));
    }
  }, [serverRoutes]);

  const saveMutation = useMutation({
    mutationFn: (rows: WakeRouteDraft[]) =>
      rpc.voice.wakeRoutes.set({ routes: wakeRoutesToInput(rows) }),
    onSuccess: (data) => {
      setRowErrors({});
      setSaveError(null);
      setDrafts(wakeRouteDraftsFromServer(data.routes));
      void qc.invalidateQueries({ queryKey: wakeKeys.routes() });
      void qc.invalidateQueries({ queryKey: wakeKeys.satellites() });
    },
    onError: (err, rows) => {
      const message = err instanceof Error ? err.message : 'Saving the wake routes failed.';
      const attributed = wakeRouteErrorRow(message, rows);
      // Inline on the row that caused it. A ten-row table plus a toast that
      // says "unknown personality" is a scavenger hunt.
      setRowErrors(attributed ? { [attributed.key]: attributed.message } : {});
      setSaveError(attributed ? null : message);
    },
  });

  const wakeToggle = useMutation({
    mutationFn: (args: { nodeId: string; enabled: boolean }) =>
      rpc.voice.satellites.setWakeEnabled(args),
    onSettled: () => void qc.invalidateQueries({ queryKey: wakeKeys.satellites() }),
  });

  const rows = drafts ?? [];
  const settings = routesQuery.data?.settings;
  // Not editable and not saved back — the server derives them from the
  // personality registry. Shown so "every personality answers to 'hey <name>'"
  // is something the operator can read off the page rather than take on trust,
  // and handed to the tester so speaking one of them lights it up. Memoized
  // because the tester closes over it.
  const implicit = useMemo(() => implicitWakeRoutes(serverRoutes ?? []), [serverRoutes]);

  const patchRow = (key: string, patch: Partial<WakeRouteDraft>) => {
    setDrafts((prev) => (prev ?? []).map((d) => (d.key === key ? { ...d, ...patch } : d)));
    setRowErrors(({ [key]: _dropped, ...rest }) => rest);
    setMatchedKey(null);
  };

  const handleSave = () => {
    const local = validateWakeRoutes(rows);
    if (Object.keys(local).length > 0) {
      setRowErrors(local);
      setSaveError(null);
      return;
    }
    saveMutation.mutate(rows);
  };

  const saving = saveMutation.isPending;

  return (
    <>
      {routesQuery.isLoading ? (
        <div style={{ display: 'grid', placeItems: 'center', height: 60 }}>
          <Spin />
        </div>
      ) : routesQuery.error ? (
        // Never the empty state on a failed read: "no routes yet" and "we
        // could not read the routes" are different facts, and conflating them
        // invites the operator to re-add routes that already exist.
        <Typography.Text type="danger">
          Wake routes unreadable — {(routesQuery.error as Error).message}
        </Typography.Text>
      ) : rows.length === 0 ? (
        <Typography.Text type="secondary">{WAKE_ROUTES_EMPTY_COPY}</Typography.Text>
      ) : (
        <div className="wake-route-list">
          {rows.map((draft) => (
            <WakeRouteRow
              key={draft.key}
              draft={draft}
              personalities={personalitiesQuery.data?.items ?? []}
              matched={matchedKey === draft.key}
              error={rowErrors[draft.key] ?? null}
              disabled={saving}
              onChange={(patch) => patchRow(draft.key, patch)}
              onDelete={() => {
                setDrafts((prev) => (prev ?? []).filter((d) => d.key !== draft.key));
                setMatchedKey(null);
              }}
            />
          ))}
        </div>
      )}

      <WakeImplicitRoutes routes={implicit} matchedKey={matchedKey} />

      {saveError ? (
        <Typography.Text type="danger" className="wake-route-note">
          {saveError}
        </Typography.Text>
      ) : null}

      <Space size="small" style={{ marginTop: 8 }}>
        <Button
          size="small"
          disabled={saving}
          onClick={() => setDrafts([...(drafts ?? []), emptyWakeRouteDraft()])}
        >
          Add phrase
        </Button>
        <Button size="small" type="primary" loading={saving} onClick={handleSave}>
          Save routes
        </Button>
      </Space>

      <WakeTester
        drafts={rows}
        implicit={implicit}
        sensitivity={settings?.sensitivity ?? 0.5}
        onMatch={(key) => setMatchedKey(key)}
      />

      <div className="wake-satellites">
        {satellitesQuery.isLoading ? (
          <div style={{ display: 'grid', placeItems: 'center', height: 60 }}>
            <Spin />
          </div>
        ) : satellitesQuery.error ? (
          <Typography.Text type="danger">
            Satellite roster unreadable — {(satellitesQuery.error as Error).message}
          </Typography.Text>
        ) : (satellitesQuery.data?.nodes.length ?? 0) === 0 ? (
          <Typography.Text type="secondary">{SATELLITES_EMPTY_COPY}</Typography.Text>
        ) : (
          (satellitesQuery.data?.nodes ?? []).map((node) => (
            <SatelliteRow
              key={node.nodeId}
              node={node}
              view={satelliteRowView(node)}
              now={Date.now()}
              busy={wakeToggle.isPending && wakeToggle.variables?.nodeId === node.nodeId}
              onToggleWake={(enabled) => wakeToggle.mutate({ nodeId: node.nodeId, enabled })}
            />
          ))
        )}
      </div>
    </>
  );
}

/**
 * The deployment-wide satellite knobs, read-only.
 *
 * They are readable through `voice.wakeRoutes.get` and NOT writable through
 * any RPC this app has: `config.update` carries no `voice.wake.*` field. So
 * the panel shows what the routes will actually run under and names the yaml
 * key for each, rather than rendering a switch that silently does nothing —
 * an editable-looking control with no write path is worse than an honest
 * read-out.
 */
export function WakeSettingsReadout() {
  const routesQuery = useQuery({
    queryKey: wakeKeys.routes(),
    queryFn: () => rpc.voice.wakeRoutes.get(),
  });
  const s = routesQuery.data?.settings;
  if (!s) return null;

  const facts: Array<[string, string, string]> = [
    ['Wake listening', s.wakeEnabled ? 'on' : 'off', 'voice.wake.enabled'],
    ['Engine', s.engine, 'voice.wake.engine'],
    ['Sensitivity', String(s.sensitivity), 'voice.wake.sensitivity'],
    ['Confirmation frames', String(s.confirmationFrames), 'voice.wake.confirmationFrames'],
    ['Edge STT', s.edgeStt ? 'on' : 'off', 'voice.wake.edgeStt'],
    ['Idle timeout', `${Math.round(s.idleTimeoutMs / 1000)}s`, 'voice.wake.idleTimeout'],
  ];

  return (
    <>
      <Typography.Paragraph type="secondary" style={{ marginTop: 0, fontSize: 13 }}>
        What the satellites are running under. Edit these in <code>~/.ethos/config.yaml</code> —
        they take effect on the next satellite reconnect or gateway restart. The idle timeout ends
        listening only; it never ends the session.
      </Typography.Paragraph>
      <div className="wake-settings-readout">
        {facts.map(([label, value, key]) => (
          <div className="wake-settings-fact" key={key}>
            <span className="wake-settings-label">{label}</span>
            <span className="wake-route-mono">{value}</span>
            <span className="wake-route-mono wake-settings-key">{key}</span>
          </div>
        ))}
      </div>
    </>
  );
}
