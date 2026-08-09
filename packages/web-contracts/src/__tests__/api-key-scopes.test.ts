import { describe, expect, it } from 'vitest';
import { ApiKeyMetadataSchema, ApiKeyScopeSchema } from '../index';

// Regression guard for the two-mint-paths split.
//
// `/v1/*` asserts the literal scope `chat`. `ApiKeyScopeSchema` did not list
// it, so the two mint paths produced mutually exclusive key populations:
//
//   `ethos api-key create`  → wrote `['chat']` straight into SQLite (the store
//                             does no scope validation) → worked on `/v1/*`.
//   `apiKeys.create` RPC    → `z.array(ApiKeyScopeSchema)` rejected `'chat'`
//                             → the web UI could never mint a working key.
//
// The output half broke too: `apiKeys.list` validates against
// `ApiKeyMetadataSchema`, so a CLI-minted key was unrenderable in the web UI.

describe('ApiKeyScopeSchema — `chat` is mintable through both paths', () => {
  it('accepts `chat`, the scope `/v1/*` asserts', () => {
    expect(ApiKeyScopeSchema.safeParse('chat').success).toBe(true);
  });

  it('validates a web-UI create payload scoped to `chat`', () => {
    // Mirrors ApiKeyCreateInput.scopes in ../router — `z.array(ApiKeyScopeSchema)`.
    const parsed = ApiKeyScopeSchema.array().min(1).safeParse(['chat']);
    expect(parsed.success).toBe(true);
  });

  it('round-trips a CLI-minted `chat` key through ApiKeyMetadataSchema', () => {
    const parsed = ApiKeyMetadataSchema.safeParse({
      id: 'key_1',
      prefix: 'sk-ethos-abc',
      name: 'cursor',
      scopes: ['chat'],
      allowedOrigins: [],
      createdAt: new Date().toISOString(),
      lastUsed: null,
      revokedAt: null,
    });
    expect(parsed.success).toBe(true);
  });

  it('keeps `chat` and `chat:send` as distinct members', () => {
    expect(ApiKeyScopeSchema.options).toContain('chat');
    expect(ApiKeyScopeSchema.options).toContain('chat:send');
  });

  it('still rejects a scope that is not in the enum', () => {
    expect(ApiKeyScopeSchema.safeParse('completions').success).toBe(false);
  });
});
