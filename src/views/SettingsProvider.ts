import * as vscode from 'vscode';
import { ActivityBadgeController } from '../ui/ActivityBadgeController';

export class SettingsProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'minoshiro.settings';

  constructor(private readonly context: vscode.ExtensionContext, private readonly badge: ActivityBadgeController) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void | Thenable<void> {
    this.badge.attach(webviewView);
    webviewView.webview.options = {
      enableScripts: true
    };

    const getCfg = () => vscode.workspace.getConfiguration();

    const updateHtml = async () => {
      const cfg = getCfg();
      const baseUrl = cfg.get<string>('minoshiro.apiBaseUrl') ?? '';
      const model = cfg.get<string>('minoshiro.model') ?? 'minoshiro-NEP-v1-sft';
      const limit = cfg.get<number>('minoshiro.editHistoryLimit') ?? 10;
      const logDir = cfg.get<string>('minoshiro.logDirectory') ?? '';
      const idleDelayMs = cfg.get<number>('minoshiro.idleDelayMs') ?? 1000;
      const autoShow = cfg.get<boolean>('minoshiro.autoShowPreview') ?? true;
      const autoDelay = cfg.get<number>('minoshiro.autoShowPreviewDelayMs') ?? 350;
      const hoverMode = (cfg.get<string>('minoshiro.previewHoverMode') ?? 'split');
      const apiKey = await this.context.secrets.get('minoshiro.apiKey') || '';
      webviewView.webview.html = `<!DOCTYPE html>
        <html lang="en"><head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <style>
          body { font: 12px var(--vscode-font-family); color: var(--vscode-foreground); padding: 8px; }
          input, textarea { width: 100%; box-sizing: border-box; margin: 4px 0 10px; }
          label { font-weight: 600; }
          .row { margin-bottom: 8px; }
          button { margin-top: 8px; }
          .note { color: var(--vscode-descriptionForeground); }
        </style>
        </head>
        <body>
          <div class="row">
            <label>API Base URL</label>
            <input id="baseUrl" value="${baseUrl}" placeholder="https://api.openai.com/v1" />
          </div>
          <div class="row">
            <label>API Key</label>
            <input id="apiKey" value="${apiKey}" placeholder="sk-..." />
            <div class="note">Stored securely in VS Code Secret Storage</div>
          </div>
          <div class="row">
            <label>Model</label>
            <input id="model" value="${model}" />
          </div>
          <div class="row">
            <label>Edit History Limit</label>
            <input id="limit" type="number" value="${limit}" min="1" max="200" />
          </div>
          <div class="row">
            <label>Idle Delay (ms)</label>
            <input id="idleDelayMs" type="number" value="${idleDelayMs}" min="300" max="10000" />
          </div>
          <div class="row">
            <label>Log Directory</label>
            <input id="logDir" value="${logDir}" placeholder="Leave empty to use extension storage" />
          </div>
          <hr />
          <div class="row">
            <label>Hover Auto Open</label>
            <input id="autoShow" type="checkbox" ${autoShow ? 'checked' : ''} />
            <div class="note">Automatically open the preview hover</div>
          </div>
          <div class="row">
            <label>Hover Auto Open Delay (ms)</label>
            <input id="autoDelay" type="number" value="${autoDelay}" min="0" max="2000" />
          </div>
          <div class="row">
            <label>Hover Mode</label>
            <select id="hoverMode">
              <option value="split" ${hoverMode === 'split' ? 'selected' : ''}>Before / After</option>
              <option value="diff" ${hoverMode === 'diff' ? 'selected' : ''}>Unified diff + After</option>
            </select>
          </div>
          <button id="save">Save</button>
          <script>
            const vscode = acquireVsCodeApi();
            document.getElementById('save').addEventListener('click', () => {
              vscode.postMessage({
                type: 'save',
                baseUrl: (document.getElementById('baseUrl')).value.trim(),
                apiKey: (document.getElementById('apiKey')).value.trim(),
                model: (document.getElementById('model')).value.trim(),
                limit: Number((document.getElementById('limit')).value),
                idleDelayMs: Number((document.getElementById('idleDelayMs')).value),
                logDir: (document.getElementById('logDir')).value.trim(),
                autoShow: (document.getElementById('autoShow')).checked,
                autoDelay: Number((document.getElementById('autoDelay')).value),
                hoverMode: (document.getElementById('hoverMode')).value,
              });
            });
          </script>
        </body></html>`;
    };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      if (msg?.type === 'save') {
        const cfg = vscode.workspace.getConfiguration();
        await cfg.update('minoshiro.apiBaseUrl', msg.baseUrl, vscode.ConfigurationTarget.Global);
        await cfg.update('minoshiro.model', msg.model, vscode.ConfigurationTarget.Global);
        await cfg.update('minoshiro.editHistoryLimit', msg.limit, vscode.ConfigurationTarget.Global);
        await cfg.update('minoshiro.idleDelayMs', msg.idleDelayMs, vscode.ConfigurationTarget.Global);
        await cfg.update('minoshiro.logDirectory', msg.logDir, vscode.ConfigurationTarget.Global);
        await cfg.update('minoshiro.autoShowPreview', !!msg.autoShow, vscode.ConfigurationTarget.Global);
        await cfg.update('minoshiro.autoShowPreviewDelayMs', msg.autoDelay, vscode.ConfigurationTarget.Global);
        if (msg.hoverMode === 'split' || msg.hoverMode === 'diff') {
          await cfg.update('minoshiro.previewHoverMode', msg.hoverMode, vscode.ConfigurationTarget.Global);
        }
        if (typeof msg.apiKey === 'string') {
          await this.context.secrets.store('minoshiro.apiKey', msg.apiKey);
        }
        vscode.window.showInformationMessage('NEP settings saved');
      }
    });

    updateHtml();
  }
}
