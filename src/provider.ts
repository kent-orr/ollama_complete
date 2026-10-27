import * as vscode from 'vscode';
import type { CompletionEngine } from './engine';
import type { StatusBar } from './statusBar';
import { readConfig } from './config';
import type { Neighbor } from './snippets';
import { lookupDefinitions } from './definitionSource';

/** Documents larger than this are skipped as cross-file context. */
const MAX_NEIGHBOR_CHARS = 200_000;

function openNeighbors(current: vscode.TextDocument): Neighbor[] {
  return vscode.workspace.textDocuments
    .filter((d) => d !== current && (d.uri.scheme === 'file' || d.uri.scheme === 'untitled'))
    .map((d) => ({ path: vscode.workspace.asRelativePath(d.uri), text: d.getText() }))
    .filter((n) => n.text.length <= MAX_NEIGHBOR_CHARS);
}

export class PawpleteProvider implements vscode.InlineCompletionItemProvider {
  constructor(
    private readonly engine: CompletionEngine,
    private readonly status: StatusBar,
    private readonly onError: (err: unknown) => void,
  ) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const cfg = readConfig();
    if (!cfg.enabled) return undefined;

    const controller = new AbortController();
    const sub = token.onCancellationRequested(() => controller.abort());

    // Only hand the engine the window of lines it can use.
    const startLine = Math.max(0, position.line - cfg.contextLinesAbove);
    const endLine = Math.min(document.lineCount - 1, position.line + cfg.contextLinesBelow);
    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    const text = document.getText(range);

    this.status.setBusy(true);
    try {
      const completion = await this.engine.complete({
        text,
        position: { line: position.line - startLine, character: position.character },
        languageId: document.languageId,
        automatic: context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic,
        signal: controller.signal,
        filePath: vscode.workspace.asRelativePath(document.uri),
        neighbors: () => openNeighbors(document),
        definitions: (symbols) =>
          lookupDefinitions(document, symbols, { lineOffset: startLine, window: { start: startLine, end: endLine } }),
      });
      if (!completion || token.isCancellationRequested) return undefined;
      this.status.setError(undefined);
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return undefined;
      this.onError(err);
      return undefined;
    } finally {
      this.status.setBusy(false);
      sub.dispose();
    }
  }
}
