import { useCallback, useEffect, useState } from 'react';
import { jsx as _jsx, jsxs as _jsxs } from 'react/jsx-runtime';

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
}) {
  return _jsxs('div', {
    style: {
      padding: 16,
      fontFamily: 'var(--font-display, system-ui)',
      color: 'var(--text-primary, #e8e8e6)',
    },
    children: [
      _jsxs('div', {
        style: { marginBottom: 16 },
        children: [
          _jsx('h3', {
            style: { margin: 0, fontSize: 16, fontWeight: 600 },
            children: name,
          }),
          _jsxs('span', {
            style: {
              fontSize: 11,
              color: 'var(--text-tertiary, #7e7e7d)',
              fontFamily: 'var(--font-mono, monospace)',
            },
            children: ['v', version],
          }),
          description &&
            _jsx('p', {
              style: {
                margin: '4px 0 0',
                fontSize: 13,
                color: 'var(--text-secondary, #9a9a98)',
              },
              children: description,
            }),
        ],
      }),
      credentials.length > 0 &&
        _jsxs('div', {
          style: { marginBottom: 16 },
          children: [
            _jsx(SectionLabel, { children: 'CREDENTIALS' }),
            _jsx('div', {
              style: {
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                marginTop: 8,
              },
              children: credentials.map((cred) =>
                _jsx(
                  CredentialRow,
                  {
                    credential: cred,
                    getCredential: getCredential,
                    setCredential: setCredential,
                    credentialPreview: credentialPreview,
                    requestOAuth: requestOAuth,
                  },
                  cred.ref,
                ),
              ),
            }),
          ],
        }),
      tools.length > 0 &&
        _jsxs('div', {
          children: [
            _jsx(SectionLabel, { children: 'TOOLS' }),
            _jsx('div', {
              style: {
                display: 'flex',
                flexWrap: 'wrap',
                gap: 6,
                marginTop: 8,
              },
              children: tools.map((tool) =>
                _jsx(
                  'span',
                  {
                    style: {
                      fontSize: 11,
                      fontFamily: 'var(--font-mono, monospace)',
                      padding: '2px 8px',
                      borderRadius: 'var(--radius-full, 9999px)',
                      background: 'var(--bg-overlay, #2a2a2a)',
                      color: 'var(--text-secondary, #9a9a98)',
                    },
                    children: tool,
                  },
                  tool,
                ),
              ),
            }),
          ],
        }),
    ],
  });
}

function SectionLabel({ children }) {
  return _jsx('div', {
    style: {
      fontSize: 10,
      fontWeight: 700,
      letterSpacing: '0.08em',
      textTransform: 'uppercase',
      color: 'var(--text-tertiary, #7e7e7d)',
    },
    children: children,
  });
}

function CredentialRow({
  credential,
  getCredential: _getCredential,
  setCredential,
  credentialPreview,
  requestOAuth,
}) {
  const [preview, setPreview] = useState(null);
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
    return _jsxs('div', {
      style: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 12px',
        borderRadius: 'var(--radius-sm, 4px)',
        border: '1px solid var(--border-subtle, #2a2a2a)',
      },
      children: [
        _jsxs('div', {
          children: [
            _jsx('div', {
              style: { fontSize: 13, fontWeight: 500 },
              children: credential.label,
            }),
            _jsx('div', {
              style: {
                fontSize: 11,
                color: preview ? 'var(--success, #4ade80)' : 'var(--text-tertiary, #7e7e7d)',
              },
              children: preview ?? 'Not connected',
            }),
          ],
        }),
        _jsx('button', {
          type: 'button',
          onClick: () => {
            if (credential.oauthRef) requestOAuth(credential.oauthRef);
          },
          style: {
            height: 28,
            padding: '0 12px',
            borderRadius: 'var(--radius-sm, 4px)',
            background: 'var(--info, #4a9eff)',
            color: '#ffffff',
            border: 'none',
            fontSize: 12,
            fontWeight: 500,
            cursor: 'pointer',
          },
          children: preview ? 'Reconnect' : 'Authenticate',
        }),
      ],
    });
  }

  return _jsxs('div', {
    style: {
      padding: '8px 12px',
      borderRadius: 'var(--radius-sm, 4px)',
      border: '1px solid var(--border-subtle, #2a2a2a)',
    },
    children: [
      _jsxs('div', {
        style: {
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: editing ? 8 : 0,
        },
        children: [
          _jsxs('div', {
            children: [
              _jsx('div', {
                style: { fontSize: 13, fontWeight: 500 },
                children: credential.label,
              }),
              !editing &&
                _jsx('div', {
                  style: {
                    fontSize: 11,
                    fontFamily: 'var(--font-mono, monospace)',
                    color: 'var(--text-tertiary, #7e7e7d)',
                  },
                  children: preview ?? 'Not set',
                }),
            ],
          }),
          !editing &&
            _jsx('button', {
              type: 'button',
              onClick: () => setEditing(true),
              style: {
                height: 24,
                padding: '0 8px',
                borderRadius: 'var(--radius-sm, 4px)',
                border: '1px solid var(--border-subtle, #2a2a2a)',
                background: 'transparent',
                color: 'var(--text-secondary, #9a9a98)',
                fontSize: 11,
                cursor: 'pointer',
              },
              children: 'Edit',
            }),
        ],
      }),
      editing &&
        _jsxs('div', {
          style: { display: 'flex', gap: 6 },
          children: [
            _jsx('input', {
              type: credential.kind === 'secret' ? 'password' : 'text',
              value: draft,
              onChange: (e) => setDraft(e.target.value),
              onKeyDown: (e) => e.key === 'Enter' && handleSave(),
              placeholder: `Enter ${credential.label.toLowerCase()}`,
              style: {
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
              },
            }),
            _jsx('button', {
              type: 'button',
              onClick: handleSave,
              disabled: saving || !draft.trim(),
              style: {
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
              },
              children: 'Save',
            }),
            _jsx('button', {
              type: 'button',
              onClick: () => {
                setEditing(false);
                setDraft('');
              },
              style: {
                height: 28,
                padding: '0 8px',
                borderRadius: 'var(--radius-sm, 4px)',
                border: '1px solid var(--border-subtle, #2a2a2a)',
                background: 'transparent',
                color: 'var(--text-tertiary, #7e7e7d)',
                fontSize: 12,
                cursor: 'pointer',
              },
              children: 'Cancel',
            }),
          ],
        }),
    ],
  });
}
