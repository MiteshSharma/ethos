// The layout primitives the panes share. Moved verbatim out of
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

export function RowLabel({ children }: { children: ReactNode }) {
  return (
    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
      {children}
    </Typography.Text>
  );
}
