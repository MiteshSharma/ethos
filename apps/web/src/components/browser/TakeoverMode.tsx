import type { ClarifyRequestEvent } from '@ethosagent/web-contracts';
import { useEffect, useState } from 'react';
import { rpc } from '../../rpc';
import { TakeoverStage } from './TakeoverStage';
import { useTakeoverSocket } from './useTakeoverSocket';

// The stage plus its lane. Chat renders THIS, not the stage: the socket must
// open when the mode opens and close when it collapses, and a hook in `Chat`
// would keep a screencast running behind a page the user has gone back to.
//
// Hand-back has a fallback on purpose. The lane's `handback` frame is the
// normal path — the server stops the screencast before it resolves, so the
// agent never resumes into a live capture — but a takeover whose lane never
// connected (a session in the gateway process, a refused screencast) still has
// a person who needs to give the browser back. That path is `clarify.respond`,
// the same call the card's button makes. Both end at `ClarifyBridge.respond`;
// neither is a second teardown.

export interface TakeoverModeProps {
  request: ClarifyRequestEvent;
  /** ms epoch the panel first saw this takeover. */
  startedAt: number;
  /** Collapse the mode. Does NOT hand back. */
  onBackToChat: () => void;
}

/**
 * WHICH hand-back is in flight, not merely THAT one is.
 *
 * The two paths fail in opposite directions, and one flag could not tell them
 * apart. A `'lane'` hand-back is finished by the server — `closed: handed_back`
 * or `handback_failed` — so if the lane goes away before either arrives, the
 * request is gone with it and the button must come back. An `'rpc'` hand-back
 * is already the fallback and runs while the lane is unavailable, so the same
 * signal must NOT re-enable the button underneath it.
 */
type HandingBackVia = 'lane' | 'rpc';

export function TakeoverMode({ request, startedAt, onBackToChat }: TakeoverModeProps) {
  const [handingBack, setHandingBack] = useState<HandingBackVia | null>(null);
  const [handbackNotice, setHandbackNotice] = useState<string | null>(null);
  const lane = useTakeoverSocket({
    sessionId: request.meta?.sessionId,
    requestId: request.requestId,
    initialUrl: request.meta?.url ?? '',
    enabled: true,
  });

  // The lane stopped being the way out while it was carrying a hand-back — it
  // dropped, or the server refused with `handback_failed`. Either way nothing
  // resolved the clarify, so the browser is still the operator's and the
  // fallback button is how they give it back. Leaving it disabled strands them
  // in a mode whose only exit is discovering that leaving it reveals another
  // button. `handed_back` does not come through here: it lands as `'ended'`.
  useEffect(() => {
    if (handingBack !== 'lane' || lane.status !== 'unavailable') return;
    setHandingBack(null);
    setHandbackNotice(
      'The live view went away before the hand-back landed — the browser is still yours. Press Hand back again.',
    );
  }, [handingBack, lane.status]);

  const handBack = async (): Promise<void> => {
    setHandbackNotice(null);
    if (lane.status === 'live') {
      setHandingBack('lane');
      lane.send({ t: 'handback' });
      return;
    }
    setHandingBack('rpc');
    try {
      await rpc.clarify.respond({
        requestId: request.requestId,
        answer: 'handed back',
        source: 'user',
      });
    } catch {
      setHandingBack(null);
      setHandbackNotice(
        'The hand-back did not go through — the browser is still yours. Try again.',
      );
    }
  };

  return (
    <TakeoverStage
      url={lane.url}
      startedAt={startedAt}
      status={lane.status}
      // The lane's own sentence wins where it has one: `handback_failed` and
      // `session_gone` say more than this component can. `handbackNotice` is
      // for the case that carries no sentence at all — a socket that simply
      // dropped — so the attempt does not vanish silently.
      notice={lane.notice ?? handbackNotice}
      frameSrc={lane.frameSrc}
      handingBack={handingBack !== null}
      onInput={lane.send}
      onHandBack={() => void handBack()}
      onBackToChat={onBackToChat}
    />
  );
}
