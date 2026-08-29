/**
 * JS (Node) runtime shim for the framed stdio RPC transport (tools-as-code-api
 * Lane A). Delivered at exec time — `buildShimCommand('js')` embeds this
 * source base64-encoded in a `node -e` bootstrap argument — because runtime
 * images are digest-pinned and cannot carry a baked-in shim.
 *
 * Same shape as the Python shim: hello handshake, `script` frame in, child
 * process whose piped stdout/stderr become `output` frames (the script can
 * never write raw frames), and an `ethos.call(name, args)` client bridged over
 * dedicated stdio fds (3: requests child→shim, 4: responses shim→child) to
 * `rpc_request`/`rpc_response` frames. The client is installed via `--import`
 * as `globalThis.ethos`; `ethos.call` is synchronous-blocking (readSync), so
 * one in-flight call at a time is inherent.
 *
 * PROTOCOL_VERSION must match RPC_PROTOCOL_VERSION in
 * @ethosagent/execution-docker; drift is caught by the handshake.
 *
 * Style note: the shim sources deliberately avoid template literals — they are
 * embedded in String.raw blocks, so backticks and dollar-brace sequences are
 * off-limits.
 */

/** Script-visible client, written to a `--import`ed ESM file by the shim. */
export const JS_CLIENT_SOURCE: string = String.raw`import { readSync, writeSync } from 'node:fs';

const REQ_FD = 3;
const RES_FD = 4;
const sleepCell = new Int32Array(new SharedArrayBuffer(4));

// Call a host-side agent tool. Blocks until the host answers; one in-flight
// call at a time (inherent: the read is synchronous). Returns
// { ok: true, value } or { ok: false, error, code } — errors are data.
function call(name, args) {
  writeSync(REQ_FD, JSON.stringify({ name: name, args: args === undefined ? {} : args }) + '\n');
  let line = '';
  const buf = Buffer.alloc(65536);
  for (;;) {
    let n = 0;
    try {
      n = readSync(RES_FD, buf, 0, buf.length, null);
    } catch (err) {
      if (err && err.code === 'EAGAIN') {
        Atomics.wait(sleepCell, 0, 0, 5);
        continue;
      }
      return { ok: false, error: 'RPC channel closed', code: 'rpc_channel_closed' };
    }
    if (n === 0) return { ok: false, error: 'RPC channel closed', code: 'rpc_channel_closed' };
    line += buf.toString('utf-8', 0, n);
    const nl = line.indexOf('\n');
    if (nl >= 0) return JSON.parse(line.slice(0, nl));
  }
}

globalThis.ethos = { call: call };
`;

const JS_SHIM_MAIN: string = String.raw`'use strict';
var cp = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var PROTOCOL_VERSION = 1;

function send(obj) {
  var body = Buffer.from(JSON.stringify(obj), 'utf-8');
  process.stdout.write('Content-Length: ' + body.length + '\r\n\r\n');
  process.stdout.write(body);
}

var stdinBuf = Buffer.alloc(0);
var frameWaiters = [];
var pendingFrames = [];

process.stdin.on('data', function (c) {
  stdinBuf = Buffer.concat([stdinBuf, c]);
  for (;;) {
    var sep = stdinBuf.indexOf('\r\n\r\n');
    if (sep < 0) break;
    var header = stdinBuf.toString('ascii', 0, sep);
    var m = /Content-Length: (\d+)/.exec(header);
    if (!m) {
      process.stderr.write('ethos shim: malformed frame header\n');
      process.exit(70);
    }
    var len = parseInt(m[1], 10);
    var start = sep + 4;
    if (stdinBuf.length < start + len) break;
    var body = stdinBuf.slice(start, start + len);
    stdinBuf = stdinBuf.slice(start + len);
    var frame;
    try {
      frame = JSON.parse(body.toString('utf-8'));
    } catch (e) {
      process.stderr.write('ethos shim: frame payload is not valid JSON\n');
      process.exit(70);
    }
    var waiter = frameWaiters.shift();
    if (waiter) waiter(frame);
    else pendingFrames.push(frame);
  }
});

function nextFrame(cb) {
  var f = pendingFrames.shift();
  if (f) cb(f);
  else frameWaiters.push(cb);
}

send({ type: 'hello', version: PROTOCOL_VERSION });

nextFrame(function (frame) {
  if (!frame || frame.type !== 'script' || frame.version !== PROTOCOL_VERSION) {
    process.stderr.write('ethos shim: bad or missing script frame\n');
    process.exit(70);
  }
  main(frame.code || '');
});

function main(code) {
  var workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'ethos-shim-'));
  var scriptPath = path.join(workdir, '__ethos_script__.mjs');
  fs.writeFileSync(scriptPath, code);
  var registerPath = path.join(workdir, '__ethos_register__.mjs');
  fs.writeFileSync(registerPath, CLIENT_SRC);

  var child = cp.spawn(process.execPath, ['--import', 'file://' + registerPath, scriptPath], {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', function (c) {
    send({ type: 'output', stream: 'stdout', data: c.toString('utf-8') });
  });
  child.stderr.on('data', function (c) {
    send({ type: 'output', stream: 'stderr', data: c.toString('utf-8') });
  });

  var reqBuf = '';
  var nextId = 0;

  function handleRequest(line) {
    var req;
    try {
      req = JSON.parse(line);
    } catch (e) {
      try {
        child.stdio[4].write(
          JSON.stringify({ ok: false, error: 'malformed RPC request', code: 'rpc_malformed' }) +
            '\n',
        );
      } catch (e2) {}
      return;
    }
    nextId += 1;
    send({ type: 'rpc_request', id: nextId, name: req.name, args: req.args });
    nextFrame(function onFrame(frame) {
      if (frame.type !== 'rpc_response') {
        nextFrame(onFrame);
        return;
      }
      var payload = { ok: frame.ok, value: frame.value, error: frame.error, code: frame.code };
      try {
        child.stdio[4].write(JSON.stringify(payload) + '\n');
      } catch (e) {}
    });
  }

  child.stdio[3].on('data', function (c) {
    reqBuf += c.toString('utf-8');
    var nl;
    while ((nl = reqBuf.indexOf('\n')) >= 0) {
      var line = reqBuf.slice(0, nl);
      reqBuf = reqBuf.slice(nl + 1);
      if (line.trim()) handleRequest(line);
    }
  });

  child.on('close', function (rc) {
    // Flush queued stdout frames before exiting: the callback of a write
    // fires only after everything queued before it has drained.
    process.stdout.write('', function () {
      process.exit(rc === null ? 1 : rc);
    });
  });
}
`;

/** Full shim source: client injected as a JS string literal via JSON.stringify. */
export function jsShimSource(): string {
  return `var CLIENT_SRC = ${JSON.stringify(JS_CLIENT_SOURCE)};\n${JS_SHIM_MAIN}`;
}
