import { BrowserWindow } from 'electron';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function showErrorWindow(opts: {
  title: string;
  message: string;
  logPath?: string;
  /** Label for an optional third action; resolves `'alt'` when pressed. */
  altLabel?: string;
}): Promise<'retry' | 'quit' | 'alt'> {
  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520,
      height: 280,
      frame: false,
      resizable: false,
      center: true,
      alwaysOnTop: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });

    const logHtml = opts.logPath ? `<div class="log">${escapeHtml(opts.logPath)}</div>` : '';
    const altHtml = opts.altLabel
      ? `<button onclick="document.title='alt'">${escapeHtml(opts.altLabel)}</button>`
      : '';

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{background:#1A1A1A;color:#E8E8E6;font-family:system-ui,sans-serif;padding:0 32px 32px;
display:flex;flex-direction:column;height:100vh;-webkit-app-region:no-drag;user-select:none}
.bar{-webkit-app-region:drag;cursor:default;user-select:none;margin:0 -32px;padding:32px 32px 0}
h3{font-size:20px;font-weight:600;margin-bottom:12px}
.g{color:#F87171;margin-right:8px}
p{font-size:14px;font-weight:400;color:#9A9A98;line-height:1.5}
.log{margin-top:12px;padding:8px 12px;background:#2A2A2A;border-radius:4px;
font-family:'Geist Mono',monospace;font-size:13px;color:#9A9A98;word-break:break-all}
.a{margin-top:auto;display:flex;gap:8px;justify-content:flex-end}
button{padding:6px 16px;border-radius:4px;border:1px solid #333;background:transparent;
color:#E8E8E6;font-size:13px;cursor:pointer}
button:hover{background:#333}
button:focus{outline:2px solid #F87171;outline-offset:2px}
.p{background:#F87171;border-color:#F87171;color:#1A1A1A}
.p:hover{background:#ef5555}
</style></head><body>
<header class="bar">
<h3><span class="g">&#9650;</span>${escapeHtml(opts.title)}</h3>
</header>
<p>${escapeHtml(opts.message)}</p>${logHtml}
<div class="a">
<button onclick="document.title='quit'">Quit</button>${altHtml}
<button class="p" id="r" onclick="document.title='retry'">Retry</button>
</div>
<script>document.getElementById('r').focus();
document.addEventListener('keydown',e=>{
if(e.key==='Enter')document.title='retry';
if(e.key==='Escape')document.title='quit';});</script>
</body></html>`;

    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
    win.webContents.on('page-title-updated', (_e, title) => {
      if (title === 'retry' || title === 'quit' || title === 'alt') {
        win.close();
        resolve(title);
      }
    });
    win.on('closed', () => resolve('quit'));
  });
}
