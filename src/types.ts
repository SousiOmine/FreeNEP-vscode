import * as vscode from 'vscode';

export type Suggestion = {
  uri: vscode.Uri;
  target: vscode.Position;
  range?: vscode.Range;
  insertText: string;
  preview: string;
  logUri?: vscode.Uri;
};

export type LogRecord = {
  events: string;
  input_context: string;
  output_context: any;
  eval: 'accepted' | 'rejected' | 'pending';
};

