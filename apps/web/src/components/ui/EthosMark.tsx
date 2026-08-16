// The Ethos annulus — marks the machine altitude (the Library), never any
// single agent. Same geometry as `apps/desktop/assets/brand/ethos-mark.svg`,
// inlined rather than imported: that file lives outside apps/web's Vite
// root, and no reusable component wrapped it anywhere in the codebase before
// this. Agents get generative marks (`PersonalityMark`); Ethos gets the ring.
// See DESIGN.md "Altitude convention".

export interface EthosMarkProps {
  /** Pixel size of the square mark. Default 24. */
  size?: number;
  /** Stroke/fill color. Defaults to `currentColor` so the rail's neutral
   *  `--ethos-info` (or any ancestor color) drives it without a prop. */
  color?: string;
}

export function EthosMark({ size = 24, color = 'currentColor' }: EthosMarkProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      role="img"
      aria-label="Ethos"
      style={{ flexShrink: 0, display: 'block' }}
    >
      <path
        fill={color}
        fillRule="evenodd"
        d="M256 26 A230 230 0 1 1 256 486 A230 230 0 1 1 256 26 Z
           M256 154 A102 102 0 1 0 256 358 A102 102 0 1 0 256 154 Z"
      />
    </svg>
  );
}
