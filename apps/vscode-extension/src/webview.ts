import * as crypto from 'node:crypto';
import type * as vscode from 'vscode';

export function getWebviewContent(webview: vscode.Webview, _extensionUri: vscode.Uri): string {
  const nonce = crypto.randomBytes(16).toString('hex');
  const csp = [
    `default-src 'none'`,
    `style-src 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>Ethos</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{
      font-family:var(--vscode-font-family);
      font-size:var(--vscode-font-size,13px);
      color:var(--vscode-editor-foreground);
      background:var(--vscode-sideBar-background,var(--vscode-editor-background));
      height:100vh;
      display:flex;
      flex-direction:column;
      overflow:hidden;
    }

    /* ── Status bar ── */
    #statusbar{
      padding:6px 12px;
      background:var(--vscode-sideBarSectionHeader-background);
      border-bottom:1px solid var(--vscode-panel-border,var(--vscode-widget-border));
      display:flex;
      align-items:center;
      gap:8px;
      flex-shrink:0;
      min-height:32px;
    }
    #statusbar .brand{font-weight:700;font-size:13px;letter-spacing:-.3px}
    #statusbar .meta{color:var(--vscode-descriptionForeground);font-size:11px;flex:1}
    #statusbar .dot{
      width:7px;height:7px;border-radius:50%;
      background:var(--vscode-charts-yellow,#ddb700);
      display:none;
    }
    #statusbar .dot.on{display:block;animation:pulse 1.2s ease-in-out infinite}
    @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

    /* ── Scroll area ── */
    #scroll{flex:1;overflow-y:auto;display:flex;flex-direction:column}

    /* ── Welcome ── */
    #welcome{
      flex:1;
      display:flex;
      flex-direction:column;
      align-items:center;
      justify-content:center;
      padding:28px 20px;
      gap:10px;
      color:var(--vscode-descriptionForeground);
      text-align:center;
    }
    #welcome .logo{font-size:28px;font-weight:800;letter-spacing:-1px;color:var(--vscode-editor-foreground)}
    #welcome .tagline{font-size:12px;line-height:1.5;max-width:220px}
    #welcome .caps{
      margin-top:4px;font-size:12px;line-height:1.9;
      text-align:left;width:100%;max-width:230px;
    }
    #welcome .caps li{list-style:none;display:flex;gap:6px}
    #welcome .caps li::before{content:"·";color:var(--vscode-textLink-foreground,#4da6ff)}
    #welcome .cmds{
      width:100%;max-width:230px;
      border-top:1px solid var(--vscode-panel-border,var(--vscode-widget-border));
      padding-top:10px;margin-top:4px;
      font-size:11px;line-height:2;text-align:left;
    }
    #welcome .cmds kbd{
      font-family:var(--vscode-editor-font-family,monospace);
      font-size:10px;
      background:var(--vscode-textBlockQuote-background,rgba(127,127,127,.1));
      border:1px solid var(--vscode-panel-border,rgba(127,127,127,.3));
      border-radius:3px;padding:1px 5px;
    }

    /* ── Messages ── */
    #messages{display:none;flex-direction:column;gap:14px;padding:14px 12px}
    .msg{display:flex;flex-direction:column;gap:3px}
    .msg-label{
      font-size:10px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;
    }
    .msg-label.user{color:var(--vscode-terminal-ansiCyan,#29b8db)}
    .msg-label.assistant{color:var(--vscode-terminal-ansiGreen,#23d18b)}
    .msg-label.error{color:var(--vscode-errorForeground,var(--vscode-terminal-ansiRed,#f14c4c))}
    .msg-body{
      white-space:pre-wrap;word-break:break-word;
      line-height:1.55;font-size:13px;
    }

    /* ── Tool strip ── */
    #toolstrip{
      padding:0 12px 6px;
      display:flex;flex-wrap:wrap;gap:4px;
      flex-shrink:0;
    }
    .chip{
      font-family:var(--vscode-editor-font-family,monospace);
      font-size:11px;padding:2px 7px;border-radius:10px;
      display:inline-flex;align-items:center;gap:4px;
    }
    .chip.active{
      background:var(--vscode-badge-background);
      color:var(--vscode-badge-foreground);
    }
    .chip.ok{
      background:transparent;
      color:var(--vscode-descriptionForeground);
    }
    .chip.fail{
      background:transparent;
      color:var(--vscode-errorForeground,var(--vscode-terminal-ansiRed));
    }
    @keyframes spin{to{transform:rotate(360deg)}}
    .spin{display:inline-block;animation:spin .7s linear infinite}

    /* ── Input row ── */
    #inputrow{
      padding:8px 10px 10px;
      border-top:1px solid var(--vscode-panel-border,var(--vscode-widget-border));
      display:flex;gap:6px;align-items:flex-end;flex-shrink:0;
    }
    #input{
      flex:1;
      background:var(--vscode-input-background);
      color:var(--vscode-input-foreground);
      border:1px solid var(--vscode-input-border,transparent);
      border-radius:4px;
      padding:6px 8px;
      font-family:var(--vscode-font-family);
      font-size:var(--vscode-font-size,13px);
      resize:none;outline:none;
      min-height:32px;max-height:130px;
      line-height:1.4;
    }
    #input:focus{border-color:var(--vscode-focusBorder)}
    #input::placeholder{color:var(--vscode-input-placeholderForeground)}
    #sendbtn{
      background:var(--vscode-button-background);
      color:var(--vscode-button-foreground);
      border:none;border-radius:4px;
      padding:6px 10px;cursor:pointer;
      font-size:16px;line-height:1;
      flex-shrink:0;align-self:flex-end;
      transition:background .1s;
    }
    #sendbtn:hover:not(:disabled){background:var(--vscode-button-hoverBackground)}
    #sendbtn:disabled{opacity:.45;cursor:not-allowed}

    /* ── Code blocks ── */
    .code-block{
      position:relative;
      margin:6px 0;
      border-radius:4px;
      overflow:hidden;
      border:1px solid var(--vscode-panel-border,rgba(127,127,127,.3));
    }
    .code-block pre{
      margin:0;padding:10px 12px;
      font-family:var(--vscode-editor-font-family,monospace);
      font-size:12px;line-height:1.5;
      overflow-x:auto;
      background:var(--vscode-textBlockQuote-background,rgba(127,127,127,.1));
      white-space:pre;
    }
    .apply-btn{
      display:block;width:100%;
      padding:5px 12px;
      font-size:11px;font-family:var(--vscode-font-family);
      background:var(--vscode-button-secondaryBackground,rgba(127,127,127,.15));
      color:var(--vscode-button-secondaryForeground,var(--vscode-editor-foreground));
      border:none;border-top:1px solid var(--vscode-panel-border,rgba(127,127,127,.3));
      cursor:pointer;text-align:left;
      transition:background .1s;
    }
    .apply-btn:hover{background:var(--vscode-button-secondaryHoverBackground,rgba(127,127,127,.25))}
  </style>
</head>
<body>

<div id="statusbar">
  <span class="brand">ethos</span>
  <span class="meta" id="statusmeta"></span>
  <span class="dot" id="statusdot"></span>
</div>

<div id="scroll">
  <div id="welcome">
    <div class="logo">ethos</div>
    <p class="tagline">Your AI agent, always in the sidebar.</p>
    <ul class="caps">
      <li>Read and edit files in your project</li>
      <li>Search the web and fetch URLs</li>
      <li>Run terminal commands</li>
      <li>Remember context across sessions</li>
      <li>Switch personalities for different tasks</li>
    </ul>
    <div class="cmds">
      <kbd>/new</kbd>&nbsp; fresh session<br>
      <kbd>/personality list</kbd>&nbsp; switch personality<br>
      <kbd>/memory</kbd>&nbsp; show what ethos remembers<br>
      <kbd>/usage</kbd>&nbsp; token &amp; cost stats<br>
      <kbd>/help</kbd>&nbsp; all commands
    </div>
  </div>
  <div id="messages"></div>
</div>

<div id="toolstrip"></div>

<div id="inputrow">
  <textarea id="input" rows="1" placeholder="Type a message or /help…"></textarea>
  <button id="sendbtn" title="Send (Enter)">&#8593;</button>
</div>

<script nonce="${nonce}">
(function(){
  const vscode = acquireVsCodeApi();
  const welcomeEl = document.getElementById('welcome');
  const messagesEl = document.getElementById('messages');
  const toolstripEl = document.getElementById('toolstrip');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendbtn');
  const statusMeta = document.getElementById('statusmeta');
  const statusDot = document.getElementById('statusdot');

  let running = false;
  let streamDiv = null;
  let streamText = '';
  const activeTools = new Map(); // toolCallId → toolName
  const doneTools = [];          // { name, ok, durationMs }

  // ── State helpers ────────────────────────────────────────────
  function setRunning(val) {
    running = val;
    statusDot.classList.toggle('on', val);
    sendBtn.disabled = val;
    inputEl.placeholder = val ? 'Waiting…' : 'Type a message or /help…';
  }

  function showChat() {
    welcomeEl.style.display = 'none';
    messagesEl.style.display = 'flex';
  }

  function scrollBottom() {
    const scroll = document.getElementById('scroll');
    scroll.scrollTop = scroll.scrollHeight;
  }

  // ── Message rendering ────────────────────────────────────────
  function addMessage(role, text) {
    showChat();
    const div = document.createElement('div');
    div.className = 'msg';
    const label = document.createElement('div');
    label.className = 'msg-label ' + role;
    label.textContent = role === 'user' ? 'You' : role === 'error' ? 'Error' : 'ethos';
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.textContent = text;
    div.append(label, body);
    messagesEl.appendChild(div);
    scrollBottom();
  }

  function startStream() {
    showChat();
    streamText = '';
    streamDiv = document.createElement('div');
    streamDiv.className = 'msg';
    const label = document.createElement('div');
    label.className = 'msg-label assistant';
    label.textContent = 'ethos';
    const body = document.createElement('div');
    body.className = 'msg-body';
    body.id = '_streaming';
    streamDiv.append(label, body);
    messagesEl.appendChild(streamDiv);
    scrollBottom();
  }

  function appendStream(text) {
    streamText += text;
    const el = document.getElementById('_streaming');
    if (el) { el.textContent = streamText; scrollBottom(); }
  }

  function finalizeStream(text) {
    const full = text || streamText;
    const el = document.getElementById('_streaming');
    if (el) { el.removeAttribute('id'); renderResponseText(el, full); }
    streamDiv = null;
    streamText = '';
  }

  // ── Code block rendering with Apply button ────────────────────
  const CODE_FENCE = new RegExp('\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`', 'g');

  function renderResponseText(el, text) {
    const parts = [];
    let last = 0;
    let m;
    CODE_FENCE.lastIndex = 0;
    while ((m = CODE_FENCE.exec(text)) !== null) {
      if (m.index > last) parts.push({ kind: 'text', value: text.slice(last, m.index) });
      parts.push({ kind: 'code', lang: m[1] || '', code: m[2] });
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push({ kind: 'text', value: text.slice(last) });

    el.innerHTML = '';
    for (const part of parts) {
      if (part.kind === 'text') {
        const span = document.createElement('span');
        span.textContent = part.value;
        el.appendChild(span);
      } else {
        const wrap = document.createElement('div');
        wrap.className = 'code-block';
        const pre = document.createElement('pre');
        pre.textContent = part.code;
        const btn = document.createElement('button');
        btn.className = 'apply-btn';
        btn.textContent = '⇅ Apply to file';
        btn.addEventListener('click', () => {
          vscode.postMessage({ type: 'apply_code', code: part.code, language: part.lang });
        });
        wrap.append(pre, btn);
        el.appendChild(wrap);
      }
    }
    if (parts.length === 0) el.textContent = text;
  }

  // ── Tool strip ────────────────────────────────────────────────
  function renderTools() {
    toolstripEl.innerHTML = '';
    for (const [, name] of activeTools) {
      const c = document.createElement('span');
      c.className = 'chip active';
      c.innerHTML = '<span class="spin">&#x21BA;</span> ' + esc(name);
      toolstripEl.appendChild(c);
    }
    for (const t of doneTools.slice(-6)) {
      const c = document.createElement('span');
      c.className = 'chip ' + (t.ok ? 'ok' : 'fail');
      c.textContent = (t.ok ? '✓' : '✗') + ' ' + t.name + ' ' + t.durationMs + 'ms';
      toolstripEl.appendChild(c);
    }
  }

  function esc(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Input ────────────────────────────────────────────────────
  inputEl.addEventListener('input', () => {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 130) + 'px';
  });

  inputEl.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
  });

  sendBtn.addEventListener('click', doSend);

  function doSend() {
    const text = inputEl.value.trim();
    if (!text || running) return;
    inputEl.value = '';
    inputEl.style.height = 'auto';
    addMessage('user', text);
    doneTools.length = 0;
    activeTools.clear();
    renderTools();
    vscode.postMessage({ type: 'send', text });
  }

  // ── Host → Webview messages ───────────────────────────────────
  window.addEventListener('message', ({ data: msg }) => {
    switch (msg.type) {
      case 'init':
        statusMeta.textContent = msg.model + ' · ' + msg.personality;
        break;
      case 'text_delta':
        if (!streamDiv) startStream();
        appendStream(msg.text);
        if (!running) setRunning(true);
        break;
      case 'done':
        finalizeStream(msg.text);
        setRunning(false);
        break;
      case 'tool_start':
        if (!running) setRunning(true);
        activeTools.set(msg.toolCallId, msg.toolName);
        renderTools();
        break;
      case 'tool_end':
        activeTools.delete(msg.toolCallId);
        doneTools.push({ name: msg.toolName, ok: msg.ok, durationMs: msg.durationMs });
        renderTools();
        break;
      case 'error':
        if (streamDiv) { streamDiv.remove(); streamDiv = null; }
        addMessage('error', msg.message);
        setRunning(false);
        break;
      case 'new_session':
        messagesEl.innerHTML = '';
        messagesEl.style.display = 'none';
        welcomeEl.style.display = 'flex';
        doneTools.length = 0;
        activeTools.clear();
        renderTools();
        setRunning(false);
        break;
    }
  });

  // Signal ready so panel sends the init message
  vscode.postMessage({ type: 'ready' });
})();
</script>
</body>
</html>`;
}
