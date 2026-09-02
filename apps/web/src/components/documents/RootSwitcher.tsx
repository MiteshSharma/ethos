import { type DocumentRoot, documentRootOptions } from '../../lib/documents';

// The root strip above the breadcrumb, for a personality that declares more
// than one `fs_reach.workdir`.
//
// Renders NOTHING for a single root, which is the common case: a picker with
// one option is a control that cannot do anything, and the absolute path is
// already on screen in the rootline below.
//
// Raw buttons rather than a Tabs/Segmented primitive, matching the breadcrumb
// immediately underneath — this strip and that trail are the same kind of
// navigation, one level apart, and they should read as one control.

interface Props {
  roots: readonly DocumentRoot[];
  /** The selected root's `id`. */
  value: string;
  onChange: (id: string) => void;
}

export function RootSwitcher({ roots, value, onChange }: Props) {
  if (roots.length <= 1) return null;
  const options = documentRootOptions(roots);

  return (
    <div className="documents-roots" role="tablist" aria-label="Documents roots">
      {options.map((option) => {
        const selected = option.id === value;
        return (
          <button
            key={option.id}
            type="button"
            role="tab"
            aria-selected={selected}
            title={option.path}
            className={`documents-root-tab${selected ? ' documents-root-tab--current' : ''}`}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
