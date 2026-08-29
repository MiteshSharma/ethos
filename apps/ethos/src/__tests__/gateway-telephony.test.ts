import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Telephony's wiring rules inside `runGatewayStart` are startup-script shape,
// not a function anyone can call: booting the gateway needs adapters, SQLite
// files, a live LLM and a foreground process that never returns. So the
// invariants that MUST NOT drift are asserted against the source, the same way
// `daemon-free-smoke.test.ts` and `no-raw-fs.test.ts` assert theirs.
//
// Everything with a seam of its own is tested for real elsewhere:
// `sip-webhook-server.test.ts` drives the listener over a live socket, and
// `sip-inbound-dispatch.test.ts` drives the dispatch decisions with an
// in-memory call log.

const GATEWAY = readFileSync(join(import.meta.dirname, '..', 'commands', 'gateway.ts'), 'utf-8');

describe('gateway telephony wiring', () => {
  it('builds the SIP listener only behind a configured trunk AND a webhook secret', () => {
    // Absent config is a clean no-op: no listener, no dispatcher, no call log.
    // An unsigned webhook would be an open line anyone who learns the URL can
    // ring, so the secret is a precondition, not a nicety.
    expect(GATEWAY).toMatch(
      /if \(sipTrunkConfig && sipWebhookSecret && voiceStack && callLog\) \{/,
    );
    expect(GATEWAY).toMatch(/const sipWebhookSecret = sipTrunkConfig\?\.webhookSecret;/);
  });

  it('opens the call log only when a trunk is configured', () => {
    expect(GATEWAY).toMatch(
      /const callLog = sipTrunkConfig\s*\?\s*new SQLiteCallLog\(\{ path: join\(ethosDir\(\), 'calls\.db'\) \}\)\s*:\s*undefined;/,
    );
  });

  it('never registers a platform adapter for SIP', () => {
    // The `channel_filter` gate is FATAL for anything in `adapters[]`, and a
    // phone caller has no `ownerUserId` to filter on — the inbound hardening
    // gate is the filter for that surface. A call is not a chat platform.
    const block = GATEWAY.slice(
      GATEWAY.indexOf('Telephony — inbound SIP webhook'),
      GATEWAY.indexOf('Listening for messages.'),
    );
    expect(block.length).toBeGreaterThan(0);
    expect(block).not.toMatch(/adapters\.push|adapterMap\.set|buildAdapters/);
    expect(GATEWAY).toMatch(/NO PLATFORM ADAPTER IS REGISTERED FOR SIP/);
  });

  it('delivers call notices through notifyTracked, not a second send path', () => {
    // The summary is the only durable record of a call the operator did not
    // hear, so it rides the delivery ledger: `pending` before the platform call,
    // confirmed only on ok, redelivered by the existing boot sweep.
    const block = GATEWAY.slice(GATEWAY.indexOf('const onSipCall = createSipInboundHandler'));
    expect(block).toMatch(/notifyOwner: async \(text\) =>/);
    expect(block).toMatch(/gateway\.notifyTracked\(/);
  });

  it('defaults the mount path and the port, and honours the shared host var', () => {
    expect(GATEWAY).toMatch(/sipTrunkConfig\?\.webhookPath \?\? '\/sip\/inbound'/);
    expect(GATEWAY).toMatch(/Number\(process\.env\.ETHOS_SIP_WEBHOOK_PORT\) \|\| 3005/);
    expect(GATEWAY).toMatch(
      /const sipWebhookHost = process\.env\.ETHOS_SERVE_HOST \?\? '127\.0\.0\.1'/,
    );
  });

  it('does not collide with any other default listener port', () => {
    // Includes `ethos run-all`'s 3004: run-all SPAWNS the gateway, so a shared
    // default would EADDRINUSE on the most common supervised deployment.
    const runAll = readFileSync(join(import.meta.dirname, '..', 'commands', 'run-all.ts'), 'utf-8');
    const ports = [
      ...[...GATEWAY.matchAll(/process\.env\.ETHOS_\w*PORT\) \|\| (\d+)/g)].map((m) => m[1]),
      ...[...runAll.matchAll(/DEFAULT_HEALTH_PORT = (\d+)/g)].map((m) => m[1]),
    ];
    expect(new Set(ports).size).toBe(ports.length);
    expect(ports).toContain('3005');
  });

  it('closes the listener and the call log on shutdown', () => {
    const shutdown = GATEWAY.slice(GATEWAY.indexOf('const shutdown = async ()'));
    expect(shutdown).toMatch(/sipWebhookServer\?\.close\(\);/);
    expect(shutdown).toMatch(/callLog\?\.close\(\);/);
  });

  it('prunes ended call rows on the existing hourly retention timer', () => {
    expect(GATEWAY).toMatch(/callLog\?\.pruneEnded\(Date\.now\(\) - CALL_LOG_RETENTION_MS\)/);
    const timer = GATEWAY.slice(GATEWAY.indexOf('const retentionPruneTimer'));
    expect(timer.slice(0, 200)).toMatch(/pruneCallLog\(\);/);
  });

  it('warns once at startup when there is nowhere to deliver call summaries', () => {
    expect(GATEWAY).toMatch(/voice\.inbound\.owner is not set/);
  });

  it('forwards the named STT/TTS rosters to the Gateway', () => {
    // Until this landed, per-personality provider selection was live in
    // `buildVoiceStack` and inert on every channel.
    const stt = [...GATEWAY.matchAll(/sttProviderRoster: voiceConfig\.sttRoster/g)];
    const tts = [...GATEWAY.matchAll(/ttsProviderRoster: voiceConfig\.ttsRoster/g)];
    // Both Gateway constructions — the single-loop idle path and the multi-bot one.
    expect(stt).toHaveLength(2);
    expect(tts).toHaveLength(2);
  });
});
