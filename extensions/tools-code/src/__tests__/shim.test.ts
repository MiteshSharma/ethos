import { RPC_PROTOCOL_VERSION } from '@ethosagent/execution-docker';
import { describe, expect, it } from 'vitest';
import {
  buildShimCommand,
  JS_CLIENT_SOURCE,
  jsShimSource,
  PYTHON_CLIENT_SOURCE,
  pythonShimSource,
} from '../shim';

describe('buildShimCommand', () => {
  it('python: single-quote-safe bash command that decodes back to the shim source', () => {
    const cmd = buildShimCommand('python');
    const match =
      /^python3 -c 'import base64;exec\(compile\(base64\.b64decode\("([A-Za-z0-9+/=]+)"\),"<ethos-shim>","exec"\)\)'$/.exec(
        cmd,
      );
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match?.[1] ?? '', 'base64').toString('utf-8');
    expect(decoded).toBe(pythonShimSource());
  });

  it('js: single-quote-safe bash command that decodes back to the shim source', () => {
    const cmd = buildShimCommand('js');
    const match =
      /^node -e 'eval\(Buffer\.from\("([A-Za-z0-9+/=]+)","base64"\)\.toString\("utf-8"\)\)'$/.exec(
        cmd,
      );
    expect(match).not.toBeNull();
    const decoded = Buffer.from(match?.[1] ?? '', 'base64').toString('utf-8');
    expect(decoded).toBe(jsShimSource());
  });

  it('neither command contains a raw single quote inside the quoted payload', () => {
    for (const runtime of ['python', 'js'] as const) {
      const cmd = buildShimCommand(runtime);
      const firstQuote = cmd.indexOf("'");
      const lastQuote = cmd.lastIndexOf("'");
      expect(cmd.slice(firstQuote + 1, lastQuote)).not.toContain("'");
    }
  });
});

describe('shim protocol version drift gate', () => {
  // The shim carries its own PROTOCOL_VERSION literal (it is delivered as
  // source, not linked against the host). This pins it to the host's
  // RPC_PROTOCOL_VERSION so drift fails here before it fails at a handshake.
  it('python shim speaks the host protocol version', () => {
    expect(pythonShimSource()).toContain(`PROTOCOL_VERSION = ${RPC_PROTOCOL_VERSION}`);
  });

  it('js shim speaks the host protocol version', () => {
    expect(jsShimSource()).toContain(`var PROTOCOL_VERSION = ${RPC_PROTOCOL_VERSION};`);
  });
});

describe('shim client injection', () => {
  it('python shim embeds the client verbatim as CLIENT_SRC', () => {
    expect(pythonShimSource()).toContain(`CLIENT_SRC = ${JSON.stringify(PYTHON_CLIENT_SOURCE)}`);
    expect(PYTHON_CLIENT_SOURCE).toContain('def call(name, args=None):');
  });

  it('js shim embeds the client verbatim as CLIENT_SRC', () => {
    expect(jsShimSource()).toContain(`var CLIENT_SRC = ${JSON.stringify(JS_CLIENT_SOURCE)};`);
    expect(JS_CLIENT_SOURCE).toContain('globalThis.ethos = { call: call };');
  });

  it('shim sources avoid template-literal hazards (String.raw safety)', () => {
    for (const src of [pythonShimSource(), jsShimSource()]) {
      expect(src).not.toContain('`');
      expect(src).not.toContain('${');
    }
  });
});
