import * as vscode from 'vscode';

export class StatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private busyCount = 0;
  private model = '';
  private enabled = true;
  private lastError: string | undefined;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'pawplete.toggle';
    this.item.name = 'Pawplete';
    this.item.show();
    this.render();
  }

  update(state: { model: string; enabled: boolean }): void {
    this.model = state.model;
    this.enabled = state.enabled;
    this.render();
  }

  setBusy(busy: boolean): void {
    this.busyCount = Math.max(0, this.busyCount + (busy ? 1 : -1));
    this.render();
  }

  setError(message: string | undefined): void {
    this.lastError = message;
    this.render();
  }

  private render(): void {
    if (!this.enabled) {
      this.item.text = '$(circle-slash) Pawplete';
      this.item.tooltip = 'Pawplete is off. Click to enable.';
      this.item.backgroundColor = undefined;
      return;
    }
    const icon = this.busyCount > 0 ? '$(loading~spin)' : this.lastError ? '$(warning)' : '$(sparkle)';
    this.item.text = `${icon} ${this.model}`;
    this.item.tooltip = this.lastError
      ? `Pawplete: ${this.lastError}`
      : `Pawplete: completions from ${this.model}. Click to disable.`;
    this.item.backgroundColor = this.lastError
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
  }

  dispose(): void {
    this.item.dispose();
  }
}
