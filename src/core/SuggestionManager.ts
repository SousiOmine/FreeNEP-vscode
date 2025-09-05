import * as vscode from 'vscode';
import { ActivityBadgeController } from '../ui/ActivityBadgeController';
import { computePrimaryEdit, toDiffMarkdown } from '../utils/diff';
import { CURSOR_MARKER, extractRegionFromOutput, makeRegionInput } from '../utils/region';
import { LoggerService } from '../services/logger';
import { requestCompletion } from '../services/openai';
import { Suggestion } from '../types';

export class SuggestionManager {
  private timer: NodeJS.Timeout | null = null;
  private readonly history: { uri: vscode.Uri; diffMarkdown: string; ts: number }[] = [];
  private lastContentByDoc = new Map<string, string>();
  private suggestion: Suggestion | null = null;
  private stage: 'none' | 'jumped' = 'none';
  private decoration?: vscode.TextEditorDecorationType;
  private rangeDecoration?: vscode.TextEditorDecorationType;
  private statusItem: vscode.StatusBarItem;
  private currentAbort?: AbortController;
  private requestSeq = 0;
  private logger: LoggerService;

  constructor(private readonly context: vscode.ExtensionContext, private readonly badge: ActivityBadgeController) {
    this.statusItem = vscode.window.createStatusBarItem('minoshiro', vscode.StatusBarAlignment.Right, 100);
    this.statusItem.name = 'NEP';
    this.statusItem.tooltip = 'Next Edit Prediction';
    this.logger = new LoggerService(context);
  }

  dispose() {
    this.statusItem.dispose();
    this.decoration?.dispose();
    this.rangeDecoration?.dispose();
  }

  onChange(e: vscode.TextDocumentChangeEvent) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || e.document.uri.toString() !== editor.document.uri.toString()) return;

    const key = e.document.uri.toString();
    const prev = this.lastContentByDoc.get(key) ?? '';
    const curr = e.document.getText();
    this.lastContentByDoc.set(key, curr);

    const md = toDiffMarkdown(prev, curr);
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
    const before = fullText.slice(0, cursorOffset);
    const after = fullText.slice(cursorOffset);
    const regionInput = makeRegionInput(before, after);

    const systemPrompt = `You are a code completion assistant. Your job is to rewrite the excerpt provided by the user, analyzing their edits and suggesting appropriate edits within the excerpt, taking into account the cursor's position.\nThe region where you can suggest the next edit is between <|editable_region_start|> and <|editable_region_end|>. Please predict the next edit between these tags and write the code that will fit within that region after the edits are applied.`;
    const userPrompt = `### User Edits:\n${eventsMd}\n\n### Currently User Code:\n${regionInput}`;

    if (this.currentAbort) {
      try { this.currentAbort.abort(); } catch {}
    }
    const abort = new AbortController();
    this.currentAbort = abort;
    const myReqId = ++this.requestSeq;

    this.badge.setBusy(true);
    // Helper to update status only if this is the latest request
    const setStatus = (text: string) => {
      if (myReqId === this.requestSeq) {
        this.statusItem.text = text;
        this.statusItem.show();
      }
    };
    try {
      // Start of a new request — safe to show unconditionally
      this.statusItem.text = 'NEP: Thinking…';
      this.statusItem.show();

      if (abort.signal.aborted) {
        setStatus('NEP: Canceled');
        return;
      }

      const output = await requestCompletion({ baseURL, apiKey, model, systemPrompt, userPrompt, signal: abort.signal });
      const { regionOut } = extractRegionFromOutput(output);
      if (!regionOut) {
        setStatus('NEP: No region in output');
        return;
      }

      const logUri = await this.logger.prepareLog({ events: eventsMd, input_context: regionInput, output_context: output, eval: 'pending' });

      const inputRegionContent = `${before}${CURSOR_MARKER}${after}`;
      const outputRegionContent = regionOut;
      const primary = computePrimaryEdit(inputRegionContent, outputRegionContent);
      if (!primary) {
        setStatus('NEP: No differences');
        return;
      }

      const startPos = doc.positionAt(primary.startOffset);
      const endPos = doc.positionAt(primary.endOffset);
      const target = startPos;
      const range = primary.startOffset === primary.endOffset ? undefined : new vscode.Range(startPos, endPos);
      const preview = primary.insertText.length > 40 ? primary.insertText.slice(0, 40) + '…' : primary.insertText;

      this.suggestion = { uri: doc.uri, target, range, insertText: primary.insertText, preview, logUri };
      await vscode.commands.executeCommand('setContext', 'minoshiro.hasSuggestion', true);
      this.stage = 'none';
      this.showDecoration(editor, target, preview, range);
      setStatus('NEP: Suggestion ready (Tab to jump)');
    } catch (err: any) {
      if (this.isAbortError(err)) {
        setStatus('NEP: Canceled');
      } else {
        console.warn('NEP error', err);
        setStatus('NEP: Error (see console)');
      }
    } finally {
      if (myReqId === this.requestSeq) {
        this.badge.setBusy(false);
        if (this.currentAbort === abort) this.currentAbort = undefined;
      }
    }
  }

  private isAbortError(err: any): boolean {
    const name = err?.name as string | undefined;
    const msg = err?.message as string | undefined;
    return (
      name === 'AbortError' ||
      name === 'APIUserAbortError' ||
      (typeof msg === 'string' && msg.toLowerCase().includes('aborted'))
    );
  }

  private showDecoration(editor: vscode.TextEditor, at: vscode.Position, text: string, replaceRange?: vscode.Range) {
    this.decoration?.dispose();
    this.rangeDecoration?.dispose();
    this.decoration = vscode.window.createTextEditorDecorationType({
      after: {
        contentText: ` ⇢ ${text}`,
        color: new vscode.ThemeColor('editorCodeLens.foreground'),
        margin: '0 0 0 8px',
        textDecoration: 'background-color: rgba(76, 175, 80, 0.20); border-radius: 2px;'
      }
    });
    editor.setDecorations(this.decoration, [{ range: new vscode.Range(at, at) }]);

    if (replaceRange) {
      this.rangeDecoration = vscode.window.createTextEditorDecorationType({
        backgroundColor: 'rgba(76, 175, 80, 0.25)',
        borderRadius: '2px'
      });
      editor.setDecorations(this.rangeDecoration, [{ range: replaceRange }]);
    }
  }

  async acceptOrJump() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.suggestion) return;
    if (editor.document.uri.toString() !== this.suggestion.uri.toString()) return;

    if (this.stage === 'none') {
      const pos = this.suggestion.target;
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      this.stage = 'jumped';
      this.statusItem.text = 'NEP: Tab to apply';
      this.statusItem.show();
      return;
    }

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
    if (this.suggestion?.logUri) {
      await this.logger.updateLog(this.suggestion.logUri, { eval: status });
    }
  }

  private clearSuggestion() {
    this.suggestion = null;
    this.stage = 'none';
    vscode.commands.executeCommand('setContext', 'minoshiro.hasSuggestion', false);
    this.decoration?.dispose();
    this.rangeDecoration?.dispose();
    this.statusItem.hide();
  }
}
