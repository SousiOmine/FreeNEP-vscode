import * as vscode from 'vscode';
import { LogRecord } from '../types';

export class LoggerService {
  constructor(private readonly context: vscode.ExtensionContext) {}

  async prepareLog(initial: LogRecord): Promise<vscode.Uri> {
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
    return file;
  }

  async updateLog(uri: vscode.Uri, patch: Partial<LogRecord>) {
    try {
      const data = await vscode.workspace.fs.readFile(uri);
      const obj = JSON.parse(Buffer.from(data).toString('utf8')) as LogRecord;
      const next = { ...obj, ...patch } as LogRecord;
      await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(next, null, 2)));
    } catch (e) {
      console.error('Failed to update log', e);
    }
  }
}

