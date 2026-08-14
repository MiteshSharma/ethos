// @ethosagent/types — zero-dep interface contract layer
// All packages import from here. No runtime code.

export * from './a2a';
export * from './agent-event';
export * from './background-job';
export * from './channel-conformance';
export * from './clarify';
export * from './command';
export * from './constitution';
export * from './context-engine';
export * from './diagnostics';
export * from './document-extractor';
export * from './errors';
export * from './evaluator';
export * from './execution';
export * from './goal';
export * from './hooks';
export * from './id-validation';
export * from './injector';
export * from './llm';
export * from './logger';
export * from './mcp';
export * from './memory';
export * from './model-catalog';
export * from './monitor';
export * from './notification-router';
export * from './oauth';
export * from './observability';
export * from './personality';
export * from './platform';
export * from './plugin';
export * from './plugin-llm';
export * from './plugin-panel';
export * from './plugin-ui';
export * from './retention';
export * from './safety';
export * from './sandbox';
export {
  isValidSecretName,
  SECRET_NAME_RE,
  SecretNotFoundError,
  type SecretRef,
  type SecretsResolver,
} from './secrets';
export * from './session';
export * from './skill';
export * from './steer';
export * from './storage';
export * from './team';
export * from './todo';
export * from './tool';
export * from './tool-capabilities';
export * from './tool-filter';
export type {
  ToolReducerContext,
  ToolResultReducer,
  ToolResultReducerRegistry,
} from './tool-reducer';
export * from './vision-limits';
export * from './voice';
export * from './voice-realtime';

// Phase 5 — Personality export/import portable bundles
export interface ExportStamp {
  publisher: 'ethos';
  exportedBy: 'ethos-personality-export';
  bundleSha256: string;
  stamp: string;
}

export interface BundleManifest {
  schema: 'ethos.personality-bundle/v1';
  personalityId: string;
  version: string;
  publisher: 'ethos';
  createdAt: string;
  declared: {
    /** `workdir` is optional so bundles exported before it existed still
     *  validate. It is disclosed alongside read/write because a declared
     *  workdir is injected into BOTH derived reach lists — omitting it
     *  understates the filesystem reach the importer is being asked to grant. */
    fsReach: { read: string[]; write: string[]; workdir?: string };
    toolset: string[];
    budgetCapUsd?: number;
  };
  mcpServers: Array<{
    name: string;
    url: string;
    transport: string;
    authType?: 'none' | 'oauth2' | 'bearer';
    tools: string[];
  }>;
  plugins: Array<{
    id: string;
    version: string;
    source: string;
    tools: string[];
    skills: string[];
    credentials?: string[];
  }>;
  memory?: { included: 'MEMORY.md'[] };
  files: Array<{ relPath: string; sha256: string }>;
  bundleSha256: string;
  export: ExportStamp;
}
