import * as vscode from 'vscode';
import { ActivityBadgeController } from './ui/ActivityBadgeController';
import { SettingsProvider } from './views/SettingsProvider';
import { SuggestionManager } from './core/SuggestionManager';

export function activate(context: vscode.ExtensionContext) {
  const badge = new ActivityBadgeController('Settings');
  const settingsProvider = new SettingsProvider(context, badge);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SettingsProvider.viewType, settingsProvider, { webviewOptions: { retainContextWhenHidden: true } })
  );

  const manager = new SuggestionManager(context, badge);
  context.subscriptions.push(manager);

  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(e => manager.onChange(e)),
    vscode.commands.registerCommand('minoshiro.acceptOrJump', () => manager.acceptOrJump()),
    vscode.commands.registerCommand('minoshiro.dismiss', () => manager.dismiss()),
    vscode.commands.registerCommand('minoshiro.showSettings', () => vscode.commands.executeCommand('workbench.view.extension.minoshiro'))
  );

  vscode.window.showInformationMessage('FreeNEP loaded. Configure API in the NEP sidebar.');
}

export function deactivate() {}
