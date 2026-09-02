import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  CodexTokenStore,
  exchangeForTokens,
  pollForAuthorization,
  requestDeviceCode,
} from '@ethosagent/llm-codex';
import { FileSecretsResolver, FsStorage } from '@ethosagent/storage-fs';
import { probeProvider } from '@ethosagent/wiring';
import { PROVIDER_CATALOG } from '@ethosagent/wiring/provider-catalog';
import { Box, Text, useInput } from 'ink';
import { useEffect, useRef, useState } from 'react';
import { DESIGN, GLYPHS } from '../../skin';
import { useWizardContext } from '../context';
import { LOCAL_API_KEY_PLACEHOLDER } from '../local-provider';

// ---------------------------------------------------------------------------
// Device auth flow (used for codex provider)
// ---------------------------------------------------------------------------

function DeviceAuthFlow() {
  const { dispatch } = useWizardContext();
  const [phase, setPhase] = useState<'loading' | 'waiting' | 'success' | 'error'>('loading');
  const [userCode, setUserCode] = useState('');
  const [errorMsg, setErrorMsg] = useState('');
  const [retryCount, setRetryCount] = useState(0);
  // Stable ref so cleanup can abort the in-flight controller.
  const abortRef = useRef<AbortController | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: retryCount is intentional — triggers re-run on user retry
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('loading');
    setErrorMsg('');
    setUserCode('');

    (async () => {
      try {
        const { deviceAuthId, userCode: code } = await requestDeviceCode(globalThis.fetch);
        if (controller.signal.aborted) return;
        setUserCode(code);
        setPhase('waiting');

        const { authorizationCode, codeVerifier } = await pollForAuthorization(
          globalThis.fetch,
          deviceAuthId,
          code,
          controller.signal,
        );
        if (controller.signal.aborted) return;

        const credentials = await exchangeForTokens(
          globalThis.fetch,
          authorizationCode,
          codeVerifier,
        );
        const secrets = new FileSecretsResolver({
          dir: join(homedir(), '.ethos', 'secrets'),
          storage: new FsStorage(),
        });
        await new CodexTokenStore(secrets).save(credentials);

        setPhase('success');
        dispatch({ type: 'next', patch: { apiKey: '' } });
      } catch (err: unknown) {
        if (controller.signal.aborted) return;
        const msg = err instanceof Error ? err.message : String(err);
        setErrorMsg(msg);
        setPhase('error');
      }
    })();

    return () => {
      controller.abort();
    };
  }, [dispatch, retryCount]);

  useInput((_input, key: import('ink').Key) => {
    if (key.escape) {
      abortRef.current?.abort();
      dispatch({ type: 'back' });
      return;
    }
    if (key.return && phase === 'error') {
      setRetryCount((n) => n + 1);
    }
  });

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        {'Sign in with your OpenAI / ChatGPT account'}
      </Text>

      {phase === 'loading' && (
        <Text color={DESIGN.textSecondary}>{'  Requesting device code...'}</Text>
      )}

      {phase === 'waiting' && (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Text color={DESIGN.textSecondary}>{'  1. Open this link in your browser:'}</Text>
            <Text color={DESIGN.textTertiary}>{'     https://auth.openai.com/codex/device'}</Text>
          </Box>
          <Box flexDirection="column">
            <Text color={DESIGN.textSecondary}>{'  2. Enter this one-time code:'}</Text>
            <Text color={DESIGN.textPrimary} bold>{`     ${userCode}`}</Text>
          </Box>
          <Text color={DESIGN.textTertiary}>{'  Waiting for authorization... (Esc cancel)'}</Text>
        </Box>
      )}

      {phase === 'error' && (
        <Box flexDirection="column" gap={1}>
          <Text color={DESIGN.error}>{`  ${GLYPHS.toolFail} ${errorMsg}`}</Text>
          <Text color={DESIGN.textTertiary}>{'  Enter retry   Esc back'}</Text>
        </Box>
      )}

      {phase === 'success' && <Text color={DESIGN.success}>{`  ${GLYPHS.toolOk} Authorized`}</Text>}
    </Box>
  );
}

