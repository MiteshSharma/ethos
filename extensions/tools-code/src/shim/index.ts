import { jsShimSource } from './js-shim';
import { pythonShimSource } from './python-shim';

export { JS_CLIENT_SOURCE, jsShimSource } from './js-shim';
export { PYTHON_CLIENT_SOURCE, pythonShimSource } from './python-shim';

/**
 * Runtimes with a framed-RPC shim. `bash` is deferred: without a helper
 * binary in the (digest-pinned, unmodifiable) images there is no clean way to
 * give bash a blocking JSON client, and a python/node-backed `ethos-call`
 * helper would just be one of these shims in a trench coat.
 */
export type ShimRuntime = 'python' | 'js';

/**
 * Build the exec command that launches a runtime with the RPC shim as its
 * entry (tools-as-code-api Lane A). Runtime images are digest-pinned, so the
 * shim cannot live in the image — it is embedded base64-encoded in the
 * interpreter's `-c`/`-e` argument. Base64's alphabet (A-Za-z0-9+/=) is safe
 * inside the single-quoted string this becomes under the backend's
 * `bash -lc`, so there are no quoting edge cases.
 *
 * The returned command reads the script itself from a `script` frame on stdin
 * (written by the docker backend when `ExecOpts.rpc` is present) — pass the
 * script via `ExecOpts.stdin` exactly as for the unframed runtimes.
 */
export function buildShimCommand(runtime: ShimRuntime): string {
  if (runtime === 'python') {
    const b64 = Buffer.from(pythonShimSource(), 'utf-8').toString('base64');
    return `python3 -c 'import base64;exec(compile(base64.b64decode("${b64}"),"<ethos-shim>","exec"))'`;
  }
  const b64 = Buffer.from(jsShimSource(), 'utf-8').toString('base64');
  return `node -e 'eval(Buffer.from("${b64}","base64").toString("utf-8"))'`;
}
