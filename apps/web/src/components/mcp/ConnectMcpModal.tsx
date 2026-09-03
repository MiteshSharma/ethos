import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Button, List, Modal, Space, Spin, Steps, Tag, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useMcpOAuthPopup } from '../../features/mcp/useMcpOAuthPopup';
import { rpc } from '../../rpc';

interface ConnectMcpModalProps {
  open: boolean;
  personalityId: string;
  existingServers: string[];
  onClose: () => void;
  onConnected: () => void;
}

/** This modal's own "select a server, then done" steps — the "connecting" /
 *  "oauth" steps in between are driven by `useMcpOAuthPopup`'s `phase`
 *  (plan/phases/mcp-inline-catalog.md §6 step 3), not tracked here. */
type LocalStep = 'select' | 'done';

type Step = LocalStep | 'connecting' | 'oauth';

export function ConnectMcpModal({
  open,
  personalityId,
  existingServers,
  onClose,
  onConnected,
}: ConnectMcpModalProps) {
  const qc = useQueryClient();
  const [localStep, setLocalStep] = useState<LocalStep>('select');
  const [selected, setSelected] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState('');

  // Fetch global server registry
  const { data: listData, isLoading: listLoading } = useQuery({
    queryKey: ['mcp', 'list'],
    queryFn: () => rpc.mcp.list(),
    enabled: open,
  });

  // Filter out already-attached servers
  const availableServers = (listData?.servers ?? []).filter(
    (s) => !existingServers.includes(s.name),
  );

  const finishConnect = () => {
    setLocalStep('done');
    qc.invalidateQueries({ queryKey: ['mcp', 'personalityServers', personalityId] });
    qc.invalidateQueries({ queryKey: ['personalities', 'get', personalityId] });
    onConnected();
  };

  const oauth = useMcpOAuthPopup({
    personalityId,
    onSuccess: () => finishConnect(),
    onError: (message) => {
      setErrorMsg(message);
      setLocalStep('select');
    },
  });

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setLocalStep('select');
      setSelected(null);
      setErrorMsg('');
    }
  }, [open]);

  // Add server to personality's mcp_servers
  const addMut = useMutation({
    mutationFn: (serverName: string) =>
      rpc.personalities.update({
        id: personalityId,
        mcp_servers: [...existingServers, serverName],
      }),
    onSuccess: (_result, serverName) => {
      // Check if this server needs OAuth
      const server = (listData?.servers ?? []).find((s) => s.name === serverName);
      // Non-OAuth servers (no url, or already authorized globally) -> done
      if (!server?.url || server.auth_status === 'authorized' || server.auth_status === 'none') {
        finishConnect();
        return;
      }
      // OAuth server - start auth flow
      oauth.start({
        url: server.url,
        name: serverName,
        returnPath: `/personalities/${personalityId}`,
      });
    },
    onError: (err) => {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    },
  });

  const handleSelect = (serverName: string) => {
    setSelected(serverName);
    setErrorMsg('');
    addMut.mutate(serverName);
  };

  const handleClose = () => {
    oauth.cancel();
    onClose();
  };

  const step: Step =
    oauth.phase === 'waiting' ? 'oauth' : oauth.phase === 'connecting' ? 'connecting' : localStep;

  const currentStepIndex =
    step === 'select' ? 0 : step === 'connecting' || step === 'oauth' ? 1 : 2;

  return (
    <Modal
      open={open}
      title="Connect MCP Server"
      onCancel={handleClose}
      footer={null}
      width={480}
      destroyOnClose
    >
      <Steps
        current={currentStepIndex}
        size="small"
        style={{ marginBottom: 24 }}
        items={[{ title: 'Select' }, { title: 'Authorize' }, { title: 'Done' }]}
      />

      {step === 'select' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          {errorMsg ? (
            <Alert type="error" message={errorMsg} closable onClose={() => setErrorMsg('')} />
          ) : null}

          {listLoading ? (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <Spin />
            </div>
          ) : availableServers.length === 0 ? (
            <Alert
              type="info"
              message="No servers available"
              description="Register one from the Plugins page first."
            />
          ) : (
            <List
              bordered
              size="small"
              dataSource={availableServers}
              renderItem={(server) => (
                <List.Item
                  actions={[
                    <Button
                      key="connect"
                      size="small"
                      type="primary"
                      loading={addMut.isPending && selected === server.name}
                      onClick={() => handleSelect(server.name)}
                    >
                      Connect
                    </Button>,
                  ]}
                >
                  <List.Item.Meta
                    title={
                      <span>
                        {server.name}
                        {server.transport ? (
                          <Tag bordered={false} style={{ fontSize: 11, marginLeft: 8 }}>
                            {server.transport}
                          </Tag>
                        ) : null}
                        {server.transport === 'sse' ? (
                          <Tag
                            color="warning"
                            bordered={false}
                            style={{ fontSize: 11, marginLeft: 4 }}
                          >
                            deprecated
                          </Tag>
                        ) : null}
                      </span>
                    }
                    description={
                      server.url ? (
                        <Typography.Text
                          type="secondary"
                          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
                        >
                          {server.url}
                        </Typography.Text>
                      ) : server.command ? (
                        <Typography.Text
                          type="secondary"
                          style={{ fontFamily: 'Geist Mono, monospace', fontSize: 11 }}
                        >
                          {server.command}
                        </Typography.Text>
                      ) : null
                    }
                  />
                </List.Item>
              )}
            />
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={handleClose}>Cancel</Button>
          </div>
        </Space>
      )}

      {step === 'connecting' && (
        <div style={{ textAlign: 'center', padding: '24px 0' }}>
          <Spin size="large" />
          <Typography.Paragraph style={{ marginTop: 16 }}>
            Starting OAuth flow...
          </Typography.Paragraph>
        </div>
      )}

      {step === 'oauth' && (
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <Alert
            type="info"
            message="Complete sign-in in the new window"
            description="We'll continue automatically when you return."
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button onClick={handleClose}>Cancel</Button>
          </div>
        </Space>
      )}

      {step === 'done' && (
        <Space direction="vertical" style={{ width: '100%', textAlign: 'center' }} size="middle">
          <Alert
            type="success"
            message={`${selected} connected`}
            description="The server is now attached to this personality."
          />
          <Button type="primary" onClick={handleClose}>
            Close
          </Button>
        </Space>
      )}
    </Modal>
  );
}
