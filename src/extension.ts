import * as vscode from 'vscode';
import { OllamaClient, OllamaError } from './ollama';
import { CompletionEngine } from './engine';
import { PawpleteProvider } from './provider';
import { StatusBar } from './statusBar';
import { readConfig, updateSetting, SECTION } from './config';
import { SettingsViewProvider } from './settingsView';

export interface PawpleteApi {
  provider: PawpleteProvider;
  engine: CompletionEngine;
  settingsView: SettingsViewProvider;
}

export function activate(context: vscode.ExtensionContext): PawpleteApi {
  let client = new OllamaClient({ host: readConfig().host });
  const status = new StatusBar();
  const reported = new Set<string>();

  const engine = new CompletionEngine({
    client: () => client,
    config: readConfig,
  });

  const reportError = (err: unknown): void => {
    const message = err instanceof Error ? err.message : String(err);
    status.setError(message);
    if (reported.has(message)) return;
    reported.add(message);
    const actions = ['Open Settings'];
    if (err instanceof OllamaError && /not found/i.test(message)) actions.unshift('Select Model');
    void vscode.window.showWarningMessage(`Pawplete: ${message}`, ...actions).then((choice) => {
      if (choice === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', SECTION);
      if (choice === 'Select Model') void vscode.commands.executeCommand('pawplete.selectModel');
    });
  };

  const provider = new PawpleteProvider(engine, status, reportError);
  const settingsView = new SettingsViewProvider(() => client.listModels(), reportError);

  const refreshStatus = (): void => {
    const cfg = readConfig();
    status.update({ model: cfg.model, enabled: cfg.enabled });
  };

  const warm = (): void => {
    const cfg = readConfig();
    if (!cfg.enabled) return;
    client.warm(cfg.model, cfg.keepAlive).then(
      () => status.setError(undefined),
      (err: unknown) => status.setError(err instanceof Error ? err.message : String(err)),
    );
  };

  context.subscriptions.push(
    status,
    vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider),
    vscode.window.registerWebviewViewProvider(SettingsViewProvider.viewType, settingsView),

    vscode.commands.registerCommand('pawplete.openSidebar', () =>
      vscode.commands.executeCommand('pawplete.settings.focus'),
    ),

    vscode.commands.registerCommand('pawplete.trigger', () =>
      vscode.commands.executeCommand('editor.action.inlineSuggest.trigger'),
    ),
    vscode.commands.registerCommand('pawplete.toggle', async () => {
      await updateSetting('enabled', !readConfig().enabled);
    }),
    vscode.commands.registerCommand('pawplete.acceptLine', () =>
      vscode.commands.executeCommand('editor.action.inlineSuggest.acceptNextLine'),
    ),
    vscode.commands.registerCommand('pawplete.selectModel', async () => {
      let models: string[];
      try {
        models = await client.listModels();
      } catch (err) {
        reportError(err);
        return;
      }
      const current = readConfig().model;
      const pick = await vscode.window.showQuickPick(
        models.map((m) => ({ label: m, description: m === current ? 'current' : undefined })),
        { placeHolder: 'Pawplete: choose an Ollama model' },
      );
      if (pick) await updateSetting('model', pick.label);
    }),

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(SECTION)) return;
      const cfg = readConfig();
      if (cfg.host !== client.host) client = new OllamaClient({ host: cfg.host });
      engine.clearCache();
      refreshStatus();
      settingsView.refresh();
      if (e.affectsConfiguration(`${SECTION}.model`) || e.affectsConfiguration(`${SECTION}.host`)) warm();
    }),
  );

  refreshStatus();
  warm();
  return { provider, engine, settingsView };
}

export function deactivate(): void {
  // Nothing to clean up beyond context.subscriptions.
}
