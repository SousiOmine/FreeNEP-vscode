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
  // Hover support state
  private lastHover?: vscode.MarkdownString;
  private statusItem: vscode.StatusBarItem;
  private currentAbort?: AbortController;
  private requestSeq = 0;
  private logger: LoggerService;
  private hoverAnchorRange?: vscode.Range;
  private hoverTimer?: NodeJS.Timeout;

  constructor(private readonly context: vscode.ExtensionContext, private readonly badge: ActivityBadgeController) {
    this.statusItem = vscode.window.createStatusBarItem('minoshiro', vscode.StatusBarAlignment.Right, 100);
    this.statusItem.name = 'NEP';
    this.statusItem.tooltip = 'Next Edit Prediction';
    this.logger = new LoggerService(context);

    // Provide hover content within the current suggestion range so that
    // 'editor.action.showHover' can open it and mouse hover also works.
    const provider = vscode.languages.registerHoverProvider(
      ['*', { scheme: 'file' }, { scheme: 'untitled' }],
      {
        provideHover: (doc, position) => {
          if (!this.suggestion || !this.hoverAnchorRange) return;
          if (doc.uri.toString() !== this.suggestion.uri.toString()) return;
          if (!this.hoverAnchorRange.contains(position)) return;
          if (!this.lastHover) return;
          return new vscode.Hover(this.lastHover);
        }
      }
    );
    context.subscriptions.push(provider);
  }

  dispose() {
    this.statusItem.dispose();
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

      // If the only difference between input and output is the cursor tag,
      // treat as no-op and do not propose an edit.
      const normalizeCursor = (s: string) => s.split(CURSOR_MARKER).join('');
      if (normalizeCursor(inputRegionContent) === normalizeCursor(outputRegionContent)) {
        setStatus('NEP: No actionable changes');
        return;
      }
      const primary = computePrimaryEdit(inputRegionContent, outputRegionContent);
      if (!primary) {
        setStatus('NEP: No differences');
        return;
      }

      // Map offsets from inputRegionContent (which includes CURSOR_MARKER) to document offsets
      const markerIndex = inputRegionContent.indexOf(CURSOR_MARKER);
      const adjust = (o: number) => (markerIndex >= 0 && o > markerIndex) ? o - CURSOR_MARKER.length : o;
      const startPos = doc.positionAt(adjust(primary.startOffset));
      const endPos = doc.positionAt(adjust(primary.endOffset));
      const target = startPos;
      const range = primary.startOffset === primary.endOffset ? undefined : new vscode.Range(startPos, endPos);
      const preview = primary.insertText.length > 40 ? primary.insertText.slice(0, 40) + '…' : primary.insertText;

      this.suggestion = { uri: doc.uri, target, range, insertText: primary.insertText, preview, logUri };
      await vscode.commands.executeCommand('setContext', 'minoshiro.hasSuggestion', true);
      this.stage = 'none';
      this.showHoverPreview(editor, range, primary.insertText, target);
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

  private showHoverPreview(
    editor: vscode.TextEditor,
    replaceRange: vscode.Range | undefined,
    newText: string,
    at: vscode.Position
  ) {
    const doc = editor.document;
    const oldText = replaceRange ? doc.getText(replaceRange) : '';
    this.lastHover = this.buildHoverMarkdown(doc.languageId, oldText, newText);

    // Define the region where the hover should be available
    if (replaceRange) {
      this.hoverAnchorRange = replaceRange;
    } else {
      const lineRange = doc.lineAt(at.line).range;
      this.hoverAnchorRange = new vscode.Range(lineRange.start, lineRange.end);
    }

    // Optionally auto-open hover preview
    const cfg = vscode.workspace.getConfiguration();
    const auto = cfg.get<boolean>('minoshiro.autoShowPreview') ?? true;
    const delay = cfg.get<number>('minoshiro.autoShowPreviewDelayMs') ?? 350;
    if (auto && this.hoverAnchorRange) {
      const originalSel = editor.selection;
      const pos = this.hoverAnchorRange.start;
      if (this.hoverTimer) { clearTimeout(this.hoverTimer); }
      this.hoverTimer = setTimeout(async () => {
        if (this.stage !== 'none') return; // user already interacting
        try {
          editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
          editor.selection = new vscode.Selection(pos, pos);
          await vscode.commands.executeCommand('editor.action.showHover');
        } finally {
          // Give the hover a short moment to stabilize before restoring selection
          setTimeout(() => { try { editor.selection = originalSel; } catch {} }, 250);
        }
      }, delay);
    }
  }

  async acceptOrJump() {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !this.suggestion) return;
    if (editor.document.uri.toString() !== this.suggestion.uri.toString()) return;

    if (this.stage === 'none') {
      if (this.hoverTimer) { clearTimeout(this.hoverTimer); this.hoverTimer = undefined; }
      const pos = this.suggestion.target;
      editor.selection = new vscode.Selection(pos, pos);
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      this.stage = 'jumped';
      this.statusItem.text = 'NEP: Tab to apply';
      this.statusItem.show();
      // Keep the preview hover visible after jumping
      await this.showHoverNow(editor, pos);
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
    this.hoverAnchorRange = undefined;
    this.lastHover = undefined;
    if (this.hoverTimer) { clearTimeout(this.hoverTimer); this.hoverTimer = undefined; }
    this.statusItem.hide();
  }

  private buildHoverMarkdown(languageId: string, oldText: string, newText: string): vscode.MarkdownString {
    const cfg = vscode.workspace.getConfiguration();
    const mode = (cfg.get<string>('minoshiro.previewHoverMode') || 'split').toLowerCase();

    const hover = new vscode.MarkdownString();
    hover.isTrusted = true; // enable command links

    if (mode === 'diff') {
      // Unified diff plus after block
      let diffBlock = '';
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const d = require('diff');
        const parts: Array<{ added?: boolean; removed?: boolean; value: string }> = d.diffLines(oldText, newText);
        const lines: string[] = [];
        for (const p of parts) {
          const raw = p.value.split(/\r?\n/);
          const content = raw[raw.length - 1] === '' ? raw.slice(0, -1) : raw;
          if (p.added) for (const l of content) lines.push(`+ ${l}`);
          else if (p.removed) for (const l of content) lines.push(`- ${l}`);
        }
        diffBlock = '```diff\n' + (lines.join('\n') || '+ (no visible changes)') + '\n```\n';
      } catch {
        diffBlock = '```diff\n+ ' + (newText.split(/\r?\n/)[0] || '(suggestion)') + '\n```\n';
      }
      hover.appendMarkdown('Changes:\n');
      hover.appendMarkdown(diffBlock);
      hover.appendMarkdown('\nAfter:\n');
      hover.appendCodeblock(newText || '(empty)', languageId || 'plaintext');
    } else {
      // Split Before/After blocks for clarity
      hover.appendMarkdown('Before:\n');
      hover.appendCodeblock(oldText || '(empty)', languageId || 'plaintext');
      hover.appendMarkdown('\nAfter:\n');
      hover.appendCodeblock(newText || '(empty)', languageId || 'plaintext');
    }

    const acceptCmd = `[Accept](command:minoshiro.acceptOrJump)`;
    const dismissCmd = `[Dismiss](command:minoshiro.dismiss)`;
    hover.appendMarkdown(`\n${acceptCmd} · ${dismissCmd}`);
    return hover;
  }

  private async showHoverNow(editor: vscode.TextEditor, pos: vscode.Position) {
    try {
      editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      editor.selection = new vscode.Selection(pos, pos);
      // slight delay improves reliability on some platforms
      await new Promise(r => setTimeout(r, 50));
      await vscode.commands.executeCommand('editor.action.showHover');
    } catch {}
  }
}
