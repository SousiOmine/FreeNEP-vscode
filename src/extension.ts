import * as vscode from 'vscode';
import { diffLines, diffWordsWithSpace } from 'diff';
import OpenAI from 'openai';

type Suggestion = {
  uri: vscode.Uri;
  target: vscode.Position; // where to place cursor on first Tab
  range?: vscode.Range; // optional replace range
  insertText: string; // text to apply on second Tab
  preview: string; // short preview for decoration
  logPath?: string; // per-request log file path
};

type LogRecord = {
  events: string; // markdown diff of recent user edits
  input_context: any; // JSON object we sent to model
  output_context: any; // raw model output
  eval: 'accepted' | 'rejected' | 'pending';
};

class ActivityBadgeController {
  private webviewView?: vscode.WebviewView;
  private busy = false;
  constructor(private readonly defaultTitle = 'Settings') {}
  attach(view: vscode.WebviewView) {
    this.webviewView = view;
    // Re-apply current state when view resolves
    this.apply();
  }
  setBusy(b: boolean) {
    this.busy = b;
    this.apply();
  }
  private apply() {
    if (!this.webviewView) return;
    const v = this.webviewView as any; // badge is available on supported VS Code; cast for compatibility
    try {
      if (this.busy) {
        if ('badge' in v) v.badge = { value: 1, tooltip: 'NEP: Generating…' };
        this.webviewView.description = 'Generating…';
        this.webviewView.title = `${this.defaultTitle}`;
      } else {
        if ('badge' in v) v.badge = undefined;
        this.webviewView.description = undefined;
        this.webviewView.title = `${this.defaultTitle}`;
      }
    } catch {
      // noop
    }
  }
}

class SettingsProvider implements vscode.WebviewViewProvider {
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
        if (typeof msg.apiKey === 'string') {
          await this.context.secrets.store('minoshiro.apiKey', msg.apiKey);
        }
        vscode.window.showInformationMessage('NEP settings saved');
      }
    });

    updateHtml();
  }
}

class SuggestionManager {
  private timer: NodeJS.Timeout | null = null;
  private readonly history: { uri: vscode.Uri; diffMarkdown: string; ts: number }[] = [];
  private lastContentByDoc = new Map<string, string>();
  private suggestion: Suggestion | null = null;
  private stage: 'none' | 'jumped' = 'none';
  private decoration?: vscode.TextEditorDecorationType;
  private statusItem: vscode.StatusBarItem;

  constructor(private readonly context: vscode.ExtensionContext, private readonly badge: ActivityBadgeController) {
    this.statusItem = vscode.window.createStatusBarItem('minoshiro', vscode.StatusBarAlignment.Right, 100);
    this.statusItem.name = 'NEP';
    this.statusItem.tooltip = 'Next Edit Prediction';
  }

  dispose() {
    this.statusItem.dispose();
    this.decoration?.dispose();
  }

