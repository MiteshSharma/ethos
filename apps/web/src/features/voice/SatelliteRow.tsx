import { Switch, Tooltip, Typography } from 'antd';
import { PersonalityMark } from '../../components/ui/PersonalityMark';
import {
  type SatelliteNode,
  type SatelliteRowView,
  satelliteCapabilityLabel,
  wakeAge,
} from './satellite-rows';

// SatelliteRow (DR3) — one connected microphone, and the truth about it.
//
// A ROW, not a Card, for the same reason WakeRouteRow is: a fleet of
// microphones is a list to scan, and the thing being scanned for is the one
// that is not green.
//
// Everything mono here — the state word, the node id, the capabilities, the
// last-heard phrase, the age — is a literal the operator will also see in
// `ethos listen doctor` output or in `config.yaml`. Same string, same
// typeface.

export interface SatelliteRowProps {
  node: SatelliteNode;
  view: SatelliteRowView;
  /** Passed in rather than read from the clock so the row stays pure. */
  now: number;
  busy: boolean;
  onToggleWake: (enabled: boolean) => void;
}

/** Three bars, animated by CSS. Deliberately NOT a meter: the node protocol
 *  carries no amplitude, and drawing levels we do not have would be the
 *  dishonest version of "the mic is armed". */
function LivenessBars() {
  return (
    <span className="sat-bars" aria-hidden="true">
      <span className="sat-bar" />
      <span className="sat-bar" />
      <span className="sat-bar" />
    </span>
  );
}

export function SatelliteRow({ node, view, now, busy, onToggleWake }: SatelliteRowProps) {
  return (
    <div className="sat-row">
      <div className="sat-row-main">
        <span
          className={`sb-dot ${view.dotClass}${view.pulse ? ' sb-dot--pulse' : ''}`}
          aria-hidden="true"
        />
        <span className="sat-name">{node.displayName ?? node.nodeId}</span>
        <span className="sat-mono sat-state">{view.label}</span>
        {view.bars ? <LivenessBars /> : null}
        <span className="sat-mono sat-caps">{satelliteCapabilityLabel(node)}</span>
        <Tooltip
          title={
            node.wakeEnabled
              ? 'Stop this node listening for wake phrases. It remembers across restarts.'
              : 'Listen for wake phrases again. It remembers across restarts.'
          }
        >
          <span className="sat-wake-toggle">
            <Switch
              size="small"
              checked={node.wakeEnabled}
              loading={busy}
              aria-label={`Wake listening on ${node.displayName ?? node.nodeId}`}
              onChange={onToggleWake}
            />
            <span className="sat-mono sat-wake-label">wake</span>
          </span>
        </Tooltip>
      </div>

      {node.lastWake ? (
        <div className="sat-row-wake">
          <span className="sat-mono sat-wake-phrase">“{node.lastWake.phrase}”</span>
          <span className="sat-row-arrow" aria-hidden="true">
            →
          </span>
          <PersonalityMark personalityId={node.lastWake.personalityId} size={16} />
          <span className="sat-mono">{node.lastWake.personalityId}</span>
          <span className="sat-mono sat-wake-age" title={new Date(node.lastWake.at).toISOString()}>
            {wakeAge(node.lastWake.at, now)}
          </span>
        </div>
      ) : (
        <div className="sat-row-wake">
          <span className="sat-mono sat-wake-none">no wake yet</span>
        </div>
      )}

      {view.detail ? (
        <Typography.Text type="danger" className="sat-row-detail sat-mono">
          {view.detail}
        </Typography.Text>
      ) : null}
      {view.consequence ? (
        <Typography.Text type="secondary" className="sat-row-detail">
          {view.consequence}
        </Typography.Text>
      ) : null}
    </div>
  );
}
