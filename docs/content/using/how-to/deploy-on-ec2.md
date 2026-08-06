---
title: "Deploy Ethos on AWS EC2"
description: "One EC2 instance, one EBS volume, one systemd unit. The simplest production deployment of Ethos on AWS — no load balancer, no Route 53, no certificate."
kind: how-to
audience: user
slug: deploy-on-ec2
time: "15 min"
updated: 2026-05-17
---

## Task

Run Ethos as a single always-on EC2 instance with persistent state, surviving reboots and instance replacement. Architecture is deliberately small: **one EC2 + one EBS volume + one systemd unit**. No load balancer, no public DNS, no certificate.

## Result

- Telegram + Slack + Discord + Email bots online 24/7.
- State (sessions, memory, config) on a separate EBS volume — AMI swaps don't lose data.
- AWS Backup takes daily snapshots; recover by re-attaching the volume.
- ~$13/month for `t4g.small` + 10 GB `gp3` + outbound LLM-API traffic.

For the architecture explainer (why these processes, why this shape), see [Deploy in production](deploy-in-production.md). This page is the AWS-specific recipe.

## Prereqs

- AWS account; permission to launch EC2 instances + create EBS volumes + create IAM roles.
- One LLM provider API key, and at least one channel token (Telegram from BotFather, Slack bot token, etc.).
- Decide how you'll connect:
  - **SSM Session Manager (recommended)** — no SSH key, no port 22, no public IP needed. Requires an IAM role on the instance with the `AmazonSSMManagedInstanceCore` managed policy, and `session-manager-plugin` installed on your laptop ([AWS install instructions](https://docs.aws.amazon.com/systems-manager/latest/userguide/session-manager-working-with-install-plugin.html)).
  - **SSH** — works fine. Generate an EC2 key pair, open port 22 to your IP, the rest is the same.

**OS choice** is a recommendation, not a requirement. The canonical script targets **Amazon Linux 2023** (default AWS AMI, dnf-based, SSM agent preinstalled). Ubuntu 24.04 also works — the script's package commands are the only thing you'd swap. Any Linux that can run Node 24 fits.

## Steps

### 1. Launch the instance

In the EC2 console → **Launch instance** → fill in:

| Field | Value | Why |
|---|---|---|
| **Name** | `ethos` | identification |
| **AMI** | Amazon Linux 2023 (default) | matches the bootstrap script |
| **Instance type** | `t4g.small` (~$12/mo) | ARM, plenty for 1–2 bots; bump to `t4g.medium` for many personalities |
| **Key pair** | leave blank (SSM) or pick one (SSH) | your choice per Prereqs |
| **Network** | default VPC, any subnet, auto-assign public IPv4 ON | gateway dials out; public IP is only needed for outbound (no inbound rules) |
| **Security group** | new SG, **inbound: none** (SSM) or **SSH from your IP** | zero inbound is the goal — gateway is dial-out only |
| **Storage** | root: 8 GB gp3 (default); **add second volume**: 10 GB gp3, mount `/dev/sdf`, **Encrypted: yes** | state on its own encrypted volume — see [Security](#security) |
| **Advanced → IAM instance profile** | role with `AmazonSSMManagedInstanceCore` (SSM only) | enables SSM Session Manager; skip if using SSH |
| **Advanced → Metadata version** | V2 only (required) | IMDSv2 — see [Security](#security) |
| **Advanced → User data** | paste the [bootstrap script](#the-bootstrap-script) | runs once on first boot |

Launch it. The bootstrap takes ~3 minutes; watch progress with **EC2 → Instance → Actions → Monitor and troubleshoot → Get system log**.

### 2. The bootstrap script {#the-bootstrap-script}

The canonical script lives at [scripts/ec2-bootstrap.sh](https://github.com/ethosagent/ethos/blob/main/scripts/ec2-bootstrap.sh) in the repo. Paste its contents into the **User data** field at launch — or fetch it locally first if you want to review or modify:

```bash
curl -O https://ethosagent.ai/ec2-bootstrap.sh
# review, then paste into User data
```

It installs Node 24, creates the `ethos` service user, mounts state at `/var/lib/ethos`, installs `@ethosagent/cli`, and drops in a systemd unit. The unit is **not enabled yet** — you run `ethos setup` first, then enable.

### 3. Mount the EBS state volume

Once the instance is up, attach the 10 GB volume you created to `/var/lib/ethos`. The user-data script created that path empty; you mount the EBS device on top:

```bash
# inside the instance (SSM Session Manager or ssh)
sudo mkfs -t xfs /dev/nvme1n1    # one-time format; nvme1n1 is the second volume
sudo mount /dev/nvme1n1 /var/lib/ethos
sudo chown -R ethos:ethos /var/lib/ethos

# persist across reboots
echo "/dev/nvme1n1 /var/lib/ethos xfs defaults,nofail 0 2" | sudo tee -a /etc/fstab
```

(The device name may be `xvdf` on older instance types; `lsblk` tells you what's actually there.)

### 4. Connect and run `ethos setup`

**With SSM Session Manager:**

```bash
aws ssm start-session --target i-0123456789abcdef0
```

**With SSH:**

```bash
ssh -i ~/.ssh/your-key.pem ec2-user@<public-ip-or-dns>
```

Either way, become the `ethos` user and run setup:

```bash
sudo -iu ethos
ethos setup
```

The wizard asks for your LLM provider + key, picks a default personality, and walks through Telegram / Slack / Discord / Email tokens for whichever channels you want. Everything lands in `~/.ethos/config.yaml` — which actually lives on the encrypted EBS state volume.

Foreground-test before enabling the service:

```bash
ethos gateway start
# DM your bot, confirm a reply, Ctrl+C
exit       # back to your shell user
```

### 5. Enable the service

```bash
sudo systemctl enable --now ethos
sudo systemctl status ethos
```

`enable --now` starts the service and wires it to launch at boot. The service runs `ethos gateway start` as the `ethos` user.

Verify:

- Send a DM to your bot — it replies.
- `journalctl -u ethos -f` — streams the gateway's logs.
- Reboot the instance (`sudo reboot`). Reconnect. `systemctl status ethos` shows `active (running)` — no manual intervention needed.

### 6. Set up AWS Backup for the state volume

Daily EBS snapshots cover the "I accidentally `rm -rf ~/.ethos`" and "the instance was terminated" cases.

In the AWS Backup console:

1. **Backup plans → Create backup plan → Start with a template → Daily backups**.
2. **Resource assignments → Resources** → tag-based selection (tag the EBS volume with `backup: daily`).
3. Retention: 7 days is plenty for state recovery; bump to 30 if your compliance posture wants it.

That's it. AWS Backup takes encrypted snapshots inheriting the volume's encryption.

## Verify

Confirm the deployment is healthy after the steps above:

- **Bot replies.** DM your Telegram bot (or `@mention` in Slack). Reply lands within a few seconds.
- **Service active + enabled.** `sudo systemctl status ethos` shows `active (running)` and `enabled` (will start on boot).
- **Logs stream.** `journalctl -u ethos -f` shows the gateway's startup banner and per-turn output.
- **State volume mounted.** `df -h /var/lib/ethos` shows the EBS device (not the root volume). `ls -la /home/ethos/.ethos` shows the symlink target.
- **Reboot survival.** `sudo reboot`, reconnect (SSM or SSH), `systemctl status ethos` shows `active (running)` again with no manual intervention.
- **Backup ran.** AWS Backup console → Jobs tab → daily snapshot of the state volume appears within 24h of plan creation.

If any of these fail, jump to [Troubleshoot](#troubleshoot) below.

## Run the web dashboard too (optional)

The default deployment is **gateway-only** — no inbound port, no dashboard, the simplest case. To also run the web dashboard + ACP server, swap the systemd unit's `ExecStart`:

```bash
sudo sed -i 's|ethos gateway start|ethos run-all|' /etc/systemd/system/ethos.service
sudo systemctl daemon-reload
sudo systemctl restart ethos
```

Now `ethos run-all` is supervising both `gateway start` and `serve`. The dashboard binds to `localhost:3000` on the instance. Reach it from your laptop without ever opening the port to the internet:

**Via SSH tunnel:**

```bash
ssh -L 3000:localhost:3000 ec2-user@<public-ip>
# now browse http://localhost:3000 on your laptop
```

**Via SSM port forwarding** (no SSH key needed):

```bash
aws ssm start-session --target i-0123456789abcdef0 \
  --document-name AWS-StartPortForwardingSession \
  --parameters '{"portNumber":["3000"],"localPortNumber":["3000"]}'
# browse http://localhost:3000 on your laptop
```

Same security posture either way — the dashboard is never reachable from the public internet, only through your authenticated tunnel.

## Security

A short list of zero- and low-cost wins, all baked into the steps above:

- **Encrypted EBS state volume.** Step 1 sets `Encrypted: yes` on the 10 GB state volume. Everything sensitive — `~/.ethos/config.yaml` (provider keys, bot tokens), `sessions.db` (every conversation), `memory/` files — lives on this volume and is encrypted at rest. AWS Backup snapshots inherit the encryption.
- **IMDSv2 required.** Step 1 sets `Metadata version: V2 only`. Stops a class of SSRF-into-AWS-credentials exploits where a misbehaving tool fetches `http://169.254.169.254/latest/meta-data/iam/security-credentials/` — V2 requires a session token most exploit paths can't forge.
- **Zero inbound traffic** by default. The gateway is dial-out (Telegram long-polls, Slack uses Socket Mode). The security group has no inbound rules unless you choose SSH. SSM Session Manager doesn't open a port at all.
- **Least-privilege IAM role.** The instance role only needs `AmazonSSMManagedInstanceCore` for Session Manager. Don't attach an admin role; you don't need one.
- **`ethos` service user, not root.** The systemd unit runs as `User=ethos`. Even if a tool the agent runs escapes its boundary, it doesn't escape to root.

What this deployment shape deliberately *doesn't* solve, and what to add if you need them:

- **Secrets at rest while the instance is running** — encrypted volume protects against snapshot theft, not a logged-in root user. See [Configure AWS Secrets Manager](configure-aws-secrets.md) to fetch tokens from AWS at runtime instead of storing them on the EBS volume.
- **Public dashboard with auth** — out of scope. The tunnel approach above is the right answer until you have a reason to expose the dashboard, at which point you want a reverse proxy + a real auth story, not just port-opening.

## Operate

| What | Command |
|---|---|
| Stream gateway logs | `journalctl -u ethos -f` |
| Restart the service | `sudo systemctl restart ethos` |
| Stop / start | `sudo systemctl stop ethos` / `sudo systemctl start ethos` |
| Status + last 10 log lines | `sudo systemctl status ethos` |
| Upgrade | `sudo -iu ethos ethos upgrade && sudo systemctl restart ethos` |
| Talk to the agent from your laptop | SSM/SSH in, run `ethos chat` (uses its own session lane, doesn't collide with the bots) |

State volume layout reminder:

```
/var/lib/ethos/                ← EBS volume mount, owned by ethos
├── config.yaml                ← tokens + provider keys
├── personalities/<id>/        ← personality definitions + per-personality memory
├── sessions.db                ← every conversation ever
├── logs/{gateway,serve}.log   ← per-child logs (if using run-all)
└── ...
```

Operator's laptop story: `ethos chat` on your laptop uses its own `~/.ethos/` (totally separate state), and the bots running on the EC2 box keep going whether your laptop is open or not. To chat with the *same* agent state the bots use, SSM/SSH in and run `ethos chat` on the instance.

## Troubleshoot

| Symptom | Cause | Fix |
|---|---|---|
| Bootstrap script failed with `gyp ERR! build error` | A native dependency failed to compile | Install build tools: `dnf groupinstall "Development Tools"` (AL2023) or `sudo apt-get install build-essential` (Debian/Ubuntu), then re-run `pnpm install` |
| `ethos: command not found` after `sudo -iu ethos` | PATH not picked up from `.bashrc` | Run `source ~/.bashrc` once, or use the absolute path: `/home/ethos/.npm-global/bin/ethos setup` |
| `systemctl status ethos` shows `failed` with `Run ethos setup first` | The unit started before tokens were configured | `sudo -iu ethos && ethos setup`, then `sudo systemctl restart ethos` |
| SSM session won't start | Missing IAM role / SSM agent not running | Confirm `AmazonSSMManagedInstanceCore` is attached; on AL2023 SSM is preinstalled. On Ubuntu, `sudo snap install amazon-ssm-agent --classic`. |
| State lost after instance replacement | EBS volume wasn't separate / wasn't attached to the new instance | Step 1's "second volume mounted at `/var/lib/ethos`" is the load-bearing call. AWS Backup snapshots are the recovery path. |
| Telegram bot stops responding but `systemctl status ethos` shows `active` | Token revoked, or Telegram API blocked | `journalctl -u ethos -n 100` — the error is usually one line. Fix the token in `~/.ethos/config.yaml`, restart. |
| `ethos upgrade` says "command not found: npm" | Bare `sudo -u ethos ethos upgrade` (without `-i`); login shell wasn't sourced | Always use `sudo -iu ethos ethos upgrade` — the `-i` is what loads PATH and HOME correctly |

For everything else: `journalctl -u ethos -n 200`, `ethos doctor`, [Troubleshooting reference](../../troubleshooting.md).

## What you learned

- One EC2 + one EBS + one systemd unit is the whole AWS architecture for a single-operator Ethos deployment.
- The bootstrap script automates the fragile bits (Node version, build tools, service user, systemd wiring).
- State on a separate encrypted EBS volume + AWS Backup snapshots = upgrade-safe and recoverable.
- Web dashboard runs the same way — flip the systemd unit to `ethos run-all`, reach it via SSH tunnel or SSM port forwarding.

## Next step

- [Deploy in production](deploy-in-production.md) — the platform-neutral architecture for context.
- [Run multiple Telegram bots from one gateway](run-multi-bot-telegram.md) — one EC2 instance, several personalities, several bots.
- [Run a team with kanban](run-a-team-with-kanban.md) — multi-personality teams that coordinate on this same box.
