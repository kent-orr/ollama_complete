import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { FIELDS, coerceValue, renderSettingsHtml } from './settingsPanel';
import { readConfig, updateSetting, SECTION } from './config';

type Incoming =
  | { type: 'set'; key: string; value: unknown }
  | { type: 'command'; command: string };

export class SettingsViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'pawplete.settings';
  private view: vscode.WebviewView | undefined;
  private models: string[] = [];

  constructor(
    private readonly listModels: () => Promise<string[]>,
    private readonly onError: (err: unknown) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [] };
    view.webview.html = renderSettingsHtml({
      values: readConfig() as unknown as Record<string, unknown>,
      models: this.models,
      nonce: randomBytes(16).toString('base64'),
      cspSource: view.webview.cspSource,
    });
    view.webview.onDidReceiveMessage((msg: Incoming) => void this.handle(msg));
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    void this.pushModels();
  }

  /** Push current settings into the form (called on configuration changes). */
  refresh(): void {
    void this.view?.webview.postMessage({ type: 'values', values: readConfig() });
  }

  private async pushModels(): Promise<void> {
    const cfg = readConfig();
    try {
      this.models = await this.listModels();
      this.setStatus('');
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err));
    }
    void this.view?.webview.postMessage({ type: 'models', models: this.models, current: cfg.model });
  }

  private setStatus(text: string): void {
    void this.view?.webview.postMessage({ type: 'status', text });
  }

  private async handle(msg: Incoming): Promise<void> {
    if (msg.type === 'set') {
      const field = FIELDS.find((f) => f.key === msg.key);
      if (!field) return;
      const value = coerceValue(field, msg.value);
      if (value === undefined) {
        this.refresh(); // revert the control to the stored value
        return;
      }
      await updateSetting(field.key, value);
      return;
    }
    switch (msg.command) {
      case 'trigger':
        await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        await vscode.commands.executeCommand('pawplete.trigger');
        return;
      case 'refreshModels':
        await this.pushModels();
        return;
      case 'reset': {
        const ok = await vscode.window.showWarningMessage(
          'Reset all Pawplete settings to their defaults?', { modal: true }, 'Reset',
        );
        if (ok !== 'Reset') return;
        for (const f of FIELDS) await updateSetting(f.key, undefined);
        this.refresh();
        return;
      }
      case 'openSettings':
        await vscode.commands.executeCommand('workbench.action.openSettings', SECTION);
        return;
      default:
        this.onError(new Error(`Unknown sidebar command: ${msg.command}`));
    }
  }
}