  onChange(e: vscode.TextDocumentChangeEvent) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || e.document.uri.toString() !== editor.document.uri.toString()) return;

    // Compute diff from previous snapshot
    const key = e.document.uri.toString();
    const prev = this.lastContentByDoc.get(key) ?? '';
    const curr = e.document.getText();
    this.lastContentByDoc.set(key, curr);

    const parts = diffLines(prev, curr);
    let md = '```diff\n';
    for (const p of parts) {
      if (p.added) {
        md += p.value.split('\n').filter(Boolean).map((l: string) => '+ ' + l).join('\n') + '\n';
      } else if (p.removed) {
        md += p.value.split('\n').filter(Boolean).map((l: string) => '- ' + l).join('\n') + '\n';
      }
    }
    md += '```';

    this.history.push({ uri: e.document.uri, diffMarkdown: md, ts: Date.now() });
    const limit = vscode.workspace.getConfiguration().get<number>('minoshiro.editHistoryLimit') ?? 10;
    while (this.history.length > limit) this.history.shift();

    this.clearSuggestion();
    this.debounce();
  }

  private debounce() {
    const idleDelay = vscode.workspace.getConfiguration().get<number>('minoshiro.idleDelayMs') ?? 1000;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.onIdle(), idleDelay);
  }

  private async onIdle() {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;
    const doc = editor.document;
    const cfg = vscode.workspace.getConfiguration();
    const baseURL = cfg.get<string>('minoshiro.apiBaseUrl') || '';
    const model = cfg.get<string>('minoshiro.model') || 'minoshiro-NEP-v1-sft';
    const apiKey = await this.context.secrets.get('minoshiro.apiKey');
    if (!baseURL || !apiKey) {
      this.statusItem.text = 'NEP: Configure API in sidebar';
      this.statusItem.show();
      return;
    }

    const eventsMd = this.history.map(h => `- ${new Date(h.ts).toISOString()}\n${h.diffMarkdown}`).join('\n');
    const selection = editor.selection.active;
    const fullText = doc.getText();
    const cursorOffset = doc.offsetAt(selection);
    const cursorMarker = '<|user_cursor_is_here|>';
    const before = fullText.slice(0, cursorOffset);
    const after = fullText.slice(cursorOffset);
    const regionStartMarker = '<|editable_region_start|>';
    const regionEndMarker = '<|editable_region_end|>';
    const regionInput = `${regionStartMarker}\n${before}${cursorMarker}${after}\n${regionEndMarker}`;

    const inputContext = {
      filePath: doc.uri.fsPath,
      languageId: doc.languageId,
      cursor: { line: selection.line, character: selection.character },
      content: fullText,
      region: regionInput
    };

    const client = new OpenAI({ apiKey, baseURL });
    const systemPrompt = `You are a code completion assistant. Your job is to rewrite the excerpt provided by the user, analyzing their edits and suggesting appropriate edits within the excerpt, taking into account the cursor's position.\nThe region where you can suggest the next edit is between <|editable_region_start|> and <|editable_region_end|>. Please predict the next edit between these tags and write the code that will fit within that region after the edits are applied.`;

    const userPrompt = `### User Edits:\n${eventsMd}\n\n### Currently User Code:\n${regionInput}`;

    const logPath = await this.prepareLog({ events: eventsMd, input_context: inputContext, output_context: null, eval: 'pending' });

    this.badge.setBusy(true);
    try {
      this.statusItem.text = 'NEP: Thinking…';
      this.statusItem.show();

      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        temperature: 0.2,
      });

      const output = completion.choices?.[0]?.message?.content ?? '';
      await this.updateLog(logPath, { output_context: output });

      const { regionOut } = this.extractRegionFromOutput(output);
      if (!regionOut) {
        this.statusItem.text = 'NEP: No region in output';
        return;
      }

      const inputRegionContent = `${before}${cursorMarker}${after}`;
      const outputRegionContent = regionOut;
      const primary = this.computePrimaryEdit(inputRegionContent, outputRegionContent);
      if (!primary) {
        this.statusItem.text = 'NEP: No differences';
        return;
      }

      const startPos = doc.positionAt(primary.startOffset);
      const endPos = doc.positionAt(primary.endOffset);
      const target = startPos;
      const range = primary.startOffset === primary.endOffset ? undefined : new vscode.Range(startPos, endPos);
      const preview = primary.insertText.length > 40 ? primary.insertText.slice(0, 40) + '…' : primary.insertText;

      this.suggestion = { uri: doc.uri, target, range, insertText: primary.insertText, preview, logPath };
      await vscode.commands.executeCommand('setContext', 'minoshiro.hasSuggestion', true);
      this.stage = 'none';
      this.showDecoration(editor, target, preview);
      this.statusItem.text = 'NEP: Suggestion ready (Tab to jump)';
      this.statusItem.show();
    } catch (err: any) {
      console.error('NEP error', err);
      this.statusItem.text = 'NEP: Error (see console)';
      this.statusItem.show();
      await this.updateLog(logPath, { output_context: { error: String(err) } });
    } finally {
      this.badge.setBusy(false);
    }
  }

  private extractRegionFromOutput(text: string): { regionOut: string | null; think?: string } {
    if (!text) return { regionOut: null };
    const cleaned = text
      .replace(/^```(json|text)?/i, '')
      .replace(/```$/,'')
      .trim();
    let think: string | undefined;
    const thinkStart = cleaned.indexOf('<think>');
    const thinkEnd = cleaned.indexOf('</think>');
    let body = cleaned;
    if (thinkStart !== -1 && thinkEnd !== -1 && thinkEnd > thinkStart) {
      think = cleaned.slice(thinkStart + 7, thinkEnd).trim();
      body = (cleaned.slice(0, thinkStart) + cleaned.slice(thinkEnd + 8)).trim();
    }
    const startIdx = body.indexOf('<|editable_region_start|>');
    const endIdx = body.indexOf('<|editable_region_end|>');
    if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return { regionOut: null };
    const inner = body.slice(startIdx + '<|editable_region_start|>'.length, endIdx);
    return { regionOut: inner.replace(/^[\r\n]+/, '').replace(/[\r\n]+$/, ''), think };
  }

  private computePrimaryEdit(before: string, after: string): { startOffset: number; endOffset: number; insertText: string } | null {
    if (before === after) return null;
    const parts = diffWordsWithSpace(before, after) as Array<{ added?: boolean; removed?: boolean; value: string; count?: number }>;
    let offsetBefore = 0;
    let startOffset: number | null = null;
    let endOffset: number | null = null;
    let insertText = '';
    for (const part of parts) {
      if (!part.added && !part.removed) {
        if (startOffset === null) {
          offsetBefore += part.count ?? part.value.length;
        } else if (startOffset !== null && endOffset === null) {
          endOffset = offsetBefore;
          break;
        }
        continue;
      }
      if (startOffset === null) startOffset = offsetBefore;
      if (part.removed) {
        offsetBefore += part.count ?? part.value.length;
      }
      if (part.added) {
        insertText += part.value;
      }
    }
    if (startOffset === null) return null;
    if (endOffset === null) endOffset = offsetBefore;
    return { startOffset, endOffset, insertText };
  }

  private showDecoration(editor: vscode.TextEditor, at: vscode.Position, text: string) {
    this.decoration?.dispose();
    this.decoration = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: ` ⇢ ${text}`,
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: '0 0 0 8px'
      }
    });
    editor.setDecorations(this.decoration, [{ range: new vscode.Range(at, at) }]);
  }

  async acceptOrJump() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.suggestion) return;
    if (editor.document.uri.toString() !== this.suggestion.uri.toString()) return;

    if (this.stage === 'none') {
      // First Tab: jump cursor
      const pos = this.suggestion.target;
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      this.stage = 'jumped';
      this.statusItem.text = 'NEP: Tab to apply';
      this.statusItem.show();
      return;
    }

    // Second Tab: apply edit
    const edit = new vscode.WorkspaceEdit();
    if (this.suggestion.range) {
      edit.replace(this.suggestion.uri, this.suggestion.range, this.suggestion.insertText);
    } else {
      edit.insert(this.suggestion.uri, this.suggestion.target, this.suggestion.insertText);
    }
    await vscode.workspace.applyEdit(edit);
    await this.markEval('accepted');
    this.clearSuggestion();
  }

  async dismiss() {
    await this.markEval('rejected');
    this.clearSuggestion();
  }

  private async markEval(status: 'accepted' | 'rejected') {
    if (this.suggestion?.logPath) {
      await this.updateLog(this.suggestion.logPath, { eval: status });
    }
  }

  private clearSuggestion() {
    this.suggestion = null;
    this.stage = 'none';
    vscode.commands.executeCommand('setContext', 'minoshiro.hasSuggestion', false);
    this.decoration?.dispose();
    this.statusItem.hide();
  }

  private async prepareLog(initial: LogRecord): Promise<string> {
    const cfg = vscode.workspace.getConfiguration();
    const dir = cfg.get<string>('minoshiro.logDirectory')?.trim();
    let folder: vscode.Uri;
    if (dir) {
      folder = vscode.Uri.file(dir);
    } else {
      folder = vscode.Uri.joinPath(this.context.globalStorageUri, 'logs');
    }
    await vscode.workspace.fs.createDirectory(folder);
    const file = vscode.Uri.joinPath(folder, `${Date.now()}-${Math.random().toString(36).slice(2,8)}.json`);
    await vscode.workspace.fs.writeFile(file, Buffer.from(JSON.stringify(initial, null, 2)));
    return file.fsPath;
  }

  private async updateLog(pathFs: string, patch: Partial<LogRecord>) {
    try {
      const uri = vscode.Uri.file(pathFs);
      const data = await vscode.workspace.fs.readFile(uri);
      const obj = JSON.parse(Buffer.from(data).toString('utf8')) as LogRecord;
      const next = { ...obj, ...patch } as LogRecord;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(next, null, 2)));
    } catch (e) {
      console.error('Failed to update log', e);
    }
  }
}

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
