import * as vscode from 'vscode';
import { EthosViewProvider } from './panel';

let provider: EthosViewProvider | undefined;

export function activate(context: vscode.ExtensionContext): void {
  provider = new EthosViewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(EthosViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('ethos.newSession', () => {
      provider?.newSession();
    }),
    vscode.commands.registerCommand('ethos.abort', () => {
      provider?.abort();
    }),
    { dispose: () => provider?.dispose() },
  );
}

export function deactivate(): void {
  provider?.dispose();
  provider = undefined;
}
