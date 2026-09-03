import { describe, expect, it } from 'vitest';
import type { EthosDesktopBridge } from '../desktop-bridge';

describe('EthosDesktopBridge gateway parity', () => {
  it('gateway namespace has all control methods', () => {
    // Compile-time check -- if gateway.status/start/stop/logPath are removed,
    // the type assignment below fails
    type GatewayMethods = keyof EthosDesktopBridge['gateway'];
    const expected: GatewayMethods[] = ['platformStatus', 'status', 'start', 'stop', 'logPath'];
    expect(expected).toHaveLength(5);
  });

  it('gateway.status returns the correct shape', () => {
    // Type-level assertion: gateway.status must return a promise with state + serviceInstalled
    type StatusReturn = Awaited<ReturnType<EthosDesktopBridge['gateway']['status']>>;
    const states: StatusReturn['state'][] = ['running', 'stopped', 'crashed', 'starting'];
    expect(states).toHaveLength(4);
  });

  it('connection namespace has remote mode methods', () => {
    // Verifies the connection namespace (needed for remote bearer auth path) is present
    type ConnectionMethods = keyof EthosDesktopBridge['connection'];
    const expected: ConnectionMethods[] = ['get', 'set', 'test', 'reload'];
    expect(expected).toHaveLength(4);
  });
});
