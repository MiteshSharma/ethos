// Owner-side pairing-flow commands shared between the chat REPL slash
// commands (/allow, /deny, /communications) and any future standalone
// CLI subcommand.
//
// Opens the same SQLite pairing DB the gateway writes to so the owner
// can manage approvals without going through Telegram/Discord/Slack
// directly. The DB lives at `~/.ethos/pairing.db` by convention; if it
// doesn't exist, every command returns "no pairing DB yet — start the
// gateway first" rather than silently no-oping.
//
// **CLAUDE.md Storage-abstraction exception (parallel to
// session-sqlite / memory-vector):** @ethosagent/sqlite opens raw paths
// and manages WAL/SHM natively, so it cannot be wrapped in the
// Storage interface used by markdown / config reads. The pairing
// store therefore reads `~/.ethos/pairing.db` via `node:fs.existsSync`
// + `new Database(path)` directly. The path is computed via
// `ethosDir()` (the same function every other command uses) so a
// future relocation flips one place, not many.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ethosDir } from '@ethosagent/config';
import Database from '@ethosagent/sqlite';
import {
  consumeAndAllow,
  getApprovedSenders,
  initPairingDb,
  revokeApproval,
} from '@ethosagent/wiring/security-kernel';

const SUPPORTED_PLATFORMS = ['telegram', 'discord', 'slack', 'whatsapp', 'email'];

interface PairingArgs {
  code?: string;
  platform?: string;
  senderId?: string;
}

function pairingDbPath(): string {
  return join(ethosDir(), 'pairing.db');
}

function openDb(): { ok: true; db: Database.Database } | { ok: false; reason: string } {
  const path = pairingDbPath();
  if (!existsSync(path)) {
    return {
      ok: false,
      reason: `no pairing DB at ${path} — start the gateway (\`ethos gateway\`) so it creates the DB.`,
    };
  }
  const db = new Database(path);
  initPairingDb(db);
  return { ok: true, db };
}

export async function runPairingCommand(
  cmd: 'allow' | 'deny' | 'list',
  args: PairingArgs,
): Promise<string> {
  const open = openDb();
  if (!open.ok) return open.reason;
  const { db } = open;

  try {
    if (cmd === 'allow') {
      if (!args.code) return 'missing code';
      const result = consumeAndAllow(db, args.code);
      if (result.ok) {
        return `approved sender ${result.senderId} on ${result.platform}`;
      }
      return `allow failed: ${result.reason}`;
    }

    if (cmd === 'deny') {
      if (!args.platform || !args.senderId) return 'missing platform / senderId';
      if (!SUPPORTED_PLATFORMS.includes(args.platform)) {
        return `unknown platform '${args.platform}' — expected one of ${SUPPORTED_PLATFORMS.join(', ')}`;
      }
      const removed = revokeApproval(db, args.senderId, args.platform);
      return removed
        ? `revoked ${args.senderId} on ${args.platform}`
        : `${args.senderId} was not on the approved list for ${args.platform}`;
    }

    if (cmd === 'list') {
      const lines: string[] = [];
      let pending = 0;
      for (const platform of SUPPORTED_PLATFORMS) {
        const approved = getApprovedSenders(db, platform);
        if (approved.length > 0) {
          lines.push(`${platform}: ${approved.length} approved (${approved.join(', ')})`);
        }
      }
      // Pending pairing-code count is a quick aggregate read.
      const pendingRow = db
        .prepare("SELECT COUNT(*) AS n FROM pairing_codes WHERE status = 'pending'")
        .get() as { n?: number } | undefined;
      pending = pendingRow?.n ?? 0;
      if (lines.length === 0 && pending === 0) {
        return 'no approved senders, no pending codes';
      }
      const summary = `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}pending pairing codes: ${pending}`;
      return summary;
    }

    return `unknown pairing command '${cmd}'`;
  } finally {
    db.close();
  }
}
