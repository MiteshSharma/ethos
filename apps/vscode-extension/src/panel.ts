import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { AcpBridge } from './bridge';
import { getWebviewContent } from './webview';

// ---------------------------------------------------------------------------
// Config reader (mirrors apps/ethos/src/config.ts — kept local to avoid dep)
// ---------------------------------------------------------------------------

function ethosDir(): string {
  return join(homedir(), '.ethos');
}

async function readEthosConfig(): Promise<{ model: string; personality: string } | null> {
  try {
    const src = await readFile(join(ethosDir(), 'config.yaml'), 'utf-8');
    const kv: Record<string, string> = {};
    for (const line of src.split('\n')) {
      const m = line.match(/^(\w+):\s*(.+)$/);
      if (m) kv[m[1].trim()] = m[2].trim().replace(/^["']|["']$/g, '');
    }
    return {
      model: kv.model ?? 'claude-opus-4-7',
      personality: kv.personality ?? 'researcher',
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Resolve the ethos CLI path: user setting → PATH fallback
// ---------------------------------------------------------------------------

function resolveCliPath(): string {
  const cfg = vscode.workspace.getConfiguration('ethos');
  return (cfg.get<string>('cliPath') ?? 'ethos').trim() || 'ethos';
}

// ---------------------------------------------------------------------------
// EthosViewProvider
// ---------------------------------------------------------------------------

export class EthosViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'ethos.chat';

  private _view: vscode.WebviewView | undefined;
  private _bridge: AcpBridge | undefined;

  constructor(private readonly _extensionUri: vscode.Uri) {}

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = getWebviewContent(webviewView.webview, this._extensionUri);

    if (!this._bridge) {
      try {
        const config = await readEthosConfig();
        if (!config) throw new Error('~/.ethos/config.yaml not found. Run: ethos setup');
        this._bridge = await AcpBridge.create(resolveCliPath(), config.model, config.personality);
        this._subscribeToBridge();
        webviewView.webview.postMessage({
          type: 'init',
          model: this._bridge.model,
          personality: this._bridge.personality,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        webviewView.webview.postMessage({ type: 'error', message });
        return;
      }
    }

    webviewView.webview.onDidReceiveMessage(
      (msg: { type: string; text?: string; code?: string; language?: string }) => {
        switch (msg.type) {
          case 'ready':
            if (this._bridge) {
              webviewView.webview.postMessage({
                type: 'init',
                model: this._bridge.model,
                personality: this._bridge.personality,
              });
            }
            break;

          case 'send':
            if (this._bridge && msg.text) {
              this._bridge.send(msg.text);
            }
            break;

          case 'abort':
            this._bridge?.abortTurn();
            break;

          case 'apply_code':
            if (msg.code) void this._applyCode(msg.code);
            break;
        }
      },
    );
  }

  private _subscribeToBridge(): void {
    const bridge = this._bridge;
    if (!bridge) return;

    bridge.on('text_delta', (text: string) => this._post({ type: 'text_delta', text }));
    bridge.on('done', (text: string) => this._post({ type: 'done', text }));
    bridge.on('tool_start', (toolCallId: string, toolName: string) =>
      this._post({ type: 'tool_start', toolCallId, toolName }),
    );
    bridge.on('tool_end', (toolCallId: string, toolName: string, ok: boolean, durationMs: number) =>
      this._post({ type: 'tool_end', toolCallId, toolName, ok, durationMs }),
    );
    bridge.on('error', (error: string) => this._post({ type: 'error', message: error }));
  }

  // ---------------------------------------------------------------------------
  // Apply code block to the active editor
  // ---------------------------------------------------------------------------

  private async _applyCode(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('Ethos: No active file to apply code to.');
      return;
    }

    const doc = editor.document;
    const target = editor.selection.isEmpty
      ? new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length))
      : editor.selection;

    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, target, code);
    await vscode.workspace.applyEdit(edit);
  }

  private _post(msg: unknown): void {
    this._view?.webview.postMessage(msg);
  }

  newSession(): void {
    this._bridge?.newSession();
    this._post({ type: 'new_session' });
  }

  abort(): void {
    this._bridge?.abortTurn();
  }

  dispose(): void {
    this._bridge?.dispose();
    this._bridge = undefined;
  }
}
