export const apiKeyKeys = {
  all: () => ['apiKeys'] as const,
};

export const toolCatalogKeys = {
  all: () => ['tools'] as const,
  catalog: () => [...toolCatalogKeys.all(), 'catalog'] as const,
};

// Phase 2 — global named secrets + per-personality tool settings.
export const namedSecretKeys = {
  all: () => ['namedSecrets'] as const,
};

export const toolSettingsKeys = {
  all: () => ['toolSettings'] as const,
  schemas: () => [...toolSettingsKeys.all(), 'schemas'] as const,
  default: () => [...toolSettingsKeys.all(), 'default'] as const,
  forPersonality: (id: string) => [...toolSettingsKeys.all(), 'personality', id] as const,
};

// The Keys pane — the whole secrets vault, by category (`rpc.keys.*`).
// Distinct from `apiKeyKeys` above, which is the external-Mission-Control
// bearer-token store, and from `namedSecretKeys`, which is the web_search
// picker's own slice of the same vault.
export const vaultKeyKeys = {
  all: () => ['keys'] as const,
};
