---
title: "AWS IAM policies for Ethos"
description: "Copy-paste IAM policy templates for Ethos on AWS — Secrets Manager instance and operator roles, plus the Bedrock inference role."
kind: reference
audience: user
slug: aws-iam-policies
updated: 2026-09-03
---

## Synopsis {#synopsis}

Ethos touches two AWS services. Three IAM policies cover AWS Secrets Manager: the **read-only instance role** goes on the EC2/ECS/EKS workload, the **rotation-operator role** goes on the human (or CI pipeline) that provisions and rotates secrets from outside the instance, and the **instance write role** replaces the read-only one when `aws.secrets.enabled: true`. A fourth policy, the **Bedrock inference role**, covers `provider: bedrock` and is independent of the other three.

## Read-only instance role {#read-only-instance-role}

Attach this policy to the IAM role your Ethos instance assumes. It grants exactly three actions: fetch a secret value, describe its metadata, and list secrets under the prefix.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EthosReadOwnSecrets",
    "Effect": "Allow",
    "Action": [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:ListSecrets"
    ],
    "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:ethos/<deployment>/*"
  }]
}
```

This is the policy from the [Configure AWS Secrets Manager](../how-to/configure-aws-secrets.md) guide. The instance can read and list its own secrets and nothing else.

## Rotation-operator role {#rotation-operator-role}

Attach this policy to the IAM user or role you use from your laptop (or CI) to create, rotate, and delete secrets.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EthosRotateSecrets",
    "Effect": "Allow",
    "Action": [
      "secretsmanager:PutSecretValue",
      "secretsmanager:CreateSecret",
      "secretsmanager:DeleteSecret",
      "secretsmanager:ListSecrets",
      "secretsmanager:DescribeSecret"
    ],
    "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:ethos/<deployment>/*"
  }]
}
```

The operator can write, list, and delete secrets under the deployment prefix. The operator does **not** need `GetSecretValue` -- you provision secrets, you don't read them back. If you need to verify a value, use the AWS Console's "Retrieve secret value" button under your own login.

## Instance write role {#instance-write-role}

When `aws.secrets.enabled: true`, the instance role needs write permissions in addition to read. Ethos writes MCP OAuth tokens, `ethos secrets set` values, and any other runtime secrets to AWS Secrets Manager. This is **required** for deployments with `aws.secrets.enabled: true`. Without these permissions, every secret write fails at runtime.

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EthosReadOwnSecrets",
    "Effect": "Allow",
    "Action": [
      "secretsmanager:GetSecretValue",
      "secretsmanager:DescribeSecret",
      "secretsmanager:ListSecrets"
    ],
    "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:ethos/<deployment>/*"
  },
  {
    "Sid": "EthosWriteOwnSecrets",
    "Effect": "Allow",
    "Action": [
      "secretsmanager:CreateSecret",
      "secretsmanager:PutSecretValue",
      "secretsmanager:DeleteSecret",
      "secretsmanager:RestoreSecret"
    ],
    "Resource": "arn:aws:secretsmanager:<region>:<account>:secret:ethos/<deployment>/*"
  }]
}
```

`RestoreSecret` is required because `delete()` uses the default recovery window (reversible); when `set()` targets a secret that is still in scheduled-deletion state, it restores it first. `UpdateSecret` is deliberately omitted -- `PutSecretValue` covers value rotation, and `UpdateSecret` would allow changing metadata, KMS key, and tags that Ethos never needs.

## Bedrock inference role {#bedrock-inference-role}

Attach this policy when `provider: bedrock` is set. Ethos calls Bedrock's `ConverseStream` operation and nothing else, so one action covers it.

For a single-region foundation model id (`anthropic.claude-3-5-haiku-20241022-v1:0`):

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EthosBedrockInference",
    "Effect": "Allow",
    "Action": "bedrock:InvokeModelWithResponseStream",
    "Resource": "arn:aws:bedrock:<region>::foundation-model/<model-id>"
  }]
}
```

A `us.`-prefixed id is a cross-region inference profile, which routes to a foundation model in one of several regions. Grant both the profile ARN and every foundation-model ARN it can route to, or the call is denied at whichever region the profile picks:

