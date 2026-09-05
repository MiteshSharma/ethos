import { Skeleton } from 'antd';
import { FeedbackRow } from '../../components/ui/FeedbackRow';
import { SectionHeading } from '../../pages/settings/components/section-heading';
import { useObservedChats } from './api/queries';
import {
  groupByBot,
  OBSERVED_EMPTY_COPY,
  type ObservedRowView,
  observedErrorRow,
  observedRowView,
  omittedNote,
} from './observed-rows';

// Communications › Observed chats (plan/phases/ambient-group-monitoring.md
// R12, §8).
//
// Rows, not a table and not a Card: every line here is a `FeedbackRow` — the
// same row the chat trail and the backup pane draw (feedback & activity
// contract §6). A second row component for "communications feedback" would be
// exactly the fork that contract exists to prevent, so there is none, and the
// error state is a `✗ failed` ROW that stays rather than a toast that leaves.
//
// Three things this section deliberately does NOT show:
//
//   * No message text. The transcript is the digest turn's input, never a
//     settings page's reading material (§8, "Never the last message text").
//   * No "all chats recording" reassurance. Zero problems found is not a
//     verification, and the contract is explicit that a fail-open surface must
//     not fabricate assurance (§3).
//   * No mode column. The store records lanes, not configuration; a mode here
//     would be invented, and every listed lane is observed by construction.

function ObservedRow({ view }: { view: ObservedRowView }) {
  return (
    <FeedbackRow
      status={view.status}
      subject={view.subject}
      result={view.result}
      {...(view.meta ? { meta: view.meta } : {})}
    />
  );
}

export function ObservedChats() {
  const query = useObservedChats();
  const now = Date.now();

  let body: React.ReactNode;
  if (query.isLoading) {
    body = <Skeleton active paragraph={{ rows: 3 }} title={false} />;
  } else if (query.error) {
    // The RPC itself never rejects on an unreadable transcript — that comes
    // back as `data.error` below. Reaching here means the request did not
    // arrive at all, which is a different sentence and gets one.
    body = (
      <ObservedRow view={observedErrorRow(`could not reach the server — ${query.error.message}`)} />
    );
  } else if (query.data?.error) {
    body = <ObservedRow view={observedErrorRow(query.data.error)} />;
  } else if (!query.data || query.data.lanes.length === 0) {
    body = <div className="right-drawer-empty">{OBSERVED_EMPTY_COPY}</div>;
  } else {
    const { lanes, omittedCount } = query.data;
    const note = omittedNote(lanes.length, omittedCount);
    body = (
      <>
        {groupByBot(lanes).map((group) => (
          <div className="observed-bot" key={group.id}>
            <div className="observed-bot-header">
              {group.platform} · {group.botKey}
            </div>
            {group.lanes.map((lane) => (
              <ObservedRow key={lane.laneKey} view={observedRowView(lane, now)} />
            ))}
          </div>
        ))}
        {note ? <div className="observed-note">{note}</div> : null}
      </>
    );
  }

  return (
    <section className="observed-chats">
      <SectionHeading>Observed chats</SectionHeading>
      {body}
    </section>
  );
}
