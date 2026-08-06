---
title: "Secrets resolver"
description: "How Ethos resolves ${secrets:ref} placeholders — resolver precedence, backend behavior, failure modes."
kind: reference
audience: shared
slug: secrets-resolver
updated: 2026-05-16
---

## Synopsis {#synopsis}

The secrets resolver replaces `${secrets:<ref>}` placeholders in config values with actual secret material at runtime. It walks a precedence chain of backends until one returns a value. If none do, the placeholder stays unresolved and the dependent component fails with an actionable error.

Source: [`packages/types/src/secrets.ts`](https://github.com/ethosagent/ethos/blob/main/packages/types/src/secrets.ts) (the `SecretsResolver` interface). Implementations: [`packages/storage-fs/src/secrets.ts`](https://github.com/ethosagent/ethos/blob/main/packages/storage-fs/src/secrets.ts), [`packages/storage-fs/src/env-secrets.ts`](https://github.com/ethosagent/ethos/blob/main/packages/storage-fs/src/env-secrets.ts), [`extensions/secrets-aws/src/index.ts`](https://github.com/ethosagent/ethos/blob/main/extensions/secrets-aws/src/index.ts).

## Interpolation syntax {#interpolation-syntax}

```
${secrets:<ref>}
```

`<ref>` is a forward-slash-delimited path. Examples:

| Placeholder | Resolved ref |
|---|---|
| `${secrets:providers/anthropic/apiKey}` | `providers/anthropic/apiKey` |
| `${secrets:channels/telegram/default/botToken}` | `channels/telegram/default/botToken` |

The resolver strips `${secrets:` and the trailing `}`, then passes the ref to each backend in order.

## Resolver precedence {#resolver-precedence}

Backends are tried in this order. The first backend that returns a non-null value wins.

| Priority | Backend | Source | When active |
|---|---|---|---|
| 1 | `.env` file | `~/.ethos/.env` | Always (if file exists) |
| 2 | Process environment | `process.env` | Always |
| 3 | AWS Secrets Manager | AWS API | When `aws.secrets.enabled: true` in config |
| 4 | On-disk files | `~/.ethos/secrets/<ref>` | Always (if file exists) |

If all backends return null for a ref, the resolver returns null. The calling code decides whether null is fatal -- provider wiring throws, optional integrations skip.

## Backend behavior {#backend-behavior}

### .env file {#env-file}

Reads `~/.ethos/.env` as `KEY=VALUE` pairs. The ref is converted to an env-style key: slashes become underscores, the whole string is uppercased. `providers/anthropic/apiKey` becomes `PROVIDERS_ANTHROPIC_APIKEY`.

| Operation | Supported | Notes |
|---|---|---|
| get | Yes | Reads from parsed `.env` contents |
| set | No | `.env` is operator-managed |
| delete | No | |
| list | Yes | Returns all keys in the file |

### Process environment {#process-environment}

Same key conversion as `.env`. Reads from `process.env` directly.

| Operation | Supported | Notes |
|---|---|---|
| get | Yes | `process.env[KEY]` |
| set | No | |
| delete | No | |
| list | No | Not enumerable in a meaningful way |

### AWS Secrets Manager {#aws-secrets-manager}

Active only when `aws.secrets.enabled: true`. The full secret name in AWS is `<prefix>/<ref>`, where `<prefix>` comes from `aws.secrets.prefix` in config.

| Operation | Supported | Notes |
|---|---|---|
| get | Yes | `GetSecretValue` API call |
| set | No | Secrets are provisioned out-of-band by the operator |
| delete | No | |
| list | Yes | `ListSecrets` filtered by prefix |

Uses the default AWS credential chain (instance role, ECS task role, environment variables, `~/.aws/credentials`). The `aws.secrets.region` config field sets the client region.

### On-disk files {#on-disk-files}

Reads the file at `~/.ethos/secrets/<ref>`. The entire file content (trimmed of trailing newline) is the secret value.

| Operation | Supported | Notes |
|---|---|---|
| get | Yes | `readFile` on the path |
| set | Yes | `writeAtomic` to the path |
| delete | Yes | Removes the file |
| list | Yes | Directory listing under `~/.ethos/secrets/` |

## Configuration {#configuration}

All fields in [`config.yaml`](config-yaml.md):

| Field | Type | Default | Description |
|---|---|---|---|
| `aws.secrets.enabled` | boolean | `false` | Enable the AWS Secrets Manager backend |
| `aws.secrets.region` | string | — | AWS region for the Secrets Manager client (required when enabled) |
| `aws.secrets.prefix` | string | — | Prefix prepended to every ref before calling AWS (required when enabled) |

## Cache behavior {#cache-behavior}

The resolver caches resolved values in memory. There is no TTL -- once a secret is fetched, it stays cached until one of:

- **SIGHUP** -- clears the entire cache and re-fetches all refs on next access.
- **Process restart** -- cache is in-memory only, not persisted.

There is no background polling. Cache invalidation is operator-driven. See [Secrets architecture](../explanation/secrets-architecture.md) for why.

## Failure modes {#failure-modes}

AWS Secrets Manager errors and their resolver behavior:

| AWS error | Resolver behavior | User-visible effect |
|---|---|---|
| `ResourceNotFoundException` | Returns null, falls through to next backend | Silent if a lower-priority backend has the value; unresolved placeholder if none do |
| `AccessDeniedException` | Throws immediately | Startup fails with message naming the ref and suggesting IAM policy review |
| `ThrottlingException` | Throws immediately | Startup fails with message naming the ref and suggesting retry or request-limit increase |
| Credential failure (no role, expired token) | Throws immediately | Startup fails with actionable message: "No AWS credentials found -- attach an IAM role or set AWS_ACCESS_KEY_ID" |
| Network timeout | Throws immediately | Startup fails with message suggesting region check and network connectivity |

The design: missing secrets are recoverable (fall through); permission and infrastructure errors are not (throw early with a fix).

## See also {#see-also}

- [Configure AWS Secrets Manager](../how-to/configure-aws-secrets.md) -- step-by-step setup.
- [Secrets architecture](../explanation/secrets-architecture.md) -- design rationale for per-ref secrets, lazy fetching, SIGHUP invalidation.
- [config.yaml reference](config-yaml.md) -- full field list including `aws.secrets.*`.
