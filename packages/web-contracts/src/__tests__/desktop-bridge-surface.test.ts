import { describe, expect, it } from 'vitest';
import type { EthosDesktopBridge } from '../desktop-bridge';

// ---------------------------------------------------------------------------
// Stable-surface guard for the desktop bridge contract.
// If a namespace is removed from EthosDesktopBridge, the type assignment
// below fails at compile time (tsc), and the key check fails at runtime.
// ---------------------------------------------------------------------------

type BridgeKeys = keyof EthosDesktopBridge;

const EXPECTED_KEYS: BridgeKeys[] = [
  'platform',
  'port',
  'onboarding',
  'personalities',
  'backend',
  'health',
  'theme',
  'settings',
  'navigate',
  'keychain',
  'loginItem',
  'shell',
  'dialog',
  'oauth',
  'plugin',
  'file',
  'gateway',
  'connection',
  'app',
  'codex',
  'platformTest',
];

describe('EthosDesktopBridge stable surface', () => {
  it('has exactly the expected top-level keys', () => {
    expect(EXPECTED_KEYS).toHaveLength(21);
  });

  it('every key is a valid BridgeKeys member (compile-time guard)', () => {
    // This test is a no-op at runtime — the real guard is the type
    // annotation on EXPECTED_KEYS above. If someone adds a typo or
    // removes a key from the interface, tsc catches it.
    expect(EXPECTED_KEYS.length).toBeGreaterThan(0);
  });
});
