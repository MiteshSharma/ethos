export { BedrockProvider, type BedrockProviderConfig } from './provider';
export { type SigV4Config, SigV4Signer, staticCredentials } from './sigv4';
export { type BedrockTransportConfig, streamBedrockConverse } from './transport';

// ---------------------------------------------------------------------------
// First-party plugin activation
// ---------------------------------------------------------------------------

import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import type { AwsCredentialIdentityProvider } from '@aws-sdk/types';
import type { EthosPluginApi, LLMProviderFactory } from '@ethosagent/plugin-sdk';
import { BedrockProvider } from './provider';
import { staticCredentials } from './sigv4';

export const PROVIDER_CONTRACT_MAJOR = 3;

const CREDENTIAL_ERROR = `Bedrock has no accessKeyId/secretAccessKey configured, so requests are signed
from the AWS default credential chain — and the chain could not resolve any credentials. Confirm one of:
  - the EC2 instance has an IAM role attached (Actions -> Security -> Modify IAM role)
  - the ECS task definition has a taskRoleArn set
  - the EKS pod has an IAM role for service accounts (IRSA) annotation
  - locally: run \`aws sso login\`, then set \`awsProfile:\` on the bedrock provider block or export AWS_PROFILE
Alternatively store static keys at providers/bedrock/accessKeyId and providers/bedrock/secretAccessKey.`;

/** Same predicate `@ethosagent/secrets-aws` uses; copied rather than imported so
 *  the two extensions stay independent. */
function isCredentialError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name;
  return (
    name === 'CredentialsProviderError' ||
    name === 'InvalidIdentityToken' ||
    name === 'ExpiredTokenException'
  );
}

/** The AWS default node credential chain, with resolution failures rewritten
 *  into actionable guidance. Resolution stays lazy — the chain is constructed
 *  here but only invoked on the first signed request. */
function chainCredentials(profile: string | undefined): AwsCredentialIdentityProvider {
  const chain = fromNodeProviderChain({ ...(profile !== undefined ? { profile } : {}) });
  return async () => {
    try {
      return await chain();
    } catch (err: unknown) {
      if (isCredentialError(err)) throw new Error(CREDENTIAL_ERROR, { cause: err });
      throw err;
    }
  };
}

export const bedrockFactory: LLMProviderFactory = async ({ config: cfg, secrets }) => {
  const region = (cfg.region as string) ?? 'us-east-1';
  const storedAccessKeyId = await secrets.get('providers/bedrock/accessKeyId');
  const storedSecretAccessKey = await secrets.get('providers/bedrock/secretAccessKey');
  const accessKeyId = storedAccessKeyId ?? (cfg.accessKeyId as string | undefined);
  const secretAccessKey = storedSecretAccessKey ?? (cfg.secretAccessKey as string | undefined);
  const sessionToken =
    (await secrets.get('providers/bedrock/sessionToken')) ??
    (cfg.sessionToken as string | undefined);

  // Static AWS keys come in pairs. HALF a pair — a typo, or a secret-store
  // entry that only half landed — would otherwise fall through to the chain
  // and sign as a DIFFERENT identity than the operator intended, so it fails
  // loudly. Both absent is the intended zero-config path and stays silent.
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    const present = accessKeyId ? 'accessKeyId' : 'secretAccessKey';
    const missing = accessKeyId ? 'secretAccessKey' : 'accessKeyId';
    const presentFromStore = Boolean(accessKeyId ? storedAccessKeyId : storedSecretAccessKey);
    const where = presentFromStore
      ? `store it at providers/bedrock/${missing}`
      : `set the \`${missing}\` config key on the bedrock provider block`;
    throw new Error(
      `Bedrock has ${present} but no ${missing}. Static AWS credentials need both — ` +
        `${where}, or remove ${present} to sign from the AWS default credential chain instead.`,
    );
  }

  const credentials =
    accessKeyId && secretAccessKey
      ? staticCredentials(accessKeyId, secretAccessKey, sessionToken)
      : chainCredentials(cfg.awsProfile as string | undefined);

  return new BedrockProvider({
    region,
    modelId: cfg.model as string,
    sigv4: { region, credentials },
  });
};

export function activate(api: EthosPluginApi): void {
  api.registerLLMProvider('bedrock', bedrockFactory);
}
