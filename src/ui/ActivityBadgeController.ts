import * as vscode from 'vscode';

export class ActivityBadgeController {
  private webviewView?: vscode.WebviewView;
  private busy = false;
  constructor(private readonly defaultTitle = 'Settings') {}
  attach(view: vscode.WebviewView) {
    this.webviewView = view;
    this.apply();
  }
  setBusy(b: boolean) {
    this.busy = b;
    this.apply();
  }
  private apply() {
    if (!this.webviewView) return;
    const v = this.webviewView as any;
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

