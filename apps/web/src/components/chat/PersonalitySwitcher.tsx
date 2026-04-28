import type { Personality } from '@ethosagent/web-contracts';
import { useQuery } from '@tanstack/react-query';
import { Dropdown, type MenuProps } from 'antd';
import { rpc } from '../../rpc';
import { PersonalityMark } from '../ui/PersonalityMark';

// Dropdown anchored in the personality bar's reserved actions slot. The
// caller (Chat.tsx) decides what "switch" means — for an active session
// with messages, it auto-forks (DESIGN.md: "auto-fork the session" /
// "old conversation preserved under old personality"). For an empty
// session, it just changes the override.
//
// Antd's `Dropdown` is the right primitive — keyboard accessible, anchors
// to the trigger, no need to roll our own popover. The menu items render
// the personality mark + name + a tiny accent dot so the user picks
// visually, not by reading the id.

export interface PersonalitySwitcherProps {
  current: string;
  onSelect: (personalityId: string) => void;
}

export function PersonalitySwitcher({ current, onSelect }: PersonalitySwitcherProps) {
  const { data } = useQuery({
    queryKey: ['personalities'],
    queryFn: () => rpc.personalities.list(),
  });

  const personalities = data?.personalities ?? [];
  const items: MenuProps['items'] = personalities.map((p) => ({
    key: p.id,
    label: <PersonalityMenuRow personality={p} active={p.id === current} />,
  }));

  return (
    <Dropdown
      menu={{
        items,
        onClick: ({ key }) => {
          if (key !== current) onSelect(String(key));
        },
        selectedKeys: [current],
      }}
      trigger={['click']}
      placement="bottomRight"
      // Width matches the menu row content; let Antd size it from the items.
    >
      <button
        type="button"
        className="personality-switcher-trigger"
        aria-label="Switch personality"
      >
        <CaretDown />
      </button>
    </Dropdown>
  );
}

function PersonalityMenuRow({
  personality,
  active,
}: {
  personality: Personality;
  active: boolean;
}) {
  return (
    <span className="personality-menu-row">
      <PersonalityMark personalityId={personality.id} size={20} />
      <span className="personality-menu-name">{personality.name}</span>
      {active ? (
        <span className="personality-menu-active" aria-hidden="true">
          ✓
        </span>
      ) : null}
    </span>
  );
}

function CaretDown() {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 12 12"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M3 4.5l3 3 3-3" />
    </svg>
  );
}
