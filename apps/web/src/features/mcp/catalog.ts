import type { McpAddServerInput, McpRemotePresetInfo } from '@ethosagent/web-contracts';

// Pure logic shared by `AddMcpModal`'s "Preset" mode and `McpCatalogSection`
// (plan/phases/mcp-inline-catalog.md) — relocated out of `AddMcpModal.tsx`
// (where it originally lived and was exported) so a second consumer doesn't
// have to import a component file for its logic. No JSX, no DOM — matches
// the convention of `apps/web/src/lib/attachmentLists.ts`.

/** Auth badge copy for a remote catalog entry. */
export function authBadgeLabel(authType: McpRemotePresetInfo['authType']): string {
  if (authType === 'oauth') return 'OAuth';
  if (authType === 'none') return 'No auth';
  return 'API key';
}

/** Bucket catalog entries by `category`, preserving the order the server sent. */
export function groupByCategory<T extends { category: string }>(
  items: readonly T[],
): { category: string; items: T[] }[] {
  const groups: { category: string; items: T[] }[] = [];
  for (const item of items) {
    const existing = groups.find((g) => g.category === item.category);
    if (existing) existing.items.push(item);
    else groups.push({ category: item.category, items: [item] });
  }
  return groups;
}

/** What a remote catalog entry submits, decided by its `authType`. */
export function buildRemoteSubmission(
  preset: McpRemotePresetInfo,
  token: string,
):
  | { kind: 'oauth'; input: { url: string } }
  | { kind: 'addServer'; input: Extract<McpAddServerInput, { transport: 'streamable-http' }> } {
  if (preset.authType === 'oauth') {
    return { kind: 'oauth', input: { url: preset.url } };
  }
  if (preset.authType === 'none') {
    return {
      kind: 'addServer',
      input: {
        name: preset.name,
        url: preset.url,
        transport: 'streamable-http',
        authType: 'none',
      },
    };
  }
  const trimmed = token.trim();
  return {
    kind: 'addServer',
    input: {
      name: preset.name,
      url: preset.url,
      transport: 'streamable-http',
      authType: 'bearer',
      ...(trimmed ? { token: trimmed } : {}),
    },
  };
}
