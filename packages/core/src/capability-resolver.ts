import type { NetworkPolicy } from '@ethosagent/safety-network';
import type {
  KeyValueStore,
  SecretRef,
  Storage,
  ToolCapabilities,
  ToolContext,
} from '@ethosagent/types';
import { ScopedAttachmentsImpl } from './scoped/scoped-attachments';
import { type SafeFetchFn, ScopedFetchImpl } from './scoped/scoped-fetch';
import { ScopedFsImpl } from './scoped/scoped-fs';
import { ScopedProcessImpl } from './scoped/scoped-process';
import { ScopedSecretsImpl } from './scoped/scoped-secrets';

export interface CapabilityBackends {
  kvStoreFactory?: (tool: string, scopeId: string) => KeyValueStore;
  secretsBackend?: (ref: SecretRef) => Promise<string>;
  storage?: Storage;
  /**
   * Resolves the personality fs_reach allowlist behind every
   * `from-personality` capability. A RESOLVER, not a stored `{read,write}`:
   * a stored value froze the boundary at process start, so editing a
   * personality's `fs_reach` on disk kept failing in the file tools until
   * `ethos serve` was restarted, even though the character sheet and the
   * Documents root had already picked the edit up. It is called per tool
   * execution with the personality id of that call, so a mid-session
   * `/personality` switch resolves the new personality's reach too.
   *
   * An unknown or absent id must degrade to deny-all (`{read:[],write:[]}`),
   * never to a wider set.
   */
  personalityFsReach?: (personalityId?: string) => { read: string[]; write: string[] };
  /**
   * Resolves the full network policy of the personality running the turn. The
   * `allow` list is intersected with each tool's declared `allowedHosts`;
   * `deny` and `allow_private_urls` plus the always-on safety floor
   * (cloud-metadata, private-network, scheme, DNS-rebinding) flow through
   * `safeFetch`.
   *
   * A RESOLVER, not a stored `NetworkPolicy`, for the same two reasons
   * `personalityFsReach` above is one. A stored value was captured once at
   * wiring time from the ACTIVE personality, so (a) every other personality in
   * the process ran on the default's policy — a `safety.network.allow` set on a
   * non-default personality was never read at all, and every `['*']`-declaring
   * tool resolved to an empty host set and answered `HOST_NOT_ALLOWED` — and
   * (b) editing the policy on disk did nothing until the process was rebuilt.
   * It is called per tool execution with the personality id of that call, so a
   * mid-session `/personality` switch resolves the new personality's policy.
   */
  personalityNetworkPolicy?: (personalityId?: string) => NetworkPolicy;
  /** Injected safeFetch function for network policy enforcement. */
  safeFetch?: SafeFetchFn;
  /** Always-deny path list for filesystem scoping. */
  alwaysDenyPaths?: string[];
  attachmentCache?: import('@ethosagent/types').AttachmentCache;
  inboundAttachments?: import('@ethosagent/types').Attachment[];
}

type ResolvedFields = Partial<
  Pick<
    ToolContext,
    'kvStore' | 'secretsResolver' | 'scopedFetch' | 'scopedFs' | 'scopedProcess' | 'attachments'
  >
>;

export interface CapabilityScopeIds {
  sessionId: string;
  personalityId?: string;
}

