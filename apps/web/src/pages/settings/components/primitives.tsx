// The three layout primitives the panes share. Moved verbatim out of
// `Settings.tsx` (Phase 1); none of them is a `Card` (DESIGN.md:134).

import { Typography } from 'antd';
import type { CSSProperties, ReactNode } from 'react';

/** Same bordered-box style the provider-chain rows use. */
export const ROW_BOX_STYLE: CSSProperties = {
  border: '1px solid var(--ethos-border, #d9d9d9)',
  borderRadius: 6,
  padding: 12,
  marginBottom: 12,
};

/**
 * A section label inside an existing card — DESIGN.md "micro / section labels":
 * 11px / 500 / uppercase / 0.08em. Used to split the Voice card into its
 * Speech-to-text and Text-to-speech halves WITHOUT minting a second Card
 * (cards earn existence; a heading is enough to separate two halves of one
 * subject).
 */
export function VoiceSectionLabel({ children }: { children: ReactNode }) {
  return (
    <Typography.Paragraph
      style={{
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        opacity: 0.6,
        marginTop: 24,
        marginBottom: 12,
      }}
    >
      {children}
    </Typography.Paragraph>
  );
}

export function RowLabel({ children }: { children: ReactNode }) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {children}
    </Typography.Text>
  );
}
