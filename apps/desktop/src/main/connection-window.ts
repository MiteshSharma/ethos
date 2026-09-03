import { BrowserWindow } from 'electron';
import { normalizeRemoteUrl, testConnection } from './connection';

export type ConnectionChoice = { mode: 'local' } | { mode: 'remote'; url: string; token: string };

interface FormValues {
  mode: 'local' | 'remote';
  url: string;
  token: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function buildHtml(opts: { url?: string; message?: string }): string {
  const remoteFirst = opts.url !== undefined || opts.message !== undefined;
  const notice = opts.message ? `<p class="notice">${escapeHtml(opts.message)}</p>` : '';
  const urlValue = opts.url ? ` value="${escapeHtml(opts.url)}"` : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>ethos</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1A1A1A;color:#E8E8E6;font-family:'Geist',system-ui,sans-serif;
padding:0 24px 20px;display:flex;flex-direction:column;height:100vh;overflow:hidden;
-webkit-app-region:no-drag;user-select:none}
.bar{-webkit-app-region:drag;cursor:default;user-select:none;
margin:0 -24px 5px;padding:24px 24px 12px;border-bottom:1px solid #2A2A2A}
h1{font-size:20px;font-weight:600;letter-spacing:-0.01em}
.sub{font-size:13px;color:#9A9A98;line-height:1.45;margin:6px 0 0}
.notice{font-size:13px;color:#F87171;line-height:1.45;margin:12px 0 0}
main{flex:1;overflow-y:auto}
.opt{display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border:1px solid #2A2A2A;
border-radius:4px;cursor:pointer;margin-bottom:8px}
.opt.sel{border-color:#4A9EFF;background:rgba(74,158,255,0.10)}
.opt input{margin-top:3px;accent-color:#4A9EFF}
.name{display:block;font-size:14px;font-weight:500}
.desc{display:block;font-size:13px;color:#9A9A98;line-height:1.4;margin-top:2px}
#remote{margin-top:14px}
#remote[hidden]{display:none}
.fl{display:block;font-family:'Geist Mono',monospace;font-size:11px;letter-spacing:0.08em;
color:#9A9A98;margin-bottom:5px}
input[type=text],input[type=password]{width:100%;background:#0F0F0F;border:1px solid #3A3A3A;
border-radius:4px;color:#E8E8E6;font-family:'Geist Mono',monospace;font-size:13px;
padding:7px 10px;margin-bottom:12px;user-select:text}
input::placeholder{color:#6B6B6A}
.help{font-size:12px;color:#6B6B6A;line-height:1.45}
.actions{display:flex;align-items:center;gap:10px;margin-top:14px}
.res{flex:1;font-family:'Geist Mono',monospace;font-size:12px;color:#9A9A98;
overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.res.ok{color:#4ADE80}
.res.bad{color:#F87171}
button{border-radius:4px;border:1px solid #3A3A3A;background:transparent;color:#E8E8E6;
font-family:inherit;font-size:13px;padding:6px 14px;cursor:pointer}
button:hover:not(:disabled){background:#2A2A2A}
button:disabled{opacity:0.4;cursor:default}
button.p{background:#4A9EFF;border-color:#4A9EFF;color:#0F0F0F;font-weight:500}
button.p:hover:not(:disabled){background:#3D8CE8}
:focus-visible{outline:2px solid #4A9EFF;outline-offset:1px}
.foot{margin-top:14px;padding-top:12px;border-top:1px solid #2A2A2A;font-size:12px;color:#6B6B6A}
</style></head><body>
<header class="bar">
<h1>Where should Ethos run?</h1>
<p class="sub">Ethos needs a backend. Run one here, or connect to one you already have.</p>
${notice}
</header>
<main>
<label class="opt" data-mode="local">
<input type="radio" name="m" value="local"${remoteFirst ? '' : ' checked'}>
<span><span class="name">This Mac</span>
<span class="desc">Sessions, memory and tools run locally. Nothing leaves the machine.</span></span>
</label>
<label class="opt" data-mode="remote">
<input type="radio" name="m" value="remote"${remoteFirst ? ' checked' : ''}>
<span><span class="name">A remote Ethos server</span>
<span class="desc">Connect to an ethos serve you already run. This Mac becomes a thin client.</span></span>
</label>
<div id="remote" hidden>
<label class="fl" for="url">SERVER URL</label>
<input id="url" type="text" placeholder="https://ethos.example.com"${urlValue}>
<label class="fl" for="token">WEB TOKEN</label>
<input id="token" type="password">
<p class="help">Printed by ethos serve as ?t=&#8230;, or read from ~/.ethos/web-token on that
machine. Saved to the macOS keychain &#8212; you won&#8217;t be asked again.</p>
</div>
</main>
<div class="actions">
<span id="result" class="res"></span>
<button id="test">Test connection</button>
<button id="go" class="p">Continue</button>
</div>
<div class="foot">Change this later in Settings &#8594; Desktop &#8594; Connection.</div>
<script>
var n = 0;
function $(id){ return document.getElementById(id); }
function mode(){ return document.querySelector('input[name=m]:checked').value; }
function signal(kind){ document.title = kind + ':' + (++n); }
function sync(){
  var m = mode();
  var rows = document.querySelectorAll('.opt');
  for (var i = 0; i < rows.length; i++) {
    rows[i].classList.toggle('sel', rows[i].dataset.mode === m);
  }
  $('remote').hidden = m !== 'remote';
  $('test').disabled = m !== 'remote';
  $('go').disabled = m === 'remote' && !$('url').value.trim();
}
function busy(){
  $('result').className = 'res';
  $('result').textContent = 'Testing\\u2026';
  $('test').disabled = true;
  $('go').disabled = true;
}
window.__ethosValues = function(){
  return { mode: mode(), url: $('url').value, token: $('token').value };
};
window.__ethosResult = function(r){
  $('result').className = 'res ' + (r.ok ? 'ok' : 'bad');
  $('result').textContent = r.ok
    ? '\\u2713 Connected'
      + (typeof r.latencyMs === 'number' ? ' \\u00b7 ' + r.latencyMs + 'ms' : '')
      + (r.version ? ' \\u00b7 ethos ' + r.version : '')
    : '\\u2717 ' + (r.error || 'Connection failed.');
  sync();
};
document.querySelectorAll('input[name=m]').forEach(function(r){
  r.addEventListener('change', sync);
});
$('url').addEventListener('input', sync);
$('test').addEventListener('click', function(){ busy(); signal('test'); });
$('go').addEventListener('click', function(){
  if (mode() === 'local') { signal('submit'); return; }
  if (!$('token').value.trim()) {
    window.__ethosResult({ ok: false, error: 'Paste the server\\u2019s web token.' });
    return;
  }
  busy();
  signal('submit');
});
document.addEventListener('keydown', function(e){
  if (e.key === 'Escape') signal('cancel');
  if (e.key === 'Enter' && !$('go').disabled) $('go').click();
});
sync();
</script>
</body></html>`;
}

/**
 * The first-run gate: asks once where the backend lives. Resolves null when the
 * user closes the window without choosing.
 *
 * Communication is the same `document.title` channel `error-window.ts` uses,
 * with a counter appended so a repeated action still fires
 * `page-title-updated`. The typed form values come back over
 * `executeJavaScript` because this window is sandboxed with no preload.
 */
export function showConnectionWindow(
  opts: { url?: string; message?: string } = {},
): Promise<ConnectionChoice | null> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520,
      height: 440,
      frame: false,
      resizable: false,
      center: true,
      alwaysOnTop: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    let settled = false;
    const finish = (choice: ConnectionChoice | null): void => {
      if (settled) return;
      settled = true;
      resolve(choice);
      if (!win.isDestroyed()) win.close();
    };

    const show = (result: unknown): Promise<unknown> =>
      win.webContents.executeJavaScript(`window.__ethosResult(${JSON.stringify(result)})`);

    const handle = async (title: string): Promise<void> => {
      if (title.startsWith('cancel:')) {
        finish(null);
        return;
      }
      const isSubmit = title.startsWith('submit:');
      if (!isSubmit && !title.startsWith('test:')) return;

      const values = (await win.webContents.executeJavaScript(
        'window.__ethosValues()',
      )) as FormValues;

      if (values.mode === 'local') {
        if (isSubmit) finish({ mode: 'local' });
        return;
      }

      const url = normalizeRemoteUrl(values.url);
      if (!url) {
        await show({ ok: false, error: 'Enter an http:// or https:// server URL.' });
        return;
      }
      const token = values.token.trim();
      const result = await testConnection(url, token || undefined);
      await show(result);
      if (isSubmit && result.ok) finish({ mode: 'remote', url, token });
    };

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildHtml(opts))}`);
    win.webContents.on('page-title-updated', (_e, title) => {
      handle(title).catch(() => {
        // The window went away mid-probe; `closed` resolves the promise.
      });
    });
    win.on('closed', () => {
      if (settled) return;
      settled = true;
      resolve(null);
    });
  });
}
