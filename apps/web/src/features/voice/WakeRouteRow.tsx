import { personalityAccent } from '@ethosagent/design-tokens';
import { Button, Input, Select, Switch, Tooltip, Typography } from 'antd';
import type { CSSProperties } from 'react';
import { PersonalityMark } from '../../components/ui/PersonalityMark';
import type { WakeRouteDraft, WakeRouteWire } from './wake-routes';

// WakeRouteRow (DR3) — one phrase → personality mapping.
//
// A ROW, not a Card. "Cards earn existence" reserves the primitive for skill
// rows, cron rows and task tiles; a route is four fields and a delete, and a
// bordered box per route would turn a routing table into a gallery.
//
// The phrase is Geist Mono because it is a literal — the operator says exactly
// these words at a microphone, and a proportional font that renders `l` and
// `I` alike is the wrong typeface for a string you have to pronounce.

export interface WakeRouteRowProps {
  draft: WakeRouteDraft;
  personalities: ReadonlyArray<{ id: string; name: string; avatarUrl?: string }>;
  /** The phrase tester heard this row. Lights up in the personality's accent. */
  matched: boolean;
  /** Server rejection attributed to this row, or a local validation failure. */
  error: string | null;
  disabled: boolean;
  onChange: (patch: Partial<WakeRouteDraft>) => void;
  onDelete: () => void;
}

/**
 * The privileged opt-in has to explain itself, because it is the only access
 * control the wake surface has.
 *
 * A wake phrase is not a password: everyone in the room can say it, the
 * satellite cannot tell who did, and speaker-ID is an explicit follow-up that
 * does not exist yet. So the switch does not say "privileged" and leave the
 * operator to infer the consequence — it says who can pull the trigger.
 */
const PRIVILEGED_EXPLAINER =
  'Off, a privileged personality answers no phrase at all. On, anyone within earshot of the satellite can wake it and run everything it can run — the satellite cannot tell who spoke. Until speaker verification exists, this switch is the whole access control on the wake surface.';

export function WakeRouteRow({
  draft,
  personalities,
  matched,
  error,
  disabled,
  onChange,
  onDelete,
}: WakeRouteRowProps) {
  const accent = draft.personalityId ? personalityAccent(draft.personalityId) : undefined;
  const style = (accent ? { '--accent': accent } : {}) as CSSProperties;

  return (
    <div
      className={`wake-route-row${matched ? ' wake-route-row--matched' : ''}${
        error ? ' wake-route-row--error' : ''
      }`}
      style={style}
    >
      <div className="wake-route-main">
        <Input
          className="wake-route-phrase"
          value={draft.phrase}
          disabled={disabled}
          placeholder="swing trader"
          aria-label="Wake phrase"
          onChange={(e) => onChange({ phrase: e.target.value })}
        />
        <span className="wake-route-arrow" aria-hidden="true">
          →
        </span>
        {draft.personalityId ? (
          <PersonalityMark
            personalityId={draft.personalityId}
            size={20}
            avatarUrl={personalities.find((p) => p.id === draft.personalityId)?.avatarUrl}
          />
        ) : (
          <span className="wake-route-mark-slot" aria-hidden="true" />
        )}
        <Select
          className="wake-route-personality"
          value={draft.personalityId || undefined}
          disabled={disabled}
          placeholder="Personality"
          aria-label="Personality this phrase wakes"
          onChange={(value: string) => onChange({ personalityId: value })}
          options={personalities.map((p) => ({ value: p.id, label: p.name }))}
        />
        <Tooltip title={PRIVILEGED_EXPLAINER}>
          <span className="wake-route-flag">
            <Switch
              size="small"
              checked={draft.privileged}
              disabled={disabled}
              aria-label="Reachable by anyone within earshot"
              onChange={(checked) => onChange({ privileged: checked })}
            />
            <span className="wake-route-flag-label">anyone in earshot</span>
          </span>
        </Tooltip>
        <Tooltip title="A disabled route stays in the table and wakes nothing.">
          <span className="wake-route-flag">
            <Switch
              size="small"
              checked={draft.enabled}
              disabled={disabled}
              aria-label="Route enabled"
              onChange={(checked) => onChange({ enabled: checked })}
            />
            <span className="wake-route-flag-label">enabled</span>
          </span>
        </Tooltip>
        <Button size="small" type="text" danger disabled={disabled} onClick={onDelete}>
          Delete
        </Button>
      </div>
      {draft.privileged ? (
        <Typography.Text type="warning" className="wake-route-note">
          Anyone within earshot can wake this personality.
        </Typography.Text>
      ) : null}
      {error ? (
        <Typography.Text type="danger" className="wake-route-note">
          {error}
        </Typography.Text>
      ) : null}
    </div>
  );
}

export interface WakeImplicitRoutesProps {
  /** The synthesized bare-name routes, straight off the read. */
  routes: readonly WakeRouteWire[];
  /** The tester's matched key — a synthesized route's key is its wire id. */
  matchedKey: string | null;
  /** Same lookup `WakeRouteRow` uses for its mark's avatar override. Optional
   *  — omitted (or an id with no match) falls back to the generated mark. */
  personalities?: ReadonlyArray<{ id: string; avatarUrl?: string }>;
}

/**
 * The other half of the effective table: the bare-name defaults, read-only.
 *
 * Not editable, so not rows — a secondary line under the editor, which is what
 * a fact you cannot act on deserves. But it IS matchable, so each default has
 * to be able to light up: speaking "researcher" wakes the researcher in the
 * room whether or not anyone configured it, and a tester that stayed dark for
 * the phrase that actually works proves less than the system does.
 *
 * The lit treatment is `WakeRouteRow`'s, scaled down — the same accent ring in
 * the personality's OWN colour, on an element that already carries that
 * personality's mark. A second highlight vocabulary for "matched, but read
 * only" would make the operator learn two things where the system does one.
 * The mark is drawn always, not only when matched, for the same reason the
 * editable row reserves its mark slot: nothing moves at the moment of proof.
 */
export function WakeImplicitRoutes({ routes, matchedKey, personalities }: WakeImplicitRoutesProps) {
  if (routes.length === 0) return null;
  return (
    <Typography.Paragraph type="secondary" className="wake-route-note">
      Also answering, without any config —{' '}
      <span className="wake-implicit-list">
        {routes.map((route) => (
          <span
            key={route.id}
            className={`wake-implicit-route${
              matchedKey === route.id ? ' wake-implicit-route--matched' : ''
            }`}
            style={{ '--accent': personalityAccent(route.personalityId) } as CSSProperties}
          >
            <PersonalityMark
              personalityId={route.personalityId}
              size={14}
              avatarUrl={personalities?.find((p) => p.id === route.personalityId)?.avatarUrl}
            />
            <span className="wake-route-mono">“{route.phrase}”</span>
          </span>
        ))}
      </span>
      Privileged personalities are left off this list; give one a route above to reach it by voice.
    </Typography.Paragraph>
  );
}
