import type { AlertCardPayload } from '@ethosagent/web-contracts';
import type { CardBlockProps } from '../registry';
import { UnknownCardBlock } from './UnknownCardBlock';

// Severity reads two ways: the glyph and the color. DESIGN.md's semantic
// colors are never allowed to carry meaning alone, so the icon shape is the
// primary signal and the color is the scan aid — which is also what keeps the
// card legible to a red/green-colorblind reader.

type Severity = AlertCardPayload['severity'];

const ICON_PATHS: Record<Severity, string> = {
  // circle + "i" stem
  info: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M8 7v4.5M8 4.75v.5',
  // circle + check
  success: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M5.25 8.25l1.9 1.9 3.6-3.9',
  // triangle + "!" stem
  warning: 'M8 1.75 1.25 13.5h13.5zM8 6v3.5M8 11.25v.5',
  // circle + cross
  error: 'M8 1.5a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13M6 6l4 4M10 6l-4 4',
};

const LABELS: Record<Severity, string> = {
  info: 'Info',
  success: 'Success',
  warning: 'Warning',
  error: 'Error',
};

export function AlertCardBlock({ card }: CardBlockProps) {
  if (card.kind !== 'alert') return <UnknownCardBlock card={card} />;
  const { severity, title, message } = card.payload;
  return (
    <div className={`card-block card-alert card-alert-${severity}`} role="note">
      <svg
        className="card-alert-icon"
        width="16"
        height="16"
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        role="img"
        aria-label={LABELS[severity]}
      >
        <path d={ICON_PATHS[severity]} />
      </svg>
      <div className="card-alert-body">
        {title ? <div className="card-alert-title">{title}</div> : null}
        <div className="card-alert-message">{message}</div>
      </div>
    </div>
  );
}
