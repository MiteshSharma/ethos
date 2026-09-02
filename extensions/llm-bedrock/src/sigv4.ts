import { createHash, createHmac } from 'node:crypto';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import type { AuthSigner, AuthSignRequest, AuthSignResult } from '@ethosagent/types';

export interface SigV4Config {
  region: string;
  credentials: AwsCredentialIdentityProvider;
}

/** Wraps a fixed credential triple as a provider, so callers with static keys
 *  hand the signer the same shape as `fromNodeProviderChain()` does. */
export function staticCredentials(
  accessKeyId: string,
  secretAccessKey: string,
  sessionToken?: string,
): AwsCredentialIdentityProvider {
  return async () => ({
    accessKeyId,
    secretAccessKey,
    ...(sessionToken !== undefined ? { sessionToken } : {}),
  });
}

export class SigV4Signer implements AuthSigner {
  constructor(private readonly config: SigV4Config) {}

  async sign(request: AuthSignRequest): Promise<AuthSignResult> {
    const { region } = this.config;
    const { accessKeyId, secretAccessKey, sessionToken } = await this.config.credentials();
    const service = 'bedrock';
    const now = new Date();
    const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
    const amzDate = `${dateStamp}T${now.toISOString().slice(11, 19).replace(/:/g, '')}Z`;

    const url = new URL(request.url);
    const canonicalUri = url.pathname;
    const canonicalQuerystring = url.searchParams.toString();

    const bodyHash = sha256(request.body ?? '');

    const headers: Record<string, string> = {
      ...request.headers,
      host: url.host,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': bodyHash,
    };
    if (sessionToken) {
      headers['x-amz-security-token'] = sessionToken;
    }

    const signedHeaderKeys = Object.keys(headers)
      .map((k) => k.toLowerCase())
      .sort();
    const signedHeaders = signedHeaderKeys.join(';');
    const canonicalHeaders = `${signedHeaderKeys
      .map(
        (k) =>
          `${k}:${headers[Object.keys(headers).find((h) => h.toLowerCase() === k) ?? k]?.trim()}`,
      )
      .join('\n')}\n`;

    const canonicalRequest = [
      request.method,
      canonicalUri,
      canonicalQuerystring,
      canonicalHeaders,
      signedHeaders,
      bodyHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256(canonicalRequest),
    ].join('\n');

    const signingKey = getSignatureKey(secretAccessKey, dateStamp, region, service);
    const signature = hmacHex(signingKey, stringToSign);

    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    return {
      headers: {
        ...headers,
        Authorization: authHeader,
      },
    };
  }
}

function sha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

function hmacHex(key: Buffer | string, data: string): string {
  return createHmac('sha256', key).update(data, 'utf8').digest('hex');
}

function getSignatureKey(key: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmac(`AWS4${key}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}
