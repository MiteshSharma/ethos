// Execution — the deployment's single remote target
// (plan/phases/remote-execution-routing.md §6, T7).
//
// STATUS-FIRST, and the status is the probe. The header says whether this
// machine can reach the host that `execution: ssh` personalities run their
// terminal on, right now; the posture line under it says who routes there; the
// `execution.ssh.*` fields sit below as ordinary page-Save `SettingRow`s.
//
// Every state the header can be in is a `ui/FeedbackRow` — the same row the
// chat trail draws (feedback & activity contract §6). No second status
// vocabulary invented for settings, no toast: the outcome resolves the row in
// place and stays (§7). The connection dot beside it is `aria-hidden` and
// carries nothing on its own; the row's glyph and WORD carry the state, which
// is the whole reason a colour-blind operator can read this page.
//
// Not configured is NOT an error. A fresh install has no remote target — that
// is the default, not a fault — so the row is `unrecorded` (`– unrecorded`,
// the row's own reading colour, "neither a tick nor a cross") beside a hollow
// dot, and nothing on this page is red until something actually fails.
//
// `backend_unresolved` is the boot failure seen from here: the ssh backend
// could not be CONSTRUCTED, so no connection was attempted and calling it
// unreachable would blame the network for a deployment fault. The admin status
// panel carries the same fact as its own `--error` row.
//
// `stale_config` is the edit-after-boot state: the fields below have been
// changed and saved, but the backend the tools run on was built at startup and
// still dials the OLD machine. Neither host was contacted, so it is neither
// `ok` nor `failed` — it is `⚠ unverified`, the row's existing word for "no
// verdict was reached", beside the hollow dot that says nothing was dialled.
// The sentence leads with the operationally important half: where tools are
// STILL running.

import { Button, Form, Input, InputNumber, Select } from 'antd';
import { FeedbackRow } from '../../../components/ui/FeedbackRow';
import { useSshProbe } from '../../../features/settings/api/execution';
import type { RowStatus } from '../../../lib/trail';
import type { rpc } from '../../../rpc';
import { AdvancedBlock } from '../components/advanced';
import { SectionHeading } from '../components/section-heading';
import { SettingRow } from '../components/setting-row';

type ProbeResult = Awaited<ReturnType<typeof rpc.execution.probeSsh>>;
type ProbeState = ProbeResult['result'];

// ---------------------------------------------------------------------------
// Pure view logic — exported so every state is testable without a click
// ---------------------------------------------------------------------------

/** How the connection dot is drawn. The dot is decoration; the word is the
 *  state. `hollow` is a ring with no fill — an absence, never a failure. */
export type DotTone = 'hollow' | 'probing' | 'reachable' | 'unreachable';

export interface ProbeHeaderView {
  status: RowStatus;
  dot: DotTone;
  subject: string;
  result?: string;
  meta?: string;
}

/**
 * The header row for one probe answer. `probing` is a client-side state — the
 * request is in flight — so it is passed separately rather than smuggled into
 * the wire union as a state the server can never return.
 */
export function probeHeaderView(state: ProbeState | undefined, probing: boolean): ProbeHeaderView {
  if (probing) {
    return {
      status: 'running',
      dot: 'probing',
      subject: 'ssh',
      result:
        state && state.state !== 'not_configured'
          ? `Testing ${state.target}…`
          : 'Testing connection…',
    };
  }
  if (!state) {
    // Before the first answer lands. Not a failure and not an absence of a
    // target — just nothing known yet, which is what `–` says.
    return { status: 'unrecorded', dot: 'hollow', subject: 'ssh', result: 'Reading config…' };
  }
  switch (state.state) {
    case 'not_configured':
      return {
        status: 'unrecorded',
        dot: 'hollow',
        subject: 'ssh',
        result: 'Not configured — add a host below',
      };
    case 'reachable':
      return {
        status: 'ok',
        dot: 'reachable',
        subject: state.target,
        meta: `${state.latencyMs} ms`,
      };
    case 'unreachable':
      // VERBATIM. `Permission denied (publickey)` and `Connection timed out`
      // need different fixes and only the real line says which, so nothing here
      // summarises, re-words or sentence-cases it.
      return { status: 'failed', dot: 'unreachable', subject: state.target, result: state.error };
    case 'backend_unresolved':
      return {
        status: 'failed',
        dot: 'unreachable',
        subject: state.target,
        // The plan's boot-failure sentence, plus the reason. No connection was
        // attempted, so this must never read as `unreachable`.
        result: `Execution backend ssh failed to resolve — ${state.error}`,
      };
    case 'stale_config':
      return {
        status: 'unverified',
        dot: 'hollow',
        // `ssh`, not a host: naming one would imply it was the one contacted,
        // and neither was. The sentence names both, and says which is live.
        subject: 'ssh',
        result:
          `Tools still run on ${state.activeTarget} — configuration changed to ${state.target} ` +
          'since this process started. Restart to apply. Neither host was contacted.',
      };
  }
}