export function resolveCapabilities(
  toolName: string,
  capabilities: ToolCapabilities | undefined,
  scopeIds: CapabilityScopeIds,
  backends: CapabilityBackends,
): ResolvedFields {
  if (!capabilities) return {};

  const result: ResolvedFields = {};

  // Resolved once per tool execution (the attachments branch re-reads it),
  // never once per process — see the CapabilityBackends field doc.
  let reachCache: { read: string[]; write: string[] } | null = null;
  const personalityReach = (): { read: string[]; write: string[] } => {
    reachCache ??= backends.personalityFsReach?.(scopeIds.personalityId) ?? { read: [], write: [] };
    return reachCache;
  };

  if (capabilities.network) {
    const declaredHosts = capabilities.network.allowedHosts;
    const policy = backends.personalityNetworkPolicy?.(scopeIds.personalityId) ?? {};
    const personalityAllow = policy.allow;
    let resolvedHosts: Set<string>;
    if (declaredHosts.includes('*')) {
      resolvedHosts = new Set(personalityAllow ?? []);
    } else if (personalityAllow) {
      // Intersect: only keep declared hosts covered by a personality pattern
      resolvedHosts = new Set(
        declaredHosts.filter((host) =>
          personalityAllow.some((pattern) => {
            if (pattern === host || pattern === '*') return true;
            if (pattern.startsWith('*.')) {
              const suffix = pattern.slice(1);
              return host.endsWith(suffix) && host.length > suffix.length;
            }
            return false;
          }),
        ),
      );
    } else {
      resolvedHosts = new Set(declaredHosts);
    }
    if (backends.safeFetch) {
      result.scopedFetch = new ScopedFetchImpl(resolvedHosts, policy, backends.safeFetch);
    }
  }

  if (capabilities.secrets && backends.secretsBackend) {
    result.secretsResolver = new ScopedSecretsImpl(
      new Set(capabilities.secrets),
      backends.secretsBackend,
    );
  }

  if (capabilities.storage && backends.kvStoreFactory) {
    const scope = capabilities.storage.scope;
    let resolvedScopeId: string;
    if (scope === 'tool-private') {
      resolvedScopeId = `tool:${toolName}`;
    } else if (scope === 'session') {
      resolvedScopeId = `session:${scopeIds.sessionId}`;
    } else {
      resolvedScopeId = `personality:${scopeIds.personalityId ?? scopeIds.sessionId}`;
    }
    result.kvStore = backends.kvStoreFactory(toolName, resolvedScopeId);
  }

  if (capabilities.fs_reach && backends.storage) {
    const readDecl = capabilities.fs_reach.read;
    const writeDecl = capabilities.fs_reach.write;
    const readPaths = readDecl === 'from-personality' ? personalityReach().read : (readDecl ?? []);
    const writePaths =
      writeDecl === 'from-personality' ? personalityReach().write : (writeDecl ?? []);
    result.scopedFs = new ScopedFsImpl(
      backends.storage,
      new Set(readPaths),
      new Set(writePaths),
      backends.alwaysDenyPaths ?? [],
    );
  }

  if (capabilities.process) {
    result.scopedProcess = new ScopedProcessImpl(new Set(capabilities.process.allowedBinaries));
  }

  if (capabilities.attachments && backends.attachmentCache && backends.inboundAttachments) {
    result.attachments = new ScopedAttachmentsImpl(
      backends.inboundAttachments,
      capabilities.attachments.kinds,
      backends.attachmentCache,
    );

    // Per-turn reach extension: merge attachment cache directories into
    // ScopedFs read paths so tools using file_path (back-compat) can read
    // cached attachment files through the normal ScopedFs path.
    const attachmentDirs = new Set<string>();
    for (const att of backends.inboundAttachments) {
      if (att.url.startsWith('file://')) {
        const localPath = backends.attachmentCache.resolveLocalPath(att.url);
        const dir = localPath.slice(0, localPath.lastIndexOf('/'));
        if (dir) attachmentDirs.add(dir);
      }
    }

    if (attachmentDirs.size > 0) {
      if (result.scopedFs && backends.storage) {
        // Reconstruct with merged read paths
        const readDecl = capabilities.fs_reach?.read;
        const readPaths =
          readDecl === 'from-personality' ? personalityReach().read : (readDecl ?? []);
        const writeDecl = capabilities.fs_reach?.write;
        const writePaths =
          writeDecl === 'from-personality' ? personalityReach().write : (writeDecl ?? []);
        const mergedRead = new Set([...readPaths, ...attachmentDirs]);
        result.scopedFs = new ScopedFsImpl(
          backends.storage,
          mergedRead,
          new Set(writePaths),
          backends.alwaysDenyPaths ?? [],
        );
      } else if (!result.scopedFs && backends.storage) {
        // No fs_reach declared but attachments present — create read-only ScopedFs
        result.scopedFs = new ScopedFsImpl(
          backends.storage,
          attachmentDirs,
          new Set(),
          backends.alwaysDenyPaths ?? [],
        );
      }
    }
  }

  return result;
}
