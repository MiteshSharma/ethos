import { ConfigProvider } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { Composer } from '../components/chat/Composer';
import { MessageList } from '../components/chat/MessageList';
import { PersonalityBar } from '../components/chat/PersonalityBar';
import { useActivePersonality } from '../hooks/useActivePersonality';
import { useChat } from '../hooks/useChat';
import { personalityTheme } from '../lib/theme';

// The chat surface — daily-driver tab in v0. Composition:
//
//   ┌────────────────────────────────┐
//   │  PersonalityBar (accent stripe)│
//   ├────────────────────────────────┤
//   │  MessageList (scrollable)      │
//   │  ↳ ghost streaming bubble at   │
//   │    the tail while in-flight    │
//   ├────────────────────────────────┤
//   │  [error banner if present]     │
//   │  Composer (sticky bottom)      │
//   └────────────────────────────────┘
//
// The whole subtree is wrapped in a per-personality `<ConfigProvider>`
// so Antd primitives inherit the active accent (Send button background,
// caret, focus ring, link colors). The base theme + AntApp wrap higher
// up in `main.tsx`.
//
// `?session=<id>` in the URL is the deep-link handle — opening a session
// from the Sessions tab (W4) navigates here with the param set; sending
// a fresh message updates the URL to the server-assigned id so refresh
// stays on the same conversation.

export function Chat() {
  const [searchParams, setSearchParams] = useSearchParams();
  const sessionParam = searchParams.get('session') ?? undefined;
  const { id: personalityId, model, isLoading } = useActivePersonality();

  const { state, currentSessionId, sendMessage } = useChat({
    ...(sessionParam ? { initialSessionId: sessionParam } : {}),
    personalityId,
    onSessionCreated: (id) => {
      // Mirror the server-assigned id into the URL so refresh stays on
      // this conversation. `replace` (not `push`) keeps Back from
      // bouncing the user out of an empty chat.
      setSearchParams({ session: id }, { replace: true });
    },
  });

  return (
    <ConfigProvider theme={personalityTheme(personalityId)}>
      <div className="chat-tab">
        <PersonalityBar personalityId={personalityId} model={isLoading ? '' : model} />
        <MessageList
          messages={state.messages}
          streamingText={state.streamingText}
          emptyHint={
            currentSessionId
              ? 'No messages in this session yet. Send one to get started.'
              : 'Start the conversation. Tools, files, and skills come along.'
          }
        />
        <div>
          {state.error ? (
            <div className="chat-error" role="alert">
              {state.error}
            </div>
          ) : null}
          <Composer
            personalityId={personalityId}
            disabled={state.isStreaming}
            onSend={sendMessage}
            placeholder={state.isStreaming ? 'Waiting for the response…' : 'Send a message…'}
          />
        </div>
      </div>
    </ConfigProvider>
  );
}
