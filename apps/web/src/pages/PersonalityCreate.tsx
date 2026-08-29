import { Button, ConfigProvider, Result, Space, Typography } from 'antd';
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Composer } from '../components/chat/Composer';
import { MessageList } from '../components/chat/MessageList';
import { useChat } from '../hooks/useChat';
import { buildNewSessionPath } from '../lib/newSessionPicker';
import { personalityTheme } from '../lib/theme';

const ARCHITECT_ID = 'personality-architect';

/**
 * Wizard page for AI-assisted personality creation. Two phases:
 *
 *   Phase 1 — Chat with the personality-architect agent. It asks discovery
 *             questions and eventually calls `scaffold_personality`.
 *   Phase 2 — Success panel with navigation to test the new personality.
 */
export function PersonalityCreate() {
  const navigate = useNavigate();
  const { state, sendMessage } = useChat({ personalityId: ARCHITECT_ID });

  // Detect scaffold completion. The architect's final message contains the
  // string "scaffolded successfully" after calling the tool.
  const scaffoldResult = useMemo(() => {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const msg = state.messages[i];
      if (msg?.role !== 'assistant') continue;
      // Concatenate text blocks to search for the success marker.
      const text = msg.blocks
        .filter((b): b is { kind: 'text'; content: string } => b.kind === 'text')
        .map((b) => b.content)
        .join('');
      if (!text.includes('scaffolded successfully')) continue;
      // Extract personality id from: Personality "some-id" scaffolded successfully
      const match = text.match(/Personality "([^"]+)" scaffolded successfully/);
      if (match?.[1]) return match[1];
    }
    return null;
  }, [state.messages]);

  const isComplete = !!scaffoldResult;

  return (
    <ConfigProvider theme={personalityTheme(ARCHITECT_ID)}>
      <div className="personality-create-wizard">
        <style>{`
          .personality-create-wizard {
            display: flex;
            flex-direction: column;
            height: 100%;
          }
          .personality-create-wizard .wizard-header {
            padding: 12px 16px;
            border-bottom: 1px solid var(--ethos-border);
            display: flex;
            align-items: center;
            justify-content: space-between;
          }
          .personality-create-wizard .wizard-header h3 {
            margin: 0;
          }
        `}</style>

        <div className="wizard-header">
          <Typography.Title level={4} style={{ margin: 0 }}>
            Personality Architect
          </Typography.Title>
          <Typography.Text type="secondary">
            {isComplete ? 'Complete' : 'Defining your personality'}
          </Typography.Text>
        </div>

        <MessageList messages={state.messages} currentTurn={state.currentTurn} />

        {isComplete ? (
          <Result
            status="success"
            title={`Personality "${scaffoldResult}" created`}
            subTitle="Your new personality is ready to use."
            extra={
              <Space>
                <Button
                  type="primary"
                  onClick={() => navigate(buildNewSessionPath(scaffoldResult))}
                >
                  Open Chat with new personality
                </Button>
                <Button onClick={() => navigate('/personalities')}>Back to Personalities</Button>
              </Space>
            }
          />
        ) : (
          <Composer
            personalityId={ARCHITECT_ID}
            disabled={state.isStreaming}
            onSend={sendMessage}
            placeholder={
              state.isStreaming
                ? 'Waiting for the architect...'
                : 'Describe the personality you want to create...'
            }
          />
        )}
      </div>
    </ConfigProvider>
  );
}
