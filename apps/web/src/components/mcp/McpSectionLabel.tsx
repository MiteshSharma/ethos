import type React from 'react';

// Relocated out of `apps/web/src/pages/Mcp.tsx` (plan/phases/mcp-inline-catalog.md
// §2.1) so `McpCatalogSection` can render the identical section-header style
// `WorkspaceMcpPanel` already uses for "Attached"/"Installed, not attached",
// rather than a visually-similar reimplementation.
export function McpSectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 500,
        color: 'var(--text-tertiary)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        margin: '20px 0 10px',
      }}
    >
      {children}
    </div>
  );
}
