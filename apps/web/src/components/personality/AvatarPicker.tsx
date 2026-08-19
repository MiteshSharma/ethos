import { UploadOutlined } from '@ant-design/icons';
import { Alert, Button, Typography } from 'antd';
import { type ChangeEvent, useRef, useState } from 'react';

// Standalone and state-agnostic — same pattern as `ToolsetPicker`/`SkillsPicker`
// in `pages/Personalities.tsx`: no internal data fetching, no network calls.
// Both call sites (`NewAgentDialog`'s create flow, `IdentityEditor`'s edit
// flow) own the selection state and the actual network sequencing
// (`avatarActions.ts`); this component only offers the picker UI and the
// client-side file validation that must happen before either ever fires.

interface CuratedAvatar {
  id: string;
  url: string;
  label: string;
}

const FACE_AVATARS: ReadonlyArray<CuratedAvatar> = [
  { id: 'aria', url: '/avatars/aria.svg', label: 'Aria' },
  { id: 'milo', url: '/avatars/milo.svg', label: 'Milo' },
  { id: 'nova', url: '/avatars/nova.svg', label: 'Nova' },
  { id: 'theo', url: '/avatars/theo.svg', label: 'Theo' },
  { id: 'iris', url: '/avatars/iris.svg', label: 'Iris' },
  { id: 'kai', url: '/avatars/kai.svg', label: 'Kai' },
  { id: 'luna', url: '/avatars/luna.svg', label: 'Luna' },
  { id: 'remy', url: '/avatars/remy.svg', label: 'Remy' },
];

// Concept-icon category — same circular-crop register as the face avatars
// (128x128 viewBox, flat background + centered glyph) but iconographic
// rather than illustrated, so the two rows read as one family at a glance
// while staying visually distinguishable from each other.
const ICON_AVATARS: ReadonlyArray<CuratedAvatar> = [
  { id: 'bolt', url: '/avatars/bolt.svg', label: 'Bolt' },
  { id: 'stocks', url: '/avatars/stocks.svg', label: 'Stocks' },
  { id: 'manager', url: '/avatars/manager.svg', label: 'Manager' },
  { id: 'voice', url: '/avatars/voice.svg', label: 'Voice' },
  { id: 'rocket', url: '/avatars/rocket.svg', label: 'Rocket' },
  { id: 'shield', url: '/avatars/shield.svg', label: 'Shield' },
  { id: 'brain', url: '/avatars/brain.svg', label: 'Brain' },
  { id: 'compass', url: '/avatars/compass.svg', label: 'Compass' },
];

/** Mirrors the backend allowlist in `apps/web-api/src/routes/personality-avatar.ts`
 *  (`ALLOWED_MIME_TYPES`, `AVATAR_MAX_BYTES`) — kept local, not imported, since
 *  that module lives server-side and this check must run before any request
 *  reaches the network. */
const ALLOWED_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_BYTES = 5 * 1024 * 1024;

export interface AvatarPickerProps {
  /** URL of the currently selected curated avatar, if any — highlights the
   *  matching swatch. Leave unset when the current avatar is an upload (or
   *  none), so no swatch is highlighted incorrectly. */
  selectedCuratedUrl?: string;
  onSelectCurated: (url: string) => void;
  onFileSelected: (file: File) => void;
  onRemove?: () => void;
  /** Show the "Remove" affordance — only when there's a current avatar. */
  showRemove: boolean;
}

function AvatarRow({
  avatars,
  selectedCuratedUrl,
  onSelect,
}: {
  avatars: ReadonlyArray<CuratedAvatar>;
  selectedCuratedUrl: string | undefined;
  onSelect: (url: string) => void;
}) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
      {avatars.map((avatar) => (
        <button
          key={avatar.id}
          type="button"
          aria-label={avatar.label}
          aria-pressed={selectedCuratedUrl === avatar.url}
          onClick={() => onSelect(avatar.url)}
          style={{
            width: 40,
            height: 40,
            padding: 0,
            borderRadius: '50%',
            border:
              selectedCuratedUrl === avatar.url
                ? '2px solid var(--ethos-accent)'
                : '2px solid transparent',
            background: 'none',
            cursor: 'pointer',
            lineHeight: 0,
          }}
        >
          <img src={avatar.url} alt="" width={36} height={36} style={{ borderRadius: '50%' }} />
        </button>
      ))}
    </div>
  );
}

export function AvatarPicker({
  selectedCuratedUrl,
  onSelectCurated,
  onFileSelected,
  onRemove,
  showRemove,
}: AvatarPickerProps) {
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  function selectCurated(url: string) {
    setError(null);
    onSelectCurated(url);
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow reselecting the same file after an error
    if (!file) return;
    if (!ALLOWED_MIME_TYPES.has(file.type)) {
      setError(
        `Unsupported file type "${file.type || 'unknown'}". Upload a PNG, JPEG, WebP, or GIF image.`,
      );
      return;
    }
    if (file.size > MAX_BYTES) {
      setError('Image is larger than 5MB. Choose a smaller file.');
      return;
    }
    setError(null);
    onFileSelected(file);
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--ethos-text-dim)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 6,
            }}
          >
            Faces
          </div>
          <AvatarRow
            avatars={FACE_AVATARS}
            selectedCuratedUrl={selectedCuratedUrl}
            onSelect={selectCurated}
          />
        </div>
        <div>
          <div
            style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--ethos-text-dim)',
              textTransform: 'uppercase',
              letterSpacing: '0.08em',
              marginBottom: 6,
            }}
          >
            Icons
          </div>
          <AvatarRow
            avatars={ICON_AVATARS}
            selectedCuratedUrl={selectedCuratedUrl}
            onSelect={selectCurated}
          />
        </div>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button size="small" icon={<UploadOutlined />} onClick={() => inputRef.current?.click()}>
            Upload image
          </Button>
          {showRemove ? (
            <Button size="small" danger onClick={onRemove}>
              Remove
            </Button>
          ) : null}
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 11 }}>
          Recommended: square image, at least 128×128px. It renders as small as 14px and up to 120px
          across the app, so a larger file only slows down loading.
        </Typography.Text>
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        style={{ display: 'none' }}
        onChange={handleFileChange}
      />

      {error ? <Alert type="error" showIcon message={error} /> : null}
    </div>
  );
}
