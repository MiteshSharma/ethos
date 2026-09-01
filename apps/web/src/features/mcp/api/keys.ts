export const mcpKeys = {
  all: () => ['mcp'] as const,
  list: () => [...mcpKeys.all(), 'list'] as const,
  catalog: () => [...mcpKeys.all(), 'catalog'] as const,
  personalityServers: (personalityId: string) =>
    [...mcpKeys.all(), 'personalityServers', personalityId] as const,
};