```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Sid": "EthosBedrockInferenceProfile",
    "Effect": "Allow",
    "Action": "bedrock:InvokeModelWithResponseStream",
    "Resource": [
      "arn:aws:bedrock:<region>:<account>:inference-profile/us.anthropic.claude-sonnet-4-20250514-v1:0",
      "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
      "arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0",
      "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-20250514-v1:0"
    ]
  }]
}
```

Confirm the exact routing set for your profile before copying the region list:

```bash
aws bedrock get-inference-profile \
  --inference-profile-identifier us.anthropic.claude-sonnet-4-20250514-v1:0 \
  --region <region> --query 'models[].modelArn' --output text
```

Foundation-model ARNs carry no account segment -- the `::` in the middle is correct, not a typo. Inference-profile ARNs do carry one.

`<region>` is the region Ethos calls, which is the `region:` key in `~/.ethos/config.yaml` (default `us-east-1`). The routed foundation-model ARNs above are the profile's own routing set, which is fixed by the profile and independent of `<region>`.

This policy grants inference only. It does not grant model access; that is a separate per-account, per-region approval in the Bedrock console under **Model access**. See [Run Ethos on AWS Bedrock](../how-to/use-aws-bedrock.md) for the surrounding setup.

## Placeholders {#placeholders}

Replace three values in the Secrets Manager policies:

| Placeholder | What to use | Example |
|---|---|---|
| `<region>` | The AWS region where your secrets live | `us-east-1` |
| `<account>` | Your 12-digit AWS account ID | `123456789012` |
| `<deployment>` | The label you picked when provisioning secrets | `prod`, `staging`, `dev` |

The resulting ARN looks like: `arn:aws:secretsmanager:us-east-1:123456789012:secret:ethos/prod/*`

The Bedrock policy uses `<account>` the same way, reads `<region>` as the `region:` key in `~/.ethos/config.yaml` rather than the secrets region, and adds `<model-id>` -- the id from the Bedrock console, copied verbatim including the trailing `:0` version suffix.

## Common mistakes {#common-mistakes}

**Do not use `Resource: "*"`.**
This is the single most common IAM mistake with Secrets Manager. A wildcard resource grants access to every secret in the account -- not just Ethos secrets. Scope to your prefix.

**Do not share roles across deployments.**
If you run `prod` and `staging`, create separate policies scoped to `ethos/prod/*` and `ethos/staging/*`. A shared role means a staging compromise can read production secrets.

**You do not need `kms:*` actions.**
AWS Secrets Manager encrypts secrets at rest using the AWS-managed `aws/secretsmanager` KMS key by default. The `secretsmanager:GetSecretValue` permission implicitly grants the necessary KMS decrypt. You only need explicit `kms:Decrypt` if you use a customer-managed KMS key -- and if you're reading this guide, you probably don't.

## Applying the policies {#applying-the-policies}

Save each policy to a file and attach with the AWS CLI:

**Instance role (read-only):**

```bash
aws iam put-role-policy \
  --role-name <your-ec2-instance-role> \
  --policy-name EthosSecretsRead \
  --policy-document file://ethos-secrets-read.json
```

**Operator role (rotation):**

```bash
aws iam put-role-policy \
  --role-name <your-operator-role> \
  --policy-name EthosSecretsRotate \
  --policy-document file://ethos-secrets-rotate.json
```

## See also {#see-also}

- [Configure AWS Secrets Manager](../how-to/configure-aws-secrets.md) -- step-by-step setup using the read-only policy.
- [Run Ethos on AWS Bedrock](../how-to/use-aws-bedrock.md) -- where the Bedrock inference policy is attached, and how credentials resolve.
- [Audit secrets access with CloudTrail](../how-to/audit-secrets-access.md) -- detect when a non-Ethos principal reads your secrets.
- [Decommission an Ethos deployment](../how-to/decommission-ethos-deployment.md) -- clean teardown including IAM policy removal.
- [Secrets resolver reference](secrets-resolver.md) -- resolver precedence, backend behavior, failure modes.
