import { StarFilled, StarOutlined } from '@ant-design/icons';
import { Select, Tooltip } from 'antd';

// The personality picker shared by the Documents and Memory pages, plus the
// star that marks one personality as the favourite those pages open with.
//
// The star lives inside the dropdown so any personality can be favourited
// without selecting it first. Clicking it must not also select that row:
// rc-select puts its `onSelectValue` on the option div, so the star stops the
// click from reaching it. The option list preventDefaults `mousedown`, so
// focus never leaves the Select and the dropdown stays open.
//
// That in-dropdown star is POINTER-ONLY on purpose. A listbox option folds its
// children into its own accessible name, and Tab can't reach into the popup
// (blurring the Select closes it). So it is `aria-hidden` + `tabIndex={-1}`,
// and the star beside the closed Select — a real, tabbable, `aria-pressed`
// button acting on the current selection — is the keyboard and screen-reader
// route to the same toggle.

export interface SelectablePersonality {
  id: string;
  name: string;
}

export function PersonalitySelect({
  personalities,
  value,
  onChange,
  loading,
  favouriteId,
  onToggleFavourite,
}: {
  personalities: readonly SelectablePersonality[];
  value: string | null;
  onChange: (id: string) => void;
  loading?: boolean;
  favouriteId: string | null;
  onToggleFavourite: (id: string) => void;
}) {
  const selected = personalities.find((p) => p.id === value) ?? null;

  return (
    <span className="personality-select">
      <Select
        size="small"
        style={{ width: 200 }}
        value={value ?? undefined}
        onChange={onChange}
        loading={loading}
        options={personalities.map((p) => ({ value: p.id, label: p.name }))}
        optionRender={(option) => {
          const id = String(option.value ?? '');
          const isFavourite = id === favouriteId;
          return (
            <span className="personality-option">
              <span className="personality-option-name">{option.label}</span>
              <button
                type="button"
                aria-hidden="true"
                tabIndex={-1}
                className={starClassName(isFavourite)}
                onClick={(e) => {
                  e.stopPropagation();
                  onToggleFavourite(id);
                }}
              >
                {isFavourite ? <StarFilled /> : <StarOutlined />}
              </button>
            </span>
          );
        }}
      />
      {selected ? (
        <FavouriteToggle
          personality={selected}
          isFavourite={selected.id === favouriteId}
          onToggle={onToggleFavourite}
        />
      ) : null}
    </span>
  );
}

function FavouriteToggle({
  personality,
  isFavourite,
  onToggle,
}: {
  personality: SelectablePersonality;
  isFavourite: boolean;
  onToggle: (id: string) => void;
}) {
  const label = isFavourite
    ? `Unfavourite ${personality.name} — back to the default personality`
    : `Favourite ${personality.name} — Documents and Memory open with it`;
  return (
    <Tooltip title={label}>
      <button
        type="button"
        aria-label={label}
        aria-pressed={isFavourite}
        className={starClassName(isFavourite)}
        onClick={() => onToggle(personality.id)}
      >
        {isFavourite ? <StarFilled /> : <StarOutlined />}
      </button>
    </Tooltip>
  );
}

function starClassName(isFavourite: boolean): string {
  return isFavourite ? 'personality-star personality-star--on' : 'personality-star';
}
