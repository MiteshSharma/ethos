import { useCallback, useEffect, useState } from 'react';

interface PluginCredentialSchema {
  ref: string;
  label: string;
  kind: 'text' | 'secret' | 'oauth';
  description?: string;
  oauthRef?: string;
}

interface CredentialOps {
  getCredential(ref: string): Promise<string | null>;
  setCredential(ref: string, value: string): Promise<void>;
  credentialPreview(ref: string): Promise<string | null>;
  requestOAuth(oauthRef: string): void;
}

export type { PluginCredentialSchema };

interface PluginSettingsPanelProps {
  name: string;
  version: string;
  description?: string;
  credentials: PluginCredentialSchema[];
  tools: string[];
  getCredential: CredentialOps['getCredential'];
  setCredential: CredentialOps['setCredential'];
  credentialPreview: CredentialOps['credentialPreview'];
  requestOAuth: CredentialOps['requestOAuth'];
  theme: 'dark' | 'light';
}

export function PluginSettingsPanel({
  name,
  version,
  description,
  credentials,
  tools,
  getCredential,
  setCredential,
  credentialPreview,
  requestOAuth,
  theme: _theme,
}: PluginSettingsPanelProps) {
  return (
    <div
      style={{
        padding: 16,
        fontFamily: 'var(--font-display, system-ui)',
        color: 'var(--text-primary, #e8e8e6)',
      }}
    >
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{name}</h3>
        <span
          style={{
            fontSize: 11,
            color: 'var(--text-tertiary, #7e7e7d)',
            fontFamily: 'var(--font-mono, monospace)',
          }}
        >
          v{version}
        </span>
        {description && (
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 13,
              color: 'var(--text-secondary, #9a9a98)',
            }}
          >
            {description}
          </p>
        )}
      </div>

      {credentials.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <SectionLabel>CREDENTIALS</SectionLabel>
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
              marginTop: 8,
            }}
          >
            {credentials.map((cred) => (
              <CredentialRow
                key={cred.ref}
                credential={cred}
                getCredential={getCredential}
                setCredential={setCredential}
                credentialPreview={credentialPreview}
                requestOAuth={requestOAuth}
              />
            ))}
          </div>
        </div>
      )}

      {tools.length > 0 && (
        <div>
          <SectionLabel>TOOLS</SectionLabel>
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 6,
              marginTop: 8,
            }}
          >
            {tools.map((tool) => (
              <span
                key={tool}
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-mono, monospace)',
                  padding: '2px 8px',
                  borderRadius: 'var(--radius-full, 9999px)',
                  background: 'var(--bg-overlay, #2a2a2a)',
                  color: 'var(--text-secondary, #9a9a98)',
                }}
              >
                {tool}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--text-tertiary, #7e7e7d)',
      }}
    >
      {children}
    </div>
  );
}

function CredentialRow({
  credential,
  getCredential: _getCredential,
  setCredential,
  credentialPreview,
  requestOAuth,
}: {
  credential: PluginCredentialSchema;
  getCredential: CredentialOps['getCredential'];
  setCredential: CredentialOps['setCredential'];
  credentialPreview: CredentialOps['credentialPreview'];
  requestOAuth: CredentialOps['requestOAuth'];
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    credentialPreview(credential.ref)
      .then(setPreview)
      .catch(() => {});
  }, [credential.ref, credentialPreview]);

  const handleSave = useCallback(async () => {
    if (!draft.trim()) return;
    setSaving(true);
    try {
      await setCredential(credential.ref, draft.trim());
      const updated = await credentialPreview(credential.ref);
      setPreview(updated);
      setEditing(false);
      setDraft('');
    } finally {
      setSaving(false);
    }
  }, [credential.ref, draft, setCredential, credentialPreview]);

  if (credential.kind === 'oauth') {
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderRadius: 'var(--radius-sm, 4px)',
          border: '1px solid var(--border-subtle, #2a2a2a)',
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{credential.label}</div>
          <div
            style={{
              fontSize: 11,
              color: preview ? 'var(--success, #4ade80)' : 'var(--text-tertiary, #7e7e7d)',
            }}
          >
            {preview ?? 'Not connected'}
          </div>
        </div>
        <button
          type="button"
          onClick={() => {
            if (credential.oauthRef) requestOAuth(credential.oauthRef);
          }}
          style={{
            height: 28,
            padding: '0 12px',
            borderRadius: 'var(--radius-sm, 4px)',
            background: 'var(--info, #4a9eff)',
            color: '#ffffff',
            border: 'none',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          {preview ? 'Reconnect' : 'Authenticate'}
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        padding: '8px 12px',
        borderRadius: 'var(--radius-sm, 4px)',
        border: '1px solid var(--border-subtle, #2a2a2a)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: editing ? 8 : 0,
        }}
      >
        <div>
          <div style={{ fontSize: 13, fontWeight: 500 }}>{credential.label}</div>
          {!editing && (
            <div
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono, monospace)',
                color: 'var(--text-tertiary, #7e7e7d)',
              }}
            >
              {preview ?? 'Not set'}
            </div>
          )}
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            style={{
              height: 24,
              padding: '0 8px',
              borderRadius: 'var(--radius-sm, 4px)',
              border: '1px solid var(--border-subtle, #2a2a2a)',
              background: 'transparent',
              color: 'var(--text-secondary, #9a9a98)',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            Edit
          </button>
        )}
      </div>
      {editing && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            type={credential.kind === 'secret' ? 'password' : 'text'}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            placeholder={`Enter ${credential.label.toLowerCase()}`}
            style={{
              flex: 1,
              height: 28,
              padding: '0 8px',
              borderRadius: 'var(--radius-sm, 4px)',
              border: '1px solid var(--border-subtle, #2a2a2a)',
              background: 'var(--bg-overlay, #2a2a2a)',
              color: 'var(--text-primary, #e8e8e6)',
              fontSize: 12,
              fontFamily: 'var(--font-mono, monospace)',
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={handleSave}
            disabled={saving || !draft.trim()}
            style={{
              height: 28,
              padding: '0 10px',
              borderRadius: 'var(--radius-sm, 4px)',
              background: 'var(--success, #4ade80)',
              color: 'var(--bg-base, #0f0f0f)',
              border: 'none',
              fontSize: 12,
              fontWeight: 500,
              cursor: saving ? 'wait' : 'pointer',
              opacity: saving || !draft.trim() ? 0.5 : 1,
            }}
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setDraft('');
            }}
            style={{
              height: 28,
              padding: '0 8px',
              borderRadius: 'var(--radius-sm, 4px)',
              border: '1px solid var(--border-subtle, #2a2a2a)',
              background: 'transparent',
              color: 'var(--text-tertiary, #7e7e7d)',
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