// ---------------------------------------------------------------------------

// W2.2 — a live 1-token probe needs *a* model; ModelStep runs later, so use a
// per-provider default. A wrong model on a GOOD key classifies as `unreachable`
// (non-blocking), while a BAD key still returns 401 → `rejected`.
const PROBE_MODEL: Record<string, string> = {
  anthropic: 'claude-opus-4-7',
  openai: 'gpt-4o',
  openrouter: 'openai/gpt-4o',
};

type AuthPhase = 'input' | 'validating' | 'validated';
type AuthValidation =
  | { kind: 'ok' }
  | { kind: 'rejected'; error: string }
  | { kind: 'unreachable'; error: string };

export function AuthStep() {
  const { answers, dispatch } = useWizardContext();
  const [key, setKey] = useState(answers.apiKey ?? '');
  const [error, setError] = useState('');

  const provider = PROVIDER_CATALOG.find((p) => p.id === answers.provider);
  const isDeviceAuth = provider?.authType === 'device-auth';
  const isSelfHosted = provider?.authType === 'self-hosted';
  // Bedrock signs requests with SigV4 off the ambient AWS credential chain —
  // there is no key to type, probe, or store.
  const isIamRole = provider?.authType === 'iam-role';
  // Azure needs both an endpoint and an API key — the endpoint is the user's
  // resource URL (e.g. https://my-resource.openai.azure.com), not a default.
  const isAzure = answers.provider === 'azure';

  // Azure-specific: phase machine inside the step. Endpoint first, then apiKey.
  const [azurePhase, setAzurePhase] = useState<'endpoint' | 'apiKey'>(() =>
    answers.baseUrl ? 'apiKey' : 'endpoint',
  );
  const [endpoint, setEndpoint] = useState(answers.baseUrl ?? '');

  // Alias to avoid shadowing by the `key` parameter in useInput below
  const apiKeyValue = key;

  // W2.2 — provider-key probe phase machine (normal api-key path only; azure,
  // device-auth, and self-hosted keep their existing flow). The probe applies
  // the W1.2 liveness split: 401/403 → re-enter; unreachable → save-with-warning.
  const probeEligible = !isAzure && !isDeviceAuth && !isSelfHosted && !isIamRole;
  const [phase, setPhase] = useState<AuthPhase>('input');
  const [validation, setValidation] = useState<AuthValidation | null>(null);

  // biome-ignore lint/correctness/useExhaustiveDependencies: probe runs once per validating transition
  useEffect(() => {
    if (phase !== 'validating') return;
    let cancelled = false;
    void (async () => {
      const outcome = await probeProvider({
        provider: answers.provider ?? 'anthropic',
        model: PROBE_MODEL[answers.provider ?? 'anthropic'] ?? 'gpt-4o',
        apiKey: apiKeyValue,
        baseUrl: answers.baseUrl ?? provider?.defaultBaseUrl,
      });
      if (cancelled) return;
      if (outcome.ok) setValidation({ kind: 'ok' });
      else if (outcome.reason === 'rejected')
        setValidation({ kind: 'rejected', error: outcome.error });
      else setValidation({ kind: 'unreachable', error: outcome.error });
      setPhase('validated');
    })();
    return () => {
      cancelled = true;
    };
  }, [phase]);

  useInput((input, key: import('ink').Key) => {
    // Device-auth input is handled by <DeviceAuthFlow> — skip here.
    if (isDeviceAuth) return;
    // Ignore all input while a provider probe is in flight.
    if (probeEligible && phase === 'validating') return;
    if (key.escape) {
      if (isAzure && azurePhase === 'apiKey') {
        // Step back to the endpoint field, not out of the step.
        setAzurePhase('endpoint');
        setError('');
        return;
      }
      // A probed result → Esc re-enters the key rather than leaving the step.
      if (probeEligible && phase === 'validated') {
        setPhase('input');
        setValidation(null);
        setError('');
        return;
      }
      dispatch({ type: 'back' });
      return;
    }
    if (key.return) {
      if (isAzure) {
        if (azurePhase === 'endpoint') {
          if (!endpoint.trim()) {
            setError('Azure endpoint is required');
            return;
          }
          if (!/^https?:\/\//i.test(endpoint.trim())) {
            setError('Endpoint must start with https:// or http://');
            return;
          }
          setAzurePhase('apiKey');
          setError('');
          return;
        }
        // azurePhase === 'apiKey'
        if (!apiKeyValue) {
          setError('API key is required');
          return;
        }
        dispatch({
          type: 'next',
          patch: { baseUrl: endpoint.trim(), apiKey: apiKeyValue },
        });
        return;
      }
      if (probeEligible) {
        if (phase === 'input') {
          if (!apiKeyValue) {
            setError('API key is required');
            return;
          }
          setError('');
          setPhase('validating');
          return;
        }
        // phase === 'validated'
        if (validation?.kind === 'rejected') {
          // No save-anyway for a definitively rejected key — re-enter it.
          setPhase('input');
          setValidation(null);
          return;
        }
        // ok or unreachable → proceed (unreachable saves the key unverified).
        dispatch({ type: 'next', patch: { apiKey: apiKeyValue } });
        return;
      }
      if (isIamRole) {
        // No key at all — the AWS SDK resolves credentials at request time.
        dispatch({ type: 'next', patch: { apiKey: '' } });
        return;
      }
      if (!isSelfHosted && !apiKeyValue) {
        setError('API key is required');
        return;
      }
      dispatch({
        type: 'next',
        patch: { apiKey: isSelfHosted ? LOCAL_API_KEY_PLACEHOLDER : apiKeyValue },
      });
      return;
    }
    if (key.backspace || key.delete) {
      if (isAzure && azurePhase === 'endpoint') {
        setEndpoint((v) => v.slice(0, -1));
      } else {
        // Editing the key invalidates any prior probe result.
        if (probeEligible && phase === 'validated') {
          setPhase('input');
          setValidation(null);
        }
        setKey((k) => k.slice(0, -1));
      }
      setError('');
      return;
    }
    if (!key.ctrl && !key.meta && input) {
      if (isAzure && azurePhase === 'endpoint') {
        setEndpoint((v) => v + input);
      } else {
        if (probeEligible && phase === 'validated') {
          setPhase('input');
          setValidation(null);
        }
        setKey((k) => k + input);
      }
      setError('');
    }
  });

  const signupNote = provider?.signupUrl ? `Get a key at ${provider.signupUrl}` : '';

  const maskedKey =
    apiKeyValue.length > 0
      ? `${'•'.repeat(Math.min(apiKeyValue.length, 20))}${apiKeyValue.length > 20 ? ` (${apiKeyValue.length} chars)` : ''}`
      : '';

  if (isDeviceAuth) {
    return <DeviceAuthFlow />;
  }

  if (isAzure) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {azurePhase === 'endpoint'
            ? 'Enter your Azure OpenAI endpoint:'
            : 'Enter your Azure API key:'}
        </Text>

        {azurePhase === 'endpoint' ? (
          <Box flexDirection="column">
            <Text color={DESIGN.textTertiary}>
              {'  Resource URL from the Azure portal (Keys and Endpoint).'}
            </Text>
            <Box flexDirection="row" gap={1} marginTop={1}>
              <Text color={DESIGN.textPrimary}>{`  ${GLYPHS.prompt} `}</Text>
              <Text color={endpoint ? DESIGN.textPrimary : DESIGN.textTertiary}>
                {endpoint || 'https://my-resource.openai.azure.com'}
              </Text>
            </Box>
            {error && <Text color={DESIGN.error}>{`  ${GLYPHS.toolFail} ${error}`}</Text>}
          </Box>
        ) : (
          <Box flexDirection="column">
            <Text color={DESIGN.textTertiary}>{`  Endpoint: ${endpoint}`}</Text>
            <Box flexDirection="row" gap={1} marginTop={1}>
              <Text color={DESIGN.textPrimary}>{`  ${GLYPHS.prompt} `}</Text>
              <Text color={maskedKey ? DESIGN.textPrimary : DESIGN.textTertiary}>
                {maskedKey || '(paste key — input is hidden)'}
              </Text>
            </Box>
            {error && <Text color={DESIGN.error}>{`  ${GLYPHS.toolFail} ${error}`}</Text>}
          </Box>
        )}

        <Text color={DESIGN.textTertiary}>
          {azurePhase === 'endpoint'
            ? '  Enter confirm   Esc back to provider'
            : '  Enter confirm   Esc edit endpoint'}
        </Text>
      </Box>
    );
  }

  if (isIamRole) {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {`${provider?.label ?? answers.provider} uses your AWS credentials:`}
        </Text>
        <Box flexDirection="column">
          <Text color={DESIGN.textSecondary}>
            {'  No API key — requests are signed from the AWS credential chain'}
          </Text>
          <Text color={DESIGN.textTertiary}>
            {'  (IAM role, aws sso login, or a named profile via AWS_PROFILE).'}
          </Text>
          <Text color={DESIGN.textTertiary}>
            {'  Region defaults to us-east-1 — set region: in ~/.ethos/config.yaml.'}
          </Text>
        </Box>
        <Text color={DESIGN.textTertiary}>{'  Enter confirm   Esc back'}</Text>
      </Box>
    );
  }

  if (probeEligible && phase === 'validating') {
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>
          {`Validating ${provider?.label ?? answers.provider} key...`}
        </Text>
        <Text color={DESIGN.textTertiary}>{'  Checking the key with a 1-token request'}</Text>
      </Box>
    );
  }

  if (probeEligible && phase === 'validated' && validation) {
    const label = provider?.label ?? answers.provider;
    return (
      <Box flexDirection="column" gap={1}>
        <Text color={DESIGN.textPrimary} bold>{`${label} key:`}</Text>
        {validation.kind === 'ok' && (
          <>
            <Text color={DESIGN.success}>{`  ${GLYPHS.toolOk} Key validated`}</Text>
            <Text color={DESIGN.textTertiary}>{'  Enter to continue'}</Text>
          </>
        )}
        {validation.kind === 'unreachable' && (
          <Text color={DESIGN.warning}>
            {`  Couldn't reach ${label} — saved unverified. Enter to continue`}
          </Text>
        )}
        {validation.kind === 'rejected' && (
          <Text color={DESIGN.error}>{`  ${GLYPHS.toolFail} Key rejected — Esc to re-enter`}</Text>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text color={DESIGN.textPrimary} bold>
        {isSelfHosted
          ? 'Confirm endpoint:'
          : `Enter your ${provider?.label ?? answers.provider} API key:`}
      </Text>

      {isSelfHosted ? (
        <Box flexDirection="column">
          <Text
            color={DESIGN.textSecondary}
          >{`  Base URL: ${answers.baseUrl ?? 'http://localhost:11434/v1'}`}</Text>
          <Text color={DESIGN.textTertiary}>{'  No API key required for local models.'}</Text>
        </Box>
      ) : (
        <Box flexDirection="column">
          {signupNote && <Text color={DESIGN.textTertiary}>{`  ${signupNote}`}</Text>}
          <Box flexDirection="row" gap={1} marginTop={1}>
            <Text color={DESIGN.textPrimary}>{`  ${GLYPHS.prompt} `}</Text>
            <Text color={maskedKey ? DESIGN.textPrimary : DESIGN.textTertiary}>
              {maskedKey || '(paste key — input is hidden)'}
            </Text>
          </Box>
          {!apiKeyValue && (
            <Text color={DESIGN.textTertiary}>
              {'  Tip: you can add a key later by editing ~/.ethos/config.yaml'}
            </Text>
          )}
          {error && <Text color={DESIGN.error}>{`  ${GLYPHS.toolFail} ${error}`}</Text>}
        </Box>
      )}

      <Text color={DESIGN.textTertiary}>{'  Enter confirm   Esc back'}</Text>
    </Box>
  );
}
