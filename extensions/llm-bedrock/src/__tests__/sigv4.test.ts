import { describe, expect, it } from 'vitest';
import { SigV4Signer, staticCredentials } from '../sigv4';

describe('SigV4Signer', () => {
  const signer = new SigV4Signer({
    region: 'us-east-1',
    credentials: staticCredentials(
      'AKIAIOSFODNN7EXAMPLE',
      'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    ),
  });

  it('produces Authorization header with correct format', async () => {
    const result = await signer.sign({
      method: 'POST',
      url: 'https://bedrock-runtime.us-east-1.amazonaws.com/model/anthropic.claude-v2/converse-stream',
      headers: { 'content-type': 'application/json' },
      body: '{"messages":[]}',
    });
    expect(result.headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\//,
    );
    expect(result.headers.Authorization).toContain('SignedHeaders=');
    expect(result.headers.Authorization).toContain('Signature=');
    expect(result.headers['x-amz-date']).toMatch(/^\d{8}T\d{6}Z$/);
    expect(result.headers['x-amz-content-sha256']).toBeTruthy();
  });

  it('includes session token header when provided', async () => {
    const signerWithToken = new SigV4Signer({
      region: 'us-west-2',
      credentials: staticCredentials(
        'AKIAIOSFODNN7EXAMPLE',
        'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
        'FwoGZXIvYXdzEBYaDHqa0AP',
      ),
    });
    const result = await signerWithToken.sign({
      method: 'POST',
      url: 'https://bedrock-runtime.us-west-2.amazonaws.com/model/test/converse-stream',
      headers: {},
      body: '{}',
    });
    expect(result.headers['x-amz-security-token']).toBe('FwoGZXIvYXdzEBYaDHqa0AP');
  });
});