/** `ssh — used by: remote-hands`, or the honest absence of a consumer. */
export function postureLine(usedBy: readonly string[]): string {
  if (usedBy.length === 0) return 'ssh — used by: no personality declares execution: ssh';
  return `ssh — used by: ${usedBy.join(', ')}`;
}

// ---------------------------------------------------------------------------

export function ExecutionPane() {
  const probe = useSshProbe();
  const probing = probe.isFetching;
  const view = probeHeaderView(probe.data?.result, probing);

  return (
    <>
      <SectionHeading id="status">status</SectionHeading>
      <div className="settings-execution-header">
        <div className="settings-execution-header-status">
          <div className="settings-execution-anchor">
            <span
              className={`settings-execution-dot settings-execution-dot--${view.dot}`}
              aria-hidden="true"
            />
            <FeedbackRow
              status={view.status}
              subject={view.subject}
              {...(view.result ? { result: view.result } : {})}
              {...(view.meta ? { meta: view.meta } : {})}
            />
          </div>
          <div className="settings-execution-posture">{postureLine(probe.data?.usedBy ?? [])}</div>
        </div>
        <div className="settings-execution-header-action">
          <Button
            type="primary"
            disabled={probing}
            onClick={() => void probe.refetch()}
            style={{ minHeight: 44 }}
            className="settings-execution-test"
          >
            {probing ? 'Testing…' : 'Test connection'}
          </Button>
        </div>
      </div>
      {probe.error ? (
        <FeedbackRow
          status="failed"
          subject="execution.probeSsh"
          result={(probe.error as Error).message}
        />
      ) : null}

      <SectionHeading id="remote-target">remote target</SectionHeading>
      <div className="settings-execution-help">
        One target per deployment. A personality routes to it by declaring{' '}
        <span className="settings-execution-mono">execution: ssh</span>; without a host here, that
        personality has nowhere to run. Authentication is a key <em>path</em> or a running ssh-agent
        — no passphrase is stored.
      </div>

      <SettingRow
        label="Remote host"
        formName="executionSsh.host"
        help="Hostname or IP of the machine remote commands run on (execution.ssh.host). Blank = no remote execution on this deployment."
      >
        <Form.Item name={['executionSsh', 'host']} style={{ marginBottom: 0 }}>
          <Input placeholder="build-01.internal" />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Remote user"
        formName="executionSsh.user"
        help="Account to connect as (execution.ssh.user). Blank = ssh's own default, which is your local username."
      >
        <Form.Item name={['executionSsh', 'user']} style={{ marginBottom: 0 }}>
          <Input placeholder="deploy" />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Remote port"
        formName="executionSsh.port"
        help="TCP port sshd listens on (execution.ssh.port). Blank = 22."
      >
        <Form.Item name={['executionSsh', 'port']} style={{ marginBottom: 0 }}>
          <InputNumber min={1} max={65535} precision={0} style={{ width: '100%' }} />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Identity file"
        formName="executionSsh.identityFile"
        help="Path to the private key ssh should use (execution.ssh.identityFile). Blank = whatever a running ssh-agent offers. The path is stored, never the key."
      >
        <Form.Item name={['executionSsh', 'identityFile']} style={{ marginBottom: 0 }}>
          <Input placeholder="~/.ssh/id_ed25519" />
        </Form.Item>
      </SettingRow>

      <SettingRow
        label="Remote working directory"
        formName="executionSsh.remoteWorkdir"
        help="Directory remote commands start in (execution.ssh.remoteWorkdir). Blank = the remote login directory. This machine's working directory is never sent."
      >
        <Form.Item name={['executionSsh', 'remoteWorkdir']} style={{ marginBottom: 0 }}>
          <Input placeholder="/srv/work" />
        </Form.Item>
      </SettingRow>

      <AdvancedBlock>
        <SettingRow
          label="Known-hosts file"
          formName="executionSsh.knownHostsFile"
          help="Host-key store for this target (execution.ssh.knownHostsFile). Blank = ssh's own default."
        >
          <Form.Item name={['executionSsh', 'knownHostsFile']} style={{ marginBottom: 0 }}>
            <Input placeholder="~/.ssh/known_hosts_ethos" />
          </Form.Item>
        </SettingRow>
        <SettingRow
          label="Host-key checking"
          formName="executionSsh.strictHostKeys"
          help="StrictHostKeyChecking for this target (execution.ssh.strictHostKeys). accept-new trusts a first-seen key and refuses a changed one; yes refuses anything not already known."
        >
          <Form.Item name={['executionSsh', 'strictHostKeys']} style={{ marginBottom: 0 }}>
            <Select
              allowClear
              placeholder="Backend default"
              options={[
                { value: 'accept-new', label: 'accept-new' },
                { value: 'yes', label: 'yes' },
              ]}
            />
          </Form.Item>
        </SettingRow>
      </AdvancedBlock>
    </>
  );
}
