/**
 * Python runtime shim for the framed stdio RPC transport (tools-as-code-api
 * Lane A). Runtime images are digest-pinned, so the shim is delivered at exec
 * time — `buildShimCommand('python')` embeds this source base64-encoded in a
 * `python3 -c` bootstrap argument (base64 is bash-single-quote-safe).
 *
 * The shim:
 *  1. emits a `hello` frame (protocol version handshake) on stdout,
 *  2. reads the `script` frame from stdin,
 *  3. spawns the script as a CHILD process whose stdout/stderr are pipes the
 *     shim wraps into `output` frames — the script can never write raw frames,
 *  4. bridges the script's `ethos.call(name, args)` (newline-delimited JSON
 *     over a dedicated pipe pair, fds passed via env) to `rpc_request` /
 *     `rpc_response` frames — one in-flight call at a time,
 *  5. exits with the script's exit code.
 *
 * Version literal note: PROTOCOL_VERSION below must match
 * RPC_PROTOCOL_VERSION in @ethosagent/execution-docker — a drift is caught at
 * the first handshake with an actionable RpcVersionMismatchError, which is
 * exactly what the handshake exists for.
 */

/** Script-visible client, written to `ethos.py` on the shim's PYTHONPATH. */
export const PYTHON_CLIENT_SOURCE: string = String.raw`import json as _json
import os as _os
import threading as _threading

_req = _os.fdopen(int(_os.environ['ETHOS_RPC_REQ_FD']), 'w')
_res = _os.fdopen(int(_os.environ['ETHOS_RPC_RES_FD']), 'r')
_lock = _threading.Lock()


def call(name, args=None):
    """Call a host-side agent tool. Blocks until the host answers; one
    in-flight call at a time (serialized v1 contract). Returns a dict:
    {'ok': True, 'value': ...} or {'ok': False, 'error': ..., 'code': ...}.
    Errors are data, never exceptions."""
    with _lock:
        _req.write(_json.dumps({'name': name, 'args': args if args is not None else {}}) + '\n')
        _req.flush()
        line = _res.readline()
    if not line:
        return {'ok': False, 'error': 'RPC channel closed', 'code': 'rpc_channel_closed'}
    return _json.loads(line)
`;

const PYTHON_SHIM_MAIN: string = String.raw`import json
import os
import subprocess
import sys
import tempfile
import threading

PROTOCOL_VERSION = 1
_in = sys.stdin.buffer
_out = sys.stdout.buffer
_out_lock = threading.Lock()


def _send(obj):
    body = json.dumps(obj).encode('utf-8')
    with _out_lock:
        _out.write(b'Content-Length: ' + str(len(body)).encode('ascii') + b'\r\n\r\n')
        _out.write(body)
        _out.flush()


def _read_frame():
    header = b''
    while not header.endswith(b'\r\n\r\n'):
        ch = _in.read(1)
        if not ch:
            return None
        header += ch
    length = None
    for line in header.split(b'\r\n'):
        if line.lower().startswith(b'content-length:'):
            length = int(line.split(b':', 1)[1].strip())
    if length is None:
        return None
    body = b''
    while len(body) < length:
        chunk = _in.read(length - len(body))
        if not chunk:
            return None
        body += chunk
    return json.loads(body.decode('utf-8'))


_send({'type': 'hello', 'version': PROTOCOL_VERSION})
_frame = _read_frame()
if not _frame or _frame.get('type') != 'script' or _frame.get('version') != PROTOCOL_VERSION:
    sys.stderr.write('ethos shim: bad or missing script frame\n')
    sys.exit(70)

_workdir = tempfile.mkdtemp(prefix='ethos-shim-')
_script_path = os.path.join(_workdir, '__ethos_script__.py')
with open(_script_path, 'w') as _f:
    _f.write(_frame.get('code', ''))
with open(os.path.join(_workdir, 'ethos.py'), 'w') as _f:
    _f.write(CLIENT_SRC)

_req_r, _req_w = os.pipe()
_res_r, _res_w = os.pipe()

_env = dict(os.environ)
_env['PYTHONPATH'] = _workdir + ((':' + _env['PYTHONPATH']) if _env.get('PYTHONPATH') else '')
_env['ETHOS_RPC_REQ_FD'] = str(_req_w)
_env['ETHOS_RPC_RES_FD'] = str(_res_r)

_child = subprocess.Popen(
    [sys.executable, _script_path],
    stdin=subprocess.DEVNULL,
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    env=_env,
    pass_fds=(_req_w, _res_r),
)
os.close(_req_w)
os.close(_res_r)


def _pump(stream, name):
    while True:
        data = stream.read1(65536)
        if not data:
            return
        _send({'type': 'output', 'stream': name, 'data': data.decode('utf-8', errors='replace')})


_t_out = threading.Thread(target=_pump, args=(_child.stdout, 'stdout'), daemon=True)
_t_err = threading.Thread(target=_pump, args=(_child.stderr, 'stderr'), daemon=True)
_t_out.start()
_t_err.start()

_req_file = os.fdopen(_req_r, 'r')
_res_file = os.fdopen(_res_w, 'w')


def _rpc_loop():
    next_id = 0
    for line in _req_file:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except ValueError:
            payload = {'ok': False, 'error': 'malformed RPC request', 'code': 'rpc_malformed'}
        else:
            next_id += 1
            _send({'type': 'rpc_request', 'id': next_id, 'name': req.get('name'), 'args': req.get('args')})
            resp = _read_frame()
            while resp is not None and resp.get('type') != 'rpc_response':
                resp = _read_frame()
            if resp is None:
                payload = {'ok': False, 'error': 'RPC channel closed', 'code': 'rpc_channel_closed'}
            else:
                payload = dict((k, v) for k, v in resp.items() if k not in ('type', 'id'))
        try:
            _res_file.write(json.dumps(payload) + '\n')
            _res_file.flush()
        except OSError:
            return


_t_rpc = threading.Thread(target=_rpc_loop, daemon=True)
_t_rpc.start()

_rc = _child.wait()
_t_out.join(timeout=5)
_t_err.join(timeout=5)
sys.exit(_rc)
`;

/**
 * Full shim source: the client injected as a Python string literal (via
 * JSON.stringify — a JSON string is a valid Python string literal for this
 * content) followed by the shim main. No nested-escaping games.
 */
export function pythonShimSource(): string {
  return `CLIENT_SRC = ${JSON.stringify(PYTHON_CLIENT_SOURCE)}\n${PYTHON_SHIM_MAIN}`;
}
