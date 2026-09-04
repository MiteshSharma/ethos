---
title: "Tool capabilities reference"
description: "Complete reference for ToolCapabilities, StorageScope, scoped context interfaces, and the error catalog."
kind: reference
audience: developer
slug: tool-capabilities
updated: 2026-05-14
---

The [capability framework](../explanation/why-capabilities.md) gates external access for every [tool](../../getting-started/glossary.md#tool). A tool declares a `ToolCapabilities` object; the framework validates the declaration against the [personality](../../getting-started/glossary.md#personality) policy, resolves scoped context objects at call time, and injects them into `ToolContext`.

## Source {#source}

Types in [`packages/types/src/tool-capabilities.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/tool-capabilities.ts). Re-exported from `@ethosagent/types`.

Enforcement in [`packages/core/src/capability-validator.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/capability-validator.ts) (registration-time) and [`packages/core/src/capability-resolver.ts`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/capability-resolver.ts) (call-time). Scoped implementations in [`packages/core/src/scoped/`](https://github.com/ethosagent/ethos/blob/main/packages/core/src/scoped/).

## ToolCapabilities {#tool-capabilities}

### Signature {#tool-capabilities-signature}

```ts
import type { ToolCapabilities, SecretRef, StorageScope } from '@ethosagent/types';

export type SecretRef = string;

export type StorageScope = 'tool-private' | 'session' | 'personality';

export interface ToolCapabilities {
  network?: {
    allowedHosts: string[];
  };
  secrets?: SecretRef[];
  storage?: {
    scope: StorageScope;
    kind: 'kv';
    ttlSecondsDefault?: number;
  };
  fs_reach?: {
    read?: string[] | 'from-personality';
    write?: string[] | 'from-personality';
  };
  process?: {
    allowedBinaries: string[];
  };
}
```

### Fields {#tool-capabilities-fields}

| Field | Type | Description |
|---|---|---|
| `network` | `{ allowedHosts: string[] } \| undefined` | Hosts the tool may fetch. Supports exact match (`api.github.com`), wildcard (`*`), and subdomain wildcard (`*.github.com`). Intersected with personality `safety.network.allow` at call time. |
| `secrets` | `SecretRef[] \| undefined` | Secret reference names the tool may read. Each ref is resolved by the configured secrets backend at call time. |
| `storage` | `{ scope, kind, ttlSecondsDefault? } \| undefined` | Key-value storage request. `scope` determines the namespace; `kind` is always `'kv'`; `ttlSecondsDefault` sets a default TTL in seconds for entries (optional). |
| `fs_reach` | `{ read?, write? } \| undefined` | Filesystem paths the tool may access. Each direction is either a `string[]` of absolute paths or `'from-personality'` to defer to the personality's `fs_reach` config. |
| `process` | `{ allowedBinaries: string[] } \| undefined` | Binary names the tool may spawn. Supports exact match (`git`, `npm`) and wildcard (`*`). |

### Notes {#tool-capabilities-notes}

- A tool that touches no external surface declares `capabilities: {}`. The `capabilities` field is required on `Tool<TArgs>`.
- `network.allowedHosts: ['*']` means "whatever the personality allows." The wildcard is not "all hosts" -- it defers to the personality's `safety.network.allow` list. If the personality has no allow list, the resolved host set is empty.
- `fs_reach.read: 'from-personality'` and `fs_reach.write: 'from-personality'` are the conventional choice for generic file tools (`read_file`, `write_file`). Tool-specific paths are for tools that know their exact filesystem footprint (e.g. a config reader that only touches `~/.ethos/config.yaml`).

## StorageScope {#storage-scope}

### Signature {#storage-scope-signature}

```ts
export type StorageScope = 'tool-private' | 'session' | 'personality';
```

### Values {#storage-scope-values}

| Value | Resolved scope id | Lifecycle | Typical use |
|---|---|---|---|
| `'tool-private'` | `tool:<toolName>` | Persists across sessions. Private to this tool. | Caches, tool-internal state, rate-limit counters. |
| `'session'` | `session:<sessionId>` | Lives for the duration of the session. Shared across tools in the same session. | Scratch state, session-local accumulators. |
| `'personality'` | `personality:<personalityId>` | Persists across sessions. Scoped to the active personality. Falls back to `session:<sessionId>` if no personality is active. | Personality-specific tool state, cross-session memory. |

### Notes {#storage-scope-notes}

- The scope id is computed by `resolveCapabilities` in `packages/core/src/capability-resolver.ts`. The tool never constructs its own scope id.
- The `KeyValueStore` instance the tool receives is already namespaced. Calling `kvStore.set('foo', 'bar')` stores under the resolved scope id; the tool does not prefix keys.
- `ttlSecondsDefault` on the `storage` declaration sets a default TTL for all entries. Individual `set` calls can override with `{ ttlSeconds }` in the options.

## KeyValueStore {#key-value-store}

### Signature {#key-value-store-signature}

```ts
import type { KeyValueStore } from '@ethosagent/types';

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, opts?: { ttlSeconds?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}
```

### Methods {#key-value-store-methods}

| Method | Returns | Description |
|---|---|---|
| `get(key)` | `string \| null` | Read a value by key. Returns `null` if the key does not exist or has expired. |
| `set(key, value, opts?)` | `void` | Write a value. `opts.ttlSeconds` overrides the default TTL from the capability declaration. |
| `delete(key)` | `void` | Remove a key. No-op if the key does not exist. |
| `list(prefix)` | `string[]` | List keys matching a prefix. Returns key names, not values. |

### Notes {#key-value-store-notes}

- The store is injected into `ToolContext.kvStore` when the tool declares `storage` in its capabilities. Absent if the tool does not declare storage or no `kvStoreFactory` backend is configured.
- Values are strings. Tools that need structured data should serialise to JSON.

## ScopedFetch {#scoped-fetch}

### Signature {#scoped-fetch-signature}

```ts
import type { ScopedFetch } from '@ethosagent/types';

export interface ScopedFetch {
  fetch(url: string | URL, init?: RequestInit): Promise<Response>;
}
```

### Behaviour {#scoped-fetch-behaviour}

The implementation (`ScopedFetchImpl` in `packages/core/src/scoped/scoped-fetch.ts`) parses the URL, extracts the hostname, and checks it against the resolved host set (intersection of the tool's `allowedHosts` and the personality's `safety.network.allow`). If the host is not in the set, the call throws with `HOST_NOT_ALLOWED`. Otherwise it delegates to `globalThis.fetch`.

Host matching supports:
- Exact match: `'api.github.com'` matches `api.github.com`.
- Wildcard: `'*'` matches any host.
- Subdomain wildcard: `'*.github.com'` matches `api.github.com` and `raw.github.com` but not `github.com` itself.

### Notes {#scoped-fetch-notes}

- Injected into `ToolContext.scopedFetch` when the tool declares `network`. Absent otherwise.
- The resolved host set may be smaller than the tool's declared set. A tool declaring `['api.github.com', 'api.stripe.com']` under a personality that allows `['*.github.com']` gets a `ScopedFetch` that permits only `api.github.com`.

## ScopedFs {#scoped-fs}

### Signature {#scoped-fs-signature}

```ts
import type { ScopedFs } from '@ethosagent/types';

export interface ScopedFs {
  read(path: string): Promise<string>;
  write(path: string, content: string | Buffer): Promise<void>;
  exists(path: string): Promise<boolean>;
  list(path: string): Promise<string[]>;
}
```

### Methods {#scoped-fs-methods}

| Method | Returns | Description |
|---|---|---|
| `read(path)` | `string` | Read utf-8 text. Throws `PATH_NOT_REACHABLE` if the path is outside the declared read set. Throws if the file does not exist. |
| `write(path, content)` | `void` | Write utf-8 text or a Buffer. Throws `PATH_NOT_REACHABLE` if the path is outside the declared write set. |
| `exists(path)` | `boolean` | Check existence. Throws `PATH_NOT_REACHABLE` if the path is outside the declared read set. |
| `list(path)` | `string[]` | List directory children. Throws `PATH_NOT_REACHABLE` if the path is outside the declared read set. |

### Notes {#scoped-fs-notes}

- Injected into `ToolContext.scopedFs` when the tool declares `fs_reach`. Absent otherwise.
- The implementation (`ScopedFsImpl` in `packages/core/src/scoped/scoped-fs.ts`) resolves paths via `node:path.resolve` and `normalize` before checking. Relative paths are resolved against `process.cwd()`.
- Delegates to the `Storage` interface, not to raw `node:fs`. The same `Storage` abstraction powers `ScopedStorage` from the pre-existing filesystem boundary.
- `ScopedFs` is distinct from `ScopedStorage`. `ScopedStorage` (from `@ethosagent/storage-fs`) is the personality-level decorator on the full `Storage` interface. `ScopedFs` is the capability-gated subset exposed to individual tools.

## ScopedSecretsResolver {#scoped-secrets-resolver}

### Signature {#scoped-secrets-resolver-signature}

```ts
import type { ScopedSecretsResolver, SecretRef } from '@ethosagent/types';

export interface ScopedSecretsResolver {
  get(ref: SecretRef): Promise<string>;
}
```

### Behaviour {#scoped-secrets-resolver-behaviour}

The implementation (`ScopedSecretsImpl` in `packages/core/src/scoped/scoped-secrets.ts`) checks the requested `ref` against the tool's declared `secrets` set. If the ref is not declared, the call throws with `SECRET_NOT_DECLARED`. Otherwise it delegates to the configured secrets backend.

### Notes {#scoped-secrets-resolver-notes}

- Injected into `ToolContext.secretsResolver` when the tool declares `secrets` and a `secretsBackend` is configured. Absent otherwise.
- The secrets backend is a function `(ref: SecretRef) => Promise<string>` provided via `CapabilityBackends.secretsBackend`. The framework does not mandate where secrets are stored -- the backend is a wiring decision.

## ScopedProcess {#scoped-process}

### Signature {#scoped-process-signature}

```ts
import type { ScopedProcess, SpawnOpts, ProcessResult } from '@ethosagent/types';

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface ProcessResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ScopedProcess {
  spawn(binary: string, args: string[], opts?: SpawnOpts): Promise<ProcessResult>;
}
```

### Behaviour {#scoped-process-behaviour}

The implementation (`ScopedProcessImpl` in `packages/core/src/scoped/scoped-process.ts`) checks the requested `binary` against the tool's declared `allowedBinaries` set. Wildcard (`'*'`) permits any binary. If the binary is not in the set, the call throws with `BINARY_NOT_ALLOWED`. Otherwise it spawns the process via `node:child_process.spawn`.

### Notes {#scoped-process-notes}

- Injected into `ToolContext.scopedProcess` when the tool declares `process`. Absent otherwise.
- `opts.env` is merged with `process.env` -- the tool's declared env vars are additive, not replacing.
- `opts.timeout` is passed directly to `child_process.spawn`'s `timeout` option. The child is killed if it exceeds the timeout.

## Error catalog {#error-catalog}

All errors thrown by scoped context implementations use a stable prefix in the error message. Catch by `message.startsWith(code)` or by checking the `Error.message` directly.

| Code | Thrown by | When |
|---|---|---|
| `HOST_NOT_ALLOWED` | `ScopedFetchImpl` | The requested hostname is not in the resolved allowedHosts set. |
| `SECRET_NOT_DECLARED` | `ScopedSecretsImpl` | The requested secret ref is not in the tool's declared secrets set. |
| `PATH_NOT_REACHABLE` | `ScopedFsImpl` | The requested path is not covered by the tool's declared fs_reach (read or write). |
| `BINARY_NOT_ALLOWED` | `ScopedProcessImpl` | The requested binary is not in the tool's declared allowedBinaries set. |

### Error message format {#error-message-format}

Each error follows the pattern `<CODE>: <detail>`:

```
HOST_NOT_ALLOWED: api.stripe.com is not in the declared allowedHosts
SECRET_NOT_DECLARED: STRIPE_KEY is not in the tool's declared secrets
PATH_NOT_REACHABLE: read not permitted for /etc/passwd
BINARY_NOT_ALLOWED: rm is not in the declared allowedBinaries
```

### Notes {#error-catalog-notes}

- These errors propagate to `ToolResult` as `{ ok: false, code: 'execution_failed', error: err.message }` via the `executeParallel` catch handler. The LLM sees the full error message.
- Registration-time validation errors (`CapabilityValidationError`) are a separate type with `{ tool, capability, message }` fields. They are not thrown -- they are returned as an array from `validateRegistration` and `validateToolsForPersonality`.

## CapabilityBackends {#capability-backends}

### Signature {#capability-backends-signature}

```ts
import type { CapabilityBackends } from '@ethosagent/core';

export interface CapabilityBackends {
  kvStoreFactory?: (tool: string, scopeId: string) => KeyValueStore;
  secretsBackend?: (ref: SecretRef) => Promise<string>;
  storage?: Storage;
  personalityFsReach?: (personalityId?: string) => { read: string[]; write: string[] };
  personalityNetworkPolicy?: (personalityId?: string) => NetworkPolicy;
}
```

### Fields {#capability-backends-fields}

| Field | Type | Description |
|---|---|---|
| `kvStoreFactory` | `(tool, scopeId) => KeyValueStore` | Factory for scoped key-value stores. Called once per tool per turn. |
| `secretsBackend` | `(ref) => Promise<string>` | Resolves a secret ref to its value. Called by `ScopedSecretsImpl`. |
| `storage` | `Storage` | Filesystem abstraction passed to `ScopedFsImpl`. |
| `personalityFsReach` | `(personalityId?) => { read: string[]; write: string[] }` | Resolves the fs_reach of the personality running the turn. Used to resolve `'from-personality'` declarations and to intersect with tool-declared paths. |
| `personalityNetworkPolicy` | `(personalityId?) => NetworkPolicy` | Resolves the network policy of the personality running the turn. Its `allow` list is intersected with tool-declared hosts. |

### Notes {#capability-backends-notes}

- Passed to `DefaultToolRegistry` at construction. Shared across all tool executions.
- If absent, tools that declare real capabilities (`needsBackends` returns true) fail closed with `not_available`.
- `personalityFsReach` and `personalityNetworkPolicy` are resolvers, called per tool execution with the id of the personality running that call. They are never stored values: a stored value freezes the boundary at process start, so an on-disk config edit -- or a personality that is not the default -- resolves against the wrong policy.

## Used by {#used-by}

| Consumer | Role |
|---|---|
| `packages/types/src/tool-capabilities.ts` | Type definitions for all capability interfaces. |
| `packages/types/src/tool.ts` | `Tool.capabilities` field; `ToolContext` scoped fields (`kvStore`, `secretsResolver`, `scopedFetch`, `scopedFs`, `scopedProcess`). |
| `packages/core/src/capability-validator.ts` | `validateRegistration` -- registration-time policy check. |
| `packages/core/src/capability-resolver.ts` | `resolveCapabilities` -- call-time context building. |
| `packages/core/src/tool-registry.ts` | `needsBackends` guard; `executeParallel` capability resolution. |
| `packages/core/src/scoped/scoped-fetch.ts` | `ScopedFetchImpl` -- host-gated fetch. |
| `packages/core/src/scoped/scoped-fs.ts` | `ScopedFsImpl` -- path-gated filesystem. |
| `packages/core/src/scoped/scoped-secrets.ts` | `ScopedSecretsImpl` -- ref-gated secrets. |
| `packages/core/src/scoped/scoped-process.ts` | `ScopedProcessImpl` -- binary-gated process spawning. |

## See also {#see-also}

- [Why capabilities](../explanation/why-capabilities.md) -- the architectural motivation for the framework
- [Tool isolation model](../explanation/tool-isolation-model.md) -- how the enforcement points work together
- [Tool interface reference](./tool-interface.md) -- `Tool<TArgs>`, `ToolResult`, `ToolContext`
- [Storage interface reference](./storage-interface.md) -- `Storage`, `ScopedStorage`, `BoundaryError`
- [Tool registry reference](./tool-registry.md) -- `DefaultToolRegistry.executeParallel` and the capability wiring
